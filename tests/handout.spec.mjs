import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandoutServer } from '../handout-server/server.mjs';
import { HandoutStore } from '../handout-server/store.mjs';
import { passwordHash } from '../handout-server/auth.mjs';
const salt=Buffer.alloc(16,2).toString('base64url');
const password='browser-test-password';
const hash=await passwordHash(password,salt);
const test=base.extend({
 service: async ({},use)=> {
  const directory=mkdtempSync(join(tmpdir(),'handout-browser-'));
  const store=new HandoutStore(directory);let time=Date.parse('2026-10-08T15:00:00Z');
  const env={HANDOUT_SESSION_SECRET:'browser-test-session-secret-at-least-32-characters',HANDOUT_ALLOWED_ORIGINS:'http://127.0.0.1:4173',HANDOUT_USERS_JSON:JSON.stringify([{id:'arthur',name:'Arthur',canEdit:true},{id:'sam',name:'Sam',canEdit:true},{id:'viewer',name:'Viewer',canEdit:false}].map(user=>({...user,salt,passwordHash:hash})))};
  const {server,publish}=createHandoutServer({env,store,now:()=>time});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await use({base:'http://127.0.0.1:'+server.address().port,store,roll(){time=Date.parse('2026-10-08T16:00:00Z');publish();}});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});
 }
});
async function signIn(page,service,username='arthur') {
 await page.route('**/handout-config.js*',route=>route.fulfill({contentType:'text/javascript',body:'window.BarRestockHandoutConfig='+JSON.stringify({apiBase:service.base})+';'}));
 await page.addInitScript(()=>sessionStorage.setItem('bar-restock-role-v1','bartender'));
 await page.goto('/#handout');await page.locator('#handoutUsername').fill(username);await page.locator('#handoutPassword').fill(password);await page.locator('#handoutLogin button').click();
 await expect(page.locator('#handoutConnection')).toHaveText('Live');
}
async function add(page,text) {
 await page.locator('#handoutText').fill(text);await page.locator('#handoutComposer button').click();await expect(page.locator('#handoutStatus')).toContainText('Saved');
}
test('two named users see shared notes and preserve a conflicting edit draft',async({page,context,service})=> {
 await signIn(page,service);const other=await context.newPage();await signIn(other,service,'sam');
 await add(page,'Tonic is low');await expect(other.locator('#handoutEntries')).toContainText('Tonic is low');
 await other.locator('[data-handout-edit]').click();await other.locator('#handoutEditText').fill('Sam’s unsaved version');
 await page.locator('[data-handout-edit]').click();await page.locator('#handoutEditText').fill('Arthur updated the tonic order');await page.locator('#handoutEditForm button[type=submit]').click();
 await expect(other.locator('#handoutEntries')).toContainText('Arthur updated');
 await expect(other.locator('#handoutEditText')).toHaveValue('Sam’s unsaved version');
 await other.locator('#handoutEditForm button[type=submit]').click();await expect(other.locator('#handoutStatus')).toContainText('This note changed');
 expect(service.store.get('2026-10-08').entries[0].text).toBe('Arthur updated the tonic order');
 await other.locator('#handoutEditAsNew').click();await expect(page.locator('#handoutEntries')).toContainText('Sam’s unsaved version');
});
test('2 am rollover preserves drafts and creates a downloadable historical handout',async({page,service})=> {
 await signIn(page,service);await add(page,'Closing update');await page.locator('#handoutText').fill('Draft for the next shift');service.roll();
 await expect(page.locator('#handoutDate')).toContainText('2026-10-09');await expect(page.locator('#handoutText')).toHaveValue('Draft for the next shift');
 await page.reload();await expect(page.locator('#handoutArchiveList')).toContainText('2026-10-08');await page.locator('[data-handout-archive]').click();
 await expect(page.locator('#handoutEntries')).toContainText('Closing update');await expect(page.locator('[data-handout-edit]')).toHaveCount(0);
 const download=page.waitForEvent('download');await page.locator('#handoutDownload').click();expect((await download).suggestedFilename()).toBe('handout-2026-10-08.md');
 await page.locator('#handoutBack').click();await expect(page.locator('#handoutDate')).toContainText('2026-10-09');
});
test('server failures keep the composer draft, and viewing accounts cannot edit',async({page,context,service})=> {
 await signIn(page,service);await page.route('**/api/entries',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Server unavailable"}'}));
 await page.locator('#handoutText').fill('Do not lose this draft');await page.locator('#handoutComposer button').click();await expect(page.locator('#handoutStatus')).toContainText('draft is kept');await expect(page.locator('#handoutText')).toHaveValue('Do not lose this draft');
 const viewer=await context.newPage();await signIn(viewer,service,'viewer');await expect(viewer.locator('#handoutComposer')).toBeHidden();
});
test('an unconnected venue shows Handout without claiming shared saves',async({page})=> {
 await page.route('**/handout-config.js*',route=>route.fulfill({contentType:'text/javascript',body:'window.BarRestockHandoutConfig={apiBase:""};'}));
 await page.addInitScript(()=>sessionStorage.setItem('bar-restock-role-v1','admin'));await page.goto('/#handout');await expect(page.locator('#handoutUnavailable')).toBeVisible();await expect(page.locator('#handoutComposer')).toBeHidden();await expect(page.locator('#handoutLogin')).toBeHidden();
});
