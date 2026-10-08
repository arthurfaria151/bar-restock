import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passwordHash, login, authenticate } from '../handout-server/auth.mjs';
import { businessDate, nextClose, applyEntry } from '../handout-server/day.mjs';
import { HandoutStore } from '../handout-server/store.mjs';
import { createHandoutServer } from '../handout-server/server.mjs';

const actor={id:'arthur',name:'Arthur',canEdit:true};
const other={id:'sam',name:'Sam',canEdit:true};
const id='11111111-1111-4111-8111-111111111111';
const day={date:'2026-10-08',revision:0,entries:[]};
const at=Date.parse('2026-10-08T15:59:59.999Z');
const salt=Buffer.alloc(16,1).toString('base64url');
const env={HANDOUT_SESSION_SECRET:'test-only-secret-with-more-than-32-characters',HANDOUT_ALLOWED_ORIGINS:'https://topd.guarasolutions.com'};
env.HANDOUT_USERS_JSON=JSON.stringify([actor,other,{id:'viewer',name:'Viewer',canEdit:false}].map(user=>({...user,salt,passwordHash:''})));
const accounts=JSON.parse(env.HANDOUT_USERS_JSON);for(const user of accounts)user.passwordHash=await passwordHash('test-password',salt);env.HANDOUT_USERS_JSON=JSON.stringify(accounts);

