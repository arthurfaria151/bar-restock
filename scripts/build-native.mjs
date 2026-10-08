import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'www');
const assets = [
  'app.js', 'binder.js', 'binder-data.js', 'binder-pages', 'storage.js', 'gs1.js', 'receive.js', 'styles.css', 'catalog.json', 'manifest.webmanifest',
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'thumbs', 'vendor/zxing-wasm',
];

// Stage only runtime assets; never bundle source control, dependencies or docs.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) {
  await cp(join(root, asset), join(output, asset), { recursive: true });
}
let html = (await readFile(join(root, 'index.html'), 'utf8')).replace(/\?v=[a-f0-9]{12}/g, '');
const appScript = '<script src="app.js"></script>';
if (!html.includes(appScript)) {
  throw new Error('Cannot locate app.js script in index.html');
}
html = html.replace(appScript, '<script src="native-bridge.js"></script>\n  ' + appScript);
await writeFile(join(output, 'index.html'), html);
await build({
  entryPoints: [join(root, 'native/bridge.js')],
  outfile: join(output, 'native-bridge.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari15',
  legalComments: 'eof',
});
console.log('Built bundled iPad app assets in www/ (no remote server required).');
