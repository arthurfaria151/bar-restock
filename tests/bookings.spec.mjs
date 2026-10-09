import {test as base,expect} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHandoutServer} from '../handout-server/server.mjs';
import {HandoutStore} from '../handout-server/store.mjs';
import {passwordHash} from '../handout-server/auth.mjs';
const pins={admin:'314159',manager:'271828',bartender:'161803',viewer:'141421'},salt=Buffer.alloc(16,3).toString('base64url');
const accounts=await Promise.all(Object.entries(pins).map(async([role,pin])=>({id:role,name:role==='admin'?'Arthur':role==='manager'?'Alex':role==='bartender'?'Sam':'Viewer',role:role==='viewer'?'bartender':role,canEdit:role!=='viewer',pinSalt:salt,pinHash:await passwordHash(pin,salt)})));
const test=base.extend({service:async({},use)=>{
 const directory=mkdtempSync(join(tmpdir(),'bookings-browser-'));const store=new HandoutStore(directory);let now=Date.parse('2026-10-09T01:00:00Z');
 const {server,publish}=createHandoutServer({store,now:()=>now,env:{HANDOUT_SESSION_SECRET:'bookings-test-secret-with-32-characters',HANDOUT_USERS_JSON:JSON.stringify(accounts),HANDOUT_ALLOWED_ORIGINS:'http://127.0.0.1:4173'}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await use({base:'http://127.0.0.1:'+server.address().port,store,clock(value){now=Date.parse(value);publish();}});
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});
}});
async function login(page,service,role){
 await page.route('**/handout-config.js*',route=>route.fulfill({contentType:'text/javascript',body:'window.BarRestockHandoutConfig='+JSON.stringify({apiBase:service.base})+';'}));
 await page.goto('/#bookings');await page.locator('#loginPin').fill(pins[role]);await page.locator('#loginForm button[type=submit]').click();
 await expect(page.locator('#panel-bookings')).toBeVisible();await expect(page.locator('#bookingConnection')).toContainText('Shared');
}
async function fill(page,night=false){
 await page.locator('#bookingNew').click();await page.locator('#bookingName').fill('Birthday group');await page.locator('#bookingStart').fill(night?'2026-10-09T22:00':'2026-10-09T14:00');await page.locator('#bookingEnd').fill(night?'2026-10-10T03:00':'2026-10-09T17:00');
 await page.locator('#bookingGuests').fill('12');await page.locator('#bookingTables').fill('3');await page.locator('#bookingArea').fill('Terrace');await page.locator('#bookingPoolTables').fill('1');await page.locator('#bookingTab').check();await page.locator('#bookingTabValue').fill('250');await page.locator('#bookingDrinks').fill('Beer and cocktails');await page.locator('#bookingCustomTasks').fill('Set up decorations');
}
async function tab(page,name){const button=page.locator('[data-tab='+name+']');if(!await button.isVisible())await page.locator('#menuToggle').click();await button.click();}
test('bartender requests, manager approval, shared preparation tasks and present/past/future views',async({page,context,service})=>{
 await login(page,service,'bartender');await fill(page);await page.locator('#bookingSubmit').click();await expect(page.locator('#bookingStatus')).toContainText('waiting for manager');
 await page.locator('[data-booking-filter=requests]').click();await expect(page.locator('#bookingList')).toContainText('Birthday group');await expect(page.locator('[data-booking-action=approve]')).toHaveCount(0);
 const manager=await context.newPage();await login(manager,service,'manager');await expect(manager.locator('#roleLabel')).toHaveText('Alex · Manager');await manager.locator('[data-booking-filter=requests]').click();await manager.locator('[data-booking-action=approve]').click();
 await manager.locator('[data-booking-filter=future]').click();await expect(manager.locator('#bookingList')).toContainText('Approved');
 await page.locator('#bookingRefresh').click();await page.locator('[data-booking-filter=future]').click();await expect(page.locator('#bookingList')).toContainText('Put booking signs on 3');
 await tab(manager,'handout');await expect(manager.locator('#handoutBookings')).toContainText('Birthday group');await expect(manager.locator('#handoutBookings')).toContainText('$250.00');
 await page.locator('[data-booking-task=signs]').selectOption('progress');await expect(manager.locator('#handoutBookings [data-booking-task=signs]')).toHaveValue('progress');
 service.clock('2026-10-09T04:30:00Z');await page.locator('#bookingRefresh').click();await page.locator('[data-booking-filter=present]').click();await expect(page.locator('#bookingList')).toContainText('Birthday group');
 service.clock('2026-10-09T07:00:00Z');await page.locator('#bookingRefresh').click();await page.locator('[data-booking-filter=past]').click();await expect(page.locator('#bookingList')).toContainText('Birthday group');await expect(page.locator('#bookingList [data-booking-task]')).toHaveCount(0);
});
test('overnight booking appears across business days and archived tasks stay immutable',async({page,service})=>{
 service.clock('2026-10-09T15:00:00Z');await login(page,service,'admin');await fill(page,true);await page.locator('#bookingSubmit').click();await expect(page.locator('#bookingStatus')).toContainText('saved');
 await tab(page,'handout');await expect(page.locator('#handoutBookings')).toContainText('Birthday group');
 service.clock('2026-10-09T16:00:00Z');await expect(page.locator('#handoutDate')).toContainText('2026-10-10');
 await expect(page.locator('#handoutBookings')).toContainText('Birthday group');await page.locator('#handoutBookings [data-booking-task=signs]').selectOption('done');await expect(page.locator('#handoutBookings [data-booking-task=signs]')).toHaveValue('done');
 await page.locator('[data-handout-archive="2026-10-09"]').click();await expect(page.locator('#handoutBookings')).toContainText('Birthday group');await expect(page.locator('#handoutBookings [data-booking-task]')).toHaveCount(0);
 expect(service.store.get('2026-10-09').bookings[0].tasks.find(t=>t.id==='signs').status).toBe('todo');expect(service.store.archive('2026-10-09')).toContain('booking signs');
});
test('lost save responses keep the request draft and retries create only one booking',async({page,service})=>{
 await login(page,service,'bartender');await fill(page);
 let first=true;await page.route('**/api/bookings',async route=>{if(route.request().method()==='POST' && first){first=false;await route.fetch();await route.abort('failed');}else await route.continue();});
 await page.locator('#bookingSubmit').click();await expect(page.locator('#bookingStatus')).toContainText('draft is kept');await expect(page.locator('#bookingName')).toHaveValue('Birthday group');
 await page.locator('#bookingSubmit').click();await expect(page.locator('#bookingStatus')).toContainText('waiting for manager');expect(service.store.bookings()).toHaveLength(1);
});
test('booking form and task cards fit phone widths, and viewers cannot request bookings',async({page,context,service})=>{
 await login(page,service,'admin');await fill(page);
 for(const width of [320,390,768,1024]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.locator('#bookingSubmit').click();await expect(page.locator('#bookingList')).toContainText('Birthday group');
 const viewer=await context.newPage();await login(viewer,service,'viewer');await expect(viewer.locator('#bookingNew')).toBeDisabled();await expect(viewer.locator('[data-booking-task]')).toHaveCount(0);
});
