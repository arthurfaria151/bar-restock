import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'));
const sources = JSON.parse(await readFile(new URL('img/products/SOURCES.json', root), 'utf8'));

test('every catalog product has a local image file', async () => {
  for (const p of catalog) {
    const path = p.imagePath === undefined ? `thumbs/${p.id}.jpg` : p.imagePath;
    assert.ok(path, `${p.id} has no image`);
    assert.match(path, new RegExp(`^(?:img/products|thumbs)/${p.id}\\.(?:webp|png|jpg)$`));
    assert.ok((await stat(new URL(path, root))).size > 0, path);
  }
});

test('web product images are small WebP files listed in SOURCES.json', async () => {
  const web = catalog.filter(p => p.imagePath?.startsWith('img/products/'));
  assert.equal(Object.keys(sources.images).length, web.length);
  for (const p of web) {
    const buf = await readFile(new URL(p.imagePath, root));
    assert.equal(buf.subarray(8, 12).toString('ascii'), 'WEBP', p.id);
    assert.ok(buf.length <= 30 * 1024, `${p.id} is ${buf.length} bytes`);
    const entry = sources.images[p.id];
    assert.ok(entry, `${p.id} missing from SOURCES.json`);
    assert.match(entry.sourcePage, /^https:\/\//);
    assert.match(entry.imageUrl, /^https:\/\//);
    assert.ok(['exact', 'close', 'uncertain'].includes(entry.confidence));
  }
  for (const id of Object.keys(sources.missing)) assert.ok(!catalog.find(p => p.id === id).imagePath?.startsWith('img/'));
});
