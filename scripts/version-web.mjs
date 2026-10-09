import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const normalize = (text) => text.replace(/\?v=[a-f0-9]{12}/g, '')
  .replace(/(<meta name="app-version" content=")[a-f0-9]{12}/, '$1VERSION')
  .replace(/(const VERSION = ")[a-f0-9]{12}/, '$1VERSION');
const html = await readFile(join(root, 'index.html'), 'utf8');
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const hash = createHash('sha256').update(normalize(html)).update(normalize(sw));
const assets = ['app.js', 'handout.js', 'bookings.js', 'handout-config.js', 'binder.js', 'binder-data.js', 'storage.js', 'gs1.js', 'receive.js', 'styles.css', 'catalog.json',
  'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'vendor/zxing-wasm/zxing-reader.iife.js', 'vendor/zxing-wasm/zxing_reader.wasm',
  ...(await readdir(join(root, 'binder-pages'))).sort().map(name => `binder-pages/${name}`),
  ...(await readdir(join(root, 'thumbs'))).sort().map(name => `thumbs/${name}`)];
for (const path of assets) hash.update(path).update(await readFile(join(root, path)));
const version = hash.digest('hex').slice(0, 12);
const nextHtml = normalize(html).replace('content="VERSION"', `content="${version}"`)
  .replace(/((?:src|href)="(?:[^"?#]+\.(?:js|css|png)|manifest\.webmanifest))"/g, `$1?v=${version}"`);
const nextSw = normalize(sw).replace('const VERSION = "VERSION"', `const VERSION = "${version}"`);
if (process.argv.includes('--check')) {
  if (html !== nextHtml || sw !== nextSw) throw new Error('Website release version is stale. Run npm run version:web and commit index.html and sw.js.');
} else {
  await writeFile(join(root, 'index.html'), nextHtml);
  await writeFile(join(root, 'sw.js'), nextSw);
}
console.log(`Website release ${version}${process.argv.includes('--check') ? ' verified' : ' stamped'}.`);
