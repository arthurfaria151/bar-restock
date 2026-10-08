import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
assert.equal(config.webDir, 'www');
assert.ok(!config.server?.url, 'Native app must load bundled assets, not a remote server');
const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
assert.ok(catalog.length > 0, 'Product catalog must not be empty');
assert.equal(new Set(catalog.map(p => p.id)).size, catalog.length, 'Duplicate product IDs');
const publicDirs = ['www', 'ios/App/App/public'];
const decoderDigests = {
  'vendor/zxing-wasm/zxing-reader.iife.js': '228e6d8ccb841c544386eeafd5f18294d3e4aa0e7aa20419bc51a0009b9d3c17',
  'vendor/zxing-wasm/zxing_reader.wasm': 'aecc1876de036c62c8419f67a5e1a16b1698a325bcd190aa84810d516e263931',
};
for (const [asset, expected] of Object.entries(decoderDigests)) {
  assert.equal(createHash('sha256').update(await readFile(join(root, asset))).digest('hex'), expected, `Barcode decoder integrity: ${asset}`);
}
for (const directory of publicDirs) {
  const path = join(root, directory);
  const html = await readFile(join(path, 'index.html'), 'utf8');
  assert.ok(html.includes('<title>Bar Restock</title>'), directory);
  assert.ok(html.indexOf('src="native-bridge.js"') >= 0, 'Native bridge is missing');
  assert.ok(html.indexOf('src="native-bridge.js"') < html.indexOf('src="app.js"'), 'Bridge must load first');
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(match[1]), 'Native scripts must be bundled locally');
    const script = await readFile(join(path, match[1]));
    assert.ok(script.length > 0, `Missing packaged script: ${match[1]}`);
  }
  assert.ok(html.indexOf('src="gs1.js"') < html.indexOf('src="receive.js"'), 'Barcode parser must load before Receive');
  assert.ok(html.indexOf('src="receive.js"') < html.indexOf('src="app.js"'), 'Receive must load before app initialization');
  assert.ok(html.indexOf('src="storage.js"') >= 0 && html.indexOf('src="storage.js"') < html.indexOf('src="app.js"'), 'Storage must load before app initialization');
  const assets = ['app.js', 'handout.js', 'handout-config.js', 'binder.js', 'binder-data.js', 'storage.js', 'gs1.js', 'receive.js', 'styles.css', 'catalog.json', 'manifest.webmanifest',
    'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
    'vendor/zxing-wasm/zxing-reader.iife.js', 'vendor/zxing-wasm/zxing_reader.wasm',
    'vendor/zxing-wasm/LICENSE-zxing-cpp-Apache-2.0.txt', 'vendor/zxing-wasm/LICENSE-zxing-wasm-MIT.txt',
    ...catalog.map(p => `thumbs/${p.id}.jpg`),
    ...(await readdir(join(root, 'binder-pages'))).sort().map(name => `binder-pages/${name}`)];
  for (const asset of assets) {
    const content = await readFile(join(path, asset));
    assert.ok(content.length > 0, asset);
    assert.ok(content.equals(await readFile(join(root, asset))), `Stale packaged asset: ${directory}/${asset}`);
  }
  new Script(await readFile(join(path, 'native-bridge.js'), 'utf8'));
  const forbidden = ['.git', 'node_modules', 'docs', 'package.json', 'sw.js'];
  const entries = await readdir(path);
  for (const entry of forbidden) assert.ok(!entries.includes(entry), `Unexpected packaged file: ${entry}`);
}
const project = await readFile(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
const families = [...project.matchAll(/TARGETED_DEVICE_FAMILY = ([^;]+);/g)].map(m => m[1]);
assert.deepEqual(families, ['2', '2'], 'Debug and Release must both target iPad only');
const bundleIDs = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(m => m[1]);
assert.deepEqual(bundleIDs, [config.appId, config.appId], 'Bundle identifiers must match Capacitor config');
const info = await readFile(join(root, 'ios/App/App/Info.plist'), 'utf8');
for (const permission of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
  assert.ok(new RegExp(`<key>${permission}</key>\\s*<string>[^<]+</string>`).test(info), `Missing ${permission}`);
}
const nativeConfig = JSON.parse(await readFile(join(root, 'ios/App/App/capacitor.config.json'), 'utf8'));
for (const plugin of ['AppLauncherPlugin', 'ClipboardPlugin', 'SharePlugin', 'FilesystemPlugin']) {
  assert.ok(nativeConfig.packageClassList.includes(plugin), `Missing native plugin: ${plugin}`);
}
const privacy = await readFile(join(root, 'ios/App/App/PrivacyInfo.xcprivacy'), 'utf8');
assert.ok(privacy.includes('NSPrivacyAccessedAPICategoryFileTimestamp') && privacy.includes('C617.1'), 'Missing cache export API privacy declaration');
assert.ok(project.includes('PrivacyInfo.xcprivacy in Resources'), 'Privacy declaration must be bundled in Xcode resources');
const icon = await readFile(join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
assert.equal(icon.readUInt32BE(16), 1024, 'App icon width must be 1024');
assert.equal(icon.readUInt32BE(20), 1024, 'App icon height must be 1024');
assert.equal(icon[25], 2, 'App Store icon must be opaque RGB');
console.log(`Native package checks passed: ${catalog.length} products, bundled assets, iPad target, plugins and permissions.`);
