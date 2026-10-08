const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const decode = value => Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  return encode(await crypto.subtle.deriveBits({ name:'PBKDF2',salt:decode(salt),iterations:100000,hash:'SHA-256' },key,256));
}
export function users(env) {
  const values = JSON.parse(env.HANDOUT_USERS_JSON || '[]');
  return Array.isArray(values) ? values.filter(u => typeof u.id==='string' && typeof u.name==='string' && typeof u.salt==='string' && typeof u.passwordHash==='string') : [];
}
async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Handout session secret is missing');
  return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function login(env, body, now = Date.now()) {
  if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 256) return null;
  const account = users(env).find(u => u.id === body.username.trim().toLowerCase());
  // Always derive a password hash, including unknown usernames.
  const hash = await passwordHash(body.password, account?.salt || 'AAAAAAAAAAAAAAAAAAAAAA');
  const expected = account?.passwordHash || '0'.repeat(hash.length);
  let difference = hash.length ^ expected.length;
  for (let i=0;i<hash.length;i++) difference |= hash.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  if (!account || difference) return null;
  const payload = encode(new TextEncoder().encode(JSON.stringify({ sub:account.id, exp:now+12*3600000 })));
  const signature = encode(await crypto.subtle.sign('HMAC',await signingKey(env.HANDOUT_SESSION_SECRET),new TextEncoder().encode(payload)));
  return { token:`${payload}.${signature}`, user:{id:account.id,name:account.name,canEdit:account.canEdit !== false} };
}
export async function authenticate(env, header, now = Date.now()) {
  try {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const [payload,signature,extra] = token.split('.');
    if (!payload || !signature || extra || token.length > 2000) return null;
    if (!await crypto.subtle.verify('HMAC',await signingKey(env.HANDOUT_SESSION_SECRET),decode(signature),new TextEncoder().encode(payload))) return null;
    const session = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!Number.isFinite(session.exp) || session.exp <= now) return null;
    const user = users(env).find(u => u.id===session.sub);
    return user ? {id:user.id,name:user.name,canEdit:user.canEdit !== false,expiresAt:session.exp} : null;
  } catch { return null; }
}