test('Brisbane 2 am closes the previous business day exactly, independent of server timezone',()=> {
 assert.equal(businessDate(at),'2026-10-08');
 assert.equal(businessDate(at+1),'2026-10-09');
 assert.equal(nextClose(at),at+1);
 assert.equal(nextClose(at+1),at+1+86400000);
 assert.equal(businessDate(Date.parse('2026-12-31T16:00:00Z')),'2027-01-01');
});
test('simultaneous edits to different notes merge; stale edits cannot replace a newer note',()=> {
 const first=applyEntry(day,{type:'add'},{date:day.date,text:'Opening'},actor,at,id).day;
 const second=applyEntry(first,{type:'add'},{date:day.date,text:'Closing'},other,at,'22222222-2222-4222-8222-222222222222').day;
 const update=applyEntry(second,{type:'edit',id},{date:day.date,version:1,text:'Updated opening'},other,at).day;
 assert.equal(update.entries.length,2);assert.equal(update.entries[0].authorName,'Arthur');assert.equal(update.entries[0].updatedByName,'Sam');
 assert.equal(applyEntry(update,{type:'edit',id},{date:day.date,version:1,text:'Stale'},actor,at).error,'NOTE_CHANGED');
 assert.equal(applyEntry(update,{type:'delete',id},{date:'2026-10-07',version:2},actor,at).error,'DAY_CLOSED');
});
test('sessions reject wrong passwords, tampered signatures, deleted users and expiry',async()=> {
 assert.equal(await login(env,{username:'arthur',password:'wrong'},at),null);
 assert.equal(await login(env,{username:'missing',password:'test-password'},at),null);
 const result=await login(env,{username:'arthur',password:'test-password'},at);
 assert.equal((await authenticate(env,'Bearer '+result.token,at)).name,'Arthur');
 assert.equal(await authenticate(env,'Bearer '+result.token+'x',at),null);
 assert.equal(await authenticate(env,'Bearer '+result.token,at+12*3600000),null);
 assert.equal(await authenticate({...env,HANDOUT_USERS_JSON:'[]'},'Bearer '+result.token,at),null);
});
test('daily archive is durable and immutable, catches up missed days and replays save identifiers once',()=> {
 const directory=mkdtempSync(join(tmpdir(),'handout-store-'));let store=new HandoutStore(directory);
 try {
  const body={date:day.date,text:'Restock tonic',mutationId:id};
  store.mutate({type:'add'},body,actor,at);store.mutate({type:'add'},body,actor,at);
  assert.equal(store.get(day.date).entries.length,1);
  store.ensureDay(at+1);
  const content=store.archive(day.date);
  assert.match(content,/Restock tonic/);assert.match(content,/02:00 \(Australia\/Brisbane\)/);
  assert.equal(readFileSync(join(directory,'archives','handout-2026-10-08.md'),'utf8'),content);
  assert.equal(store.mutate({type:'edit',id:store.get(day.date).entries[0].id},{date:day.date,text:'Too late',version:1,mutationId:crypto.randomUUID()},actor,at+1).error,'DAY_CLOSED');
  store.ensureDay(at+1+3*86400000);assert.equal(store.archives().length,4);
  store.close();store=new HandoutStore(directory);assert.equal(store.archive(day.date),content);
 } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
test('real HTTP API streams live edits to both users and provides archived files',async()=> {
 const directory=mkdtempSync(join(tmpdir(),'handout-http-'));const store=new HandoutStore(directory);let clock=at;
 const {server,publish}=createHandoutServer({env,store,now:()=>clock});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;const aborts=[];
 try {
  const signIn=async username=>(await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({username,password:'test-password'})})).json();
  const a=await signIn('arthur'),b=await signIn('sam'),viewer=await signIn('viewer');
  const header=token=>({Authorization:'Bearer '+token,'Content-Type':'application/json'});
  assert.equal((await fetch(base+'/api/handout')).status,401);
  assert.equal((await fetch(base+'/api/handout',{headers:{...header(a.token),Origin:'https://wrong.example'}})).status,403);
  const streams=[];
  for(const account of [a,b]) {
   const abort=new AbortController();aborts.push(abort);const res=await fetch(base+'/api/events',{headers:header(account.token),signal:abort.signal});
   const reader=res.body.getReader();await reader.read();streams.push(reader);
  }
  const response=await fetch(base+'/api/entries',{method:'POST',headers:header(a.token),body:JSON.stringify({date:day.date,text:'Shared update',mutationId:id})});assert.equal(response.status,200);
  for(const reader of streams) { let data=''; while(!data.includes('Shared update')) data+=new TextDecoder().decode((await reader.read()).value); assert.match(data,/Shared update/); }
  assert.equal((await fetch(base+'/api/entries',{method:'POST',headers:header(viewer.token),body:JSON.stringify({date:day.date,text:'Blocked',mutationId:crypto.randomUUID()})})).status,403);
  clock=at+1;publish();
  const file=await fetch(base+'/api/archives/2026-10-08.md',{headers:header(b.token)});assert.equal(file.status,200);assert.match(file.headers.get('content-disposition'),/handout-2026-10-08.md/);assert.match(await file.text(),/Shared update/);
 } finally {for(const abort of aborts)abort.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});}
});

test('personal PINs identify users, return server roles, and changing a PIN revokes old sessions',async()=> {
 const pinAccounts=[{id:'arthur',name:'Arthur',role:'admin',pinSalt:salt,pinHash:await passwordHash('314159',salt)},{id:'sam',name:'Sam',role:'bartender',pinSalt:salt,pinHash:await passwordHash('271828',salt)}];
 const pinEnv={...env,HANDOUT_USERS_JSON:JSON.stringify(pinAccounts)};
 assert.equal(await login(pinEnv,{pin:'1001'},at),null);
 assert.equal(await login(pinEnv,{pin:'999999'},at),null);
 const arthur=await login(pinEnv,{pin:'314159'},at);assert.equal(arthur.user.role,'admin');assert.equal(arthur.user.name,'Arthur');
 const sam=await login(pinEnv,{pin:'271828'},at);assert.equal(sam.user.role,'bartender');assert.equal(sam.user.name,'Sam');
 assert.equal((await authenticate(pinEnv,'Bearer '+arthur.token,at)).role,'admin');
 pinAccounts[0].pinHash=await passwordHash('161803',salt);
 assert.equal(await authenticate({...pinEnv,HANDOUT_USERS_JSON:JSON.stringify(pinAccounts)},'Bearer '+arthur.token,at),null);
});
