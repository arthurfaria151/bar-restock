import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {changeBooking,bookingsForDay} from '../handout-server/bookings.mjs';
import {HandoutStore} from '../handout-server/store.mjs';
const at=Date.parse('2026-10-08T09:00:00Z');
const bartender={id:'sam',name:'Sam',role:'bartender',canEdit:true},admin={id:'arthur',name:'Arthur',role:'admin',canEdit:true},manager={id:'alex',name:'Alex',role:'manager',canEdit:true};
const body={name:'Birthday',contact:'Customer contact',start:'2026-10-08T20:00',end:'2026-10-09T01:30',guests:12,tables:3,area:'Terrace',poolTables:2,tab:true,tabCents:25000,drinks:'Beer and cocktails',requests:'Cake space',customTasks:'Set up decorations'};
test('bartender requests require approval; managers approve; server ignores forged status and role',()=> {
 const pending=changeBooking(null,'create',{...body,status:'approved',role:'admin'},bartender,at).booking;
 assert.equal(pending.status,'pending');assert.equal(pending.requestedBy.name,'Sam');
 assert.equal(changeBooking(pending,'approve',{version:1},bartender,at).status,403);
 const approved=changeBooking(pending,'approve',{version:1},manager,at).booking;assert.equal(approved.status,'approved');assert.equal(approved.reviewedBy.name,'Alex');
 assert.ok(approved.tasks.some(t=>t.text.includes('booking signs on 3')));assert.ok(approved.tasks.some(t=>t.text.includes('$250.00')));
 assert.equal(changeBooking(approved,'edit',{...body,version:2},bartender,at).status,403);
 assert.equal(changeBooking(null,'create',body,{...admin,canEdit:false},at).status,403);
});
test('validation rejects impossible dates, reversed ranges, negative values, stale edits and past changes',()=> {
 for(const patch of [{start:'2026-02-30T20:00'},{end:body.start},{tables:-1},{tabCents:NaN}]) assert.ok(changeBooking(null,'create',{...body,...patch},admin,at).error);
 const booking=changeBooking(null,'create',body,admin,at).booking;
 assert.equal(changeBooking(booking,'edit',{...body,version:0},admin,at).status,409);
 assert.equal(changeBooking(booking,'cancel',{version:1},admin,Date.parse('2026-10-09T02:00+10:00')).status,409);
});
test('task edits merge independently; stale same-task updates fail; changed requirements reset affected tasks',()=> {
 let booking=changeBooking(null,'create',body,admin,at).booking;
 const first=booking.tasks[0],second=booking.tasks[1];
 booking=changeBooking(booking,'task',{taskId:first.id,taskVersion:1,taskStatus:'done'},bartender,at).booking;
 booking=changeBooking(booking,'task',{taskId:second.id,taskVersion:1,taskStatus:'progress'},manager,at).booking;
 assert.equal(booking.tasks[0].status,'done');assert.equal(booking.tasks[1].status,'progress');
 assert.equal(changeBooking(booking,'task',{taskId:first.id,taskVersion:1,taskStatus:'todo'},bartender,at).status,409);
 const signs=booking.tasks.find(t=>t.id==='signs');booking=changeBooking(booking,'task',{taskId:'signs',taskVersion:signs.version,taskStatus:'done'},bartender,at).booking;
 booking=changeBooking(booking,'edit',{...body,tables:4,version:booking.version},admin,at).booking;
 assert.equal(booking.tasks.find(t=>t.id==='signs').status,'todo');assert.equal(booking.tasks[0].status,'done');
});
test('bookings overlap Brisbane business days exactly, including overnight and 2 am boundary',()=> {
 const booking=changeBooking(null,'create',body,admin,at).booking;
 assert.equal(bookingsForDay([booking],'2026-10-08').length,1);assert.equal(bookingsForDay([booking],'2026-10-09').length,0);
 booking.endAt='2026-10-08T17:00:00Z';assert.equal(bookingsForDay([booking],'2026-10-09').length,1);
 booking.startAt='2026-10-08T16:00:00Z';assert.equal(bookingsForDay([booking],'2026-10-08').length,0);
 booking.status='pending';assert.equal(bookingsForDay([booking],'2026-10-09').length,0);
});
test('SQLite booking saves are idempotent, durable, and frozen into the closed Handout archive',()=> {
 const dir=mkdtempSync(join(tmpdir(),'bookings-'));let store=new HandoutStore(dir);
 try {
  const request={...body,mutationId:crypto.randomUUID()};const result=store.saveBooking(null,'create',request,bartender,at);store.saveBooking(null,'create',request,bartender,at);
  assert.equal(store.bookings().length,1);assert.equal(store.ensureDay(at).day.bookings.length,0);
  store.saveBooking(result.booking.id,'approve',{version:1,mutationId:crypto.randomUUID()},admin,at);
  assert.equal(store.ensureDay(at).day.bookings.length,1);
  store.ensureDay(Date.parse('2026-10-08T16:00:00Z'));const archived=store.archive('2026-10-08');assert.match(archived,/Birthday/);assert.match(archived,/\$250.00/);assert.match(archived,/booking signs/);
  const frozen=JSON.stringify(store.get('2026-10-08').bookings);store.close();store=new HandoutStore(dir);
  assert.equal(store.bookings().length,1);assert.equal(store.archive('2026-10-08'),archived);assert.equal(JSON.stringify(store.get('2026-10-08').bookings),frozen);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
