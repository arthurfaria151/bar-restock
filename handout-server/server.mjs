import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandoutStore } from './store.mjs';
import { login, authenticate } from './auth.mjs';
import { cutoffMinutes, nextClose, TIME_ZONE } from './day.mjs';
const MAX_BODY = 40000;
export function createHandoutServer(options = {}) {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const cutoff = cutoffMinutes(env.HANDOUT_CLOSE_HOUR ?? 2, env.HANDOUT_CLOSE_MINUTE ?? 0);
  const store = options.store || new HandoutStore(env.HANDOUT_DATA_DIR || './handout-data',cutoff);
  const allowed = new Set((env.HANDOUT_ALLOWED_ORIGINS || 'https://topd.guarasolutions.com,capacitor://localhost').split(',').map(x=>x.trim()));
  const clients = new Set(); const attempts = new Map();
  let timer;
  const snapshot = (user) => { const {day,rolled}=store.ensureDay(now()); if(rolled) queueMicrotask(publish); return {...day,user,timeZone:TIME_ZONE,closeHour:Math.floor(cutoff/60),closeMinute:cutoff%60,nextClose:new Date(nextClose(now(),cutoff)).toISOString()}; };
  function publish() {
    for (const client of clients) {
      if (client.user.expiresAt <= now()) { client.response.end(); clients.delete(client); continue; }
      client.response.write(`event: handout\ndata: ${JSON.stringify(snapshot(client.user))}\n\n`);
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { store.ensureDay(now()); publish(); } catch(error) { console.error('Handout rollover failed:',error.message); }
      schedule();
    },Math.max(100,Math.min(nextClose(now(),cutoff)-now()+20,2147483647)));
    timer.unref();
  }
  store.ensureDay(now()); schedule();
  const heartbeat = setInterval(() => {
    try {
      if (store.ensureDay(now()).rolled) publish();
      for (const client of clients) {
        if (client.user.expiresAt <= now()) { client.response.end(); clients.delete(client); }
        else client.response.write(': heartbeat\n\n');
      }
    } catch(error) { console.error('Handout maintenance failed:',error.message); }
  },15000); heartbeat.unref();
  const server = createServer(async (req,res) => {
    const origin = req.headers.origin;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Vary','Origin');
    if (origin && !allowed.has(origin)) { res.writeHead(403); res.end(); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers','Content-Disposition');
    if (req.method==='OPTIONS') { res.writeHead(204);res.end();return; }
    const json = (status,value) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    let url;
    try {
      url = new URL(req.url,'http://localhost');
      if (url.pathname==='/health' && req.method==='GET') { json(200,{ok:true});return; }
      let body = {};
      if (['POST','PUT','DELETE'].includes(req.method)) {
        let size=0;const chunks=[];
        for await (const chunk of req) {size+=chunk.length;if(size>MAX_BODY){json(413,{error:'Request too large'});return;}chunks.push(chunk);}
        try {body=JSON.parse(Buffer.concat(chunks).toString());} catch {json(400,{error:'Invalid JSON'});return;}
        if (!body || typeof body!=='object' || Array.isArray(body)) {json(400,{error:'Invalid request'});return;}
      }
      if (url.pathname==='/api/login' && req.method==='POST') {
        // The listener is loopback-only behind the HTTPS proxy; forwarded IP is trusted only there.
        const ip = (env.HANDOUT_TRUST_PROXY==='1' && req.headers['x-real-ip']) || req.socket.remoteAddress;
        const bucket = attempts.get(ip) || {at:now(),count:0};
        if (now()-bucket.at > 15*60000) {bucket.at=now();bucket.count=0;}
        if (++bucket.count>20) {json(429,{error:'Too many sign-in attempts. Try again in 15 minutes.'});return;}
        attempts.set(ip,bucket);
        if(attempts.size>10000) for(const [key,value] of attempts) if(now()-value.at>15*60000) attempts.delete(key);
        const result = await login(env,body,now());
        if (result) attempts.delete(ip);
        json(result?200:401,result || {error:'Incorrect sign-in details'});return;
      }
      const user = await authenticate(env,req.headers.authorization,now());
      if (!user) {json(401,{error:'Please sign in with your PIN'});return;}
      if (url.pathname==='/api/session' && req.method==='GET') {json(200,{user});return;}
      const current = snapshot(user);
      if (url.pathname==='/api/handout' && req.method==='GET') {json(200,current);return;}
      if (url.pathname==='/api/events' && req.method==='GET') {
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write(`event: handout\ndata: ${JSON.stringify(current)}\n\n`);
        const client={response:res,user};clients.add(client);
        res.on('close',()=>clients.delete(client));return;
      }
      if (url.pathname==='/api/archives' && req.method==='GET') {json(200,{archives:store.archives(url.searchParams.get('before') || undefined)});return;}
      const archive = url.pathname.match(/^\/api\/archives\/(\d{4}-\d{2}-\d{2})(\.md)?$/);
      if (archive && req.method==='GET') {
        const content=store.archive(archive[1]);
        if(!content){json(404,{error:'Archive not found'});return;}
        if(archive[2]) {res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="handout-${archive[1]}.md"`});res.end(content);}
        else json(200,{day:store.get(archive[1]),fileName:`handout-${archive[1]}.md`});return;
      }
      const entry = url.pathname.match(/^\/api\/entries\/([a-f0-9-]{36})$/);
      const type = url.pathname==='/api/entries' && req.method==='POST' ? 'add' : entry && req.method==='PUT' ? 'edit' : entry && req.method==='DELETE' ? 'delete' : null;
      if(type) {
        if(!user.canEdit){json(403,{error:'This account has viewing access'});return;}
        const result = store.mutate({type,id:entry?.[1]},body,user,now());
        if(result.error){json(result.status,{error:result.error,handout:snapshot(user)});return;}
        publish();json(200,{handout:snapshot(user)});return;
      }
      json(404,{error:'Not found'});
    } catch(error) {console.error('Handout request failed:',error.message);if(!res.headersSent)json(500,{error:'The handout could not be saved. Your draft is kept.'});else res.end();}
  });
  server.on('close',()=>{clearTimeout(timer);clearInterval(heartbeat);for(const c of clients)c.response.end();clients.clear();if(!options.store)store.close();});
  return {server,store,publish};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const env = {...process.env};
  if(env.HANDOUT_USERS_FILE) env.HANDOUT_USERS_JSON=readFileSync(env.HANDOUT_USERS_FILE,'utf8');
  if(!env.HANDOUT_USERS_JSON || !env.HANDOUT_SESSION_SECRET || env.HANDOUT_SESSION_SECRET.length<32) throw new Error('Set Handout users and session secret before starting');
  createHandoutServer({env}).server.listen(Number(env.HANDOUT_PORT || 8787),'127.0.0.1',()=>console.log('Handout listening on 127.0.0.1:'+ (env.HANDOUT_PORT || 8787)));
}
