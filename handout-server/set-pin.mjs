import { readFileSync, existsSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { passwordHash } from './auth.mjs';
const [file,id,role='bartender',name]=process.argv.slice(2);
if (!file || !id || !['admin','bartender'].includes(role)) throw new Error('Usage: set-pin.mjs USERS_FILE account-id [admin|bartender] [Display name], with PIN on stdin');
const pin=readFileSync(0,'utf8');
if (!/^[0-9]{6,12}$/.test(pin)) throw new Error('Use a personal PIN of 6–12 digits');
const accounts=existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : [];
for (const user of accounts) {
  if (user.id!==id && user.pinHash && await passwordHash(pin,user.pinSalt)===user.pinHash) throw new Error('That PIN is already assigned. Choose a different PIN.');
}
let account=accounts.find(user=>user.id===id);
if (!account) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id) || !name?.trim() || name.length>80) throw new Error('For a new person, supply an account ID and display name');
  account={id,name:name.trim(),canEdit:true};accounts.push(account);
}
account.pinSalt=randomBytes(16).toString('base64url');
account.pinHash=await passwordHash(pin,account.pinSalt);account.role=role;
// Removing password access completes migration for this person.
delete account.salt;delete account.passwordHash;
writeFileSync(file+'.tmp',JSON.stringify(accounts,null,2)+'\n',{mode:0o600});chmodSync(file+'.tmp',0o600);renameSync(file+'.tmp',file);
console.log('Personal PIN configured for '+account.name+' ('+role+').');
