import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url), 'utf8'));
const p = catalog[0];
const second = catalog[1];
const keys = {
  selection: 'bar-restock-selection-v1', stock: 'bar-restock-stock-v1',
  custom: 'bar-restock-custom-v1', categories: 'bar-restock-categories-v1',
  shelves: 'bar-restock-shelves-v1', draft: 'bar-restock-delivery-draft-v1',
  history: 'bar-restock-deliveries-v1', journal: 'bar-restock-transaction-v1',
};

function item(overrides = {}) {
  return { uid: 'line', productId: p.id, name: p.name, qty: 4, date: null,
    dateKind: 'bestBefore', batch: null, codes: [], ...overrides };
}
function draft(items = [item()], pending = null) {
  return { id: 'receipt-regression', startedAt: '2026-10-08T00:00:00.000Z', items, pending };
}

async function setup(page, values = {}, role = 'admin') {
  await page.addInitScript(({ values, role }) => {
    if (!localStorage.getItem('__regression_seeded')) {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem('__regression_seeded', '1');
    }
    if (role) sessionStorage.setItem('bar-restock-role-v1', role);
  }, { values, role });
  await page.goto('/');
  await expect(page.locator('#productsRoot .product-card')).toHaveCount(catalog.length + (values[keys.custom]?.length || 0));
}
async function tab(page, name) {
  const button = page.locator(`.tab-btn[data-tab="${name}"]`);
  if (!await button.isVisible()) await page.locator('#menuToggle').click();
  await button.click();
}
async function stored(page, key) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
}
async function blockWrites(page, key, mode = 'all') {
  await page.evaluate(({ key, mode }) => {
    const original = Storage.prototype.setItem;
    window.__restoreWrites = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (k, value) {
      if (k === key && (mode === 'all' || (mode === 'photo' && value.includes('data:image/')) ||
        (mode === 'marker' && value.includes('"phase":"success"')))) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, k, value);
    };
  }, { key, mode });
}

test('catalog failure and retry preserve the saved restock list', async ({ page }) => {
  await page.addInitScript(({ key, id }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ [id]: 7 }));
    sessionStorage.setItem('bar-restock-role-v1', 'admin');
  }, { key: keys.selection, id: p.id });
  let fail = true;
  await page.route('**/catalog.json', route => fail ? route.fulfill({ status: 503, body: 'Offline' }) : route.continue());
  await page.goto('/');
  await expect(page.locator('[data-retry]')).toBeVisible();
  expect(await stored(page, keys.selection)).toEqual({ [p.id]: 7 });
  fail = false;
  await page.locator('[data-retry]').click();
  await expect(page.locator('#productsRoot .product-card')).toHaveCount(catalog.length);
  await expect(page.locator('#headerBadge')).toHaveText('7');
});

for (const rejected of [keys.stock, keys.history, keys.draft, keys.journal]) {
  test(`delivery failure at ${rejected} preserves stock, history and draft; retry adds once`, async ({ page }) => {
    const receipt = draft();
    await setup(page, { [keys.stock]: { [p.id]: 2 }, [keys.draft]: receipt });
    await tab(page, 'receive');
    await blockWrites(page, rejected, rejected === keys.journal ? 'marker' : 'all');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#rxFinish').click();
    await expect(page.locator('#toast')).toContainText('Couldn’t save');
    expect(await stored(page, keys.stock)).toEqual({ [p.id]: 2 });
    expect(await stored(page, keys.history)).toBeNull();
    expect(await stored(page, keys.draft)).toEqual(receipt);
    await expect(page.locator('#rxDraft [data-uid]')).toHaveCount(1);
    await page.evaluate(() => window.__restoreWrites());
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#rxFinish').click();
    await expect(page.locator('#toast')).toContainText('Delivery saved');
    expect(await stored(page, keys.stock)).toEqual({ [p.id]: 6 });
    expect(await stored(page, keys.history)).toHaveLength(1);
    expect((await stored(page, keys.draft)).items).toHaveLength(0);
    await page.reload();
    await tab(page, 'stock');
    await expect(page.locator(`#stockRoot [data-id="${p.id}"] .qty-val`)).toHaveText('6');
  });
}

test('failed custom-product deletion preserves all its counts', async ({ page }) => {
  const custom = { id: 'custom-keep', name: 'Keep me', category: 'Other', custom: true };
  await setup(page, { [keys.custom]: [custom], [keys.stock]: { [custom.id]: 4 }, [keys.selection]: { [custom.id]: 2 } });
  await tab(page, 'stock');
  await blockWrites(page, keys.custom);
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`#stockRoot [data-id="${custom.id}"] [data-act=del]`).click();
  await expect(page.locator('#toast')).toContainText('Couldn’t save');
  expect(await stored(page, keys.custom)).toEqual([custom]);
  expect(await stored(page, keys.stock)).toEqual({ [custom.id]: 4 });
  expect(await stored(page, keys.selection)).toEqual({ [custom.id]: 2 });
  await page.reload();
  await tab(page, 'stock');
  await expect(page.locator(`#stockRoot [data-id="${custom.id}"] .qty-val`)).toHaveText('4');
});

test('two tabs finishing the same delivery add its stock exactly once', async ({ context, page }) => {
  await setup(page, { [keys.draft]: draft() });
  const other = await context.newPage();
  await setup(other);
  await tab(page, 'receive');
  await tab(other, 'receive');
  await page.evaluate(() => {
    navigator.locks.request('bar-restock-storage', async () => {
      window.__lockHeld = true;
      await new Promise(resolve => { window.__releaseLock = resolve; });
    });
  });
  await expect.poll(() => page.evaluate(() => window.__lockHeld)).toBe(true);
  for (const current of [page, other]) {
    await current.evaluate(() => {
      window.confirm = () => true;
      document.querySelector('#rxFinish').click();
    });
    await expect(current.locator('#rxFinish')).toBeDisabled();
  }
  await page.evaluate(() => window.__releaseLock());
  await expect.poll(() => stored(page, keys.stock)).toEqual({ [p.id]: 4 });
  await expect(page.locator('#rxDraft [data-uid]')).toHaveCount(0);
  await expect(other.locator('#rxDraft [data-uid]')).toHaveCount(0);
  expect(await stored(page, keys.history)).toHaveLength(1);
});

test('ordinary category rename and product deletion still persist correctly', async ({ page }) => {
  const custom = { id: 'custom-normal', name: 'Normal product', category: 'Review', custom: true };
  await setup(page, { [keys.categories]: ['Review'], [keys.custom]: [custom], [keys.stock]: { [custom.id]: 4 }, [keys.selection]: { [custom.id]: 2 } });
  await page.locator('.category-item[data-category="Review"] [data-act=rename]').click();
  await page.locator('.category-item[data-category="Review"] input').fill('Renamed');
  await page.locator('.category-item[data-category="Review"] [data-act=save]').click();
  await expect(page.locator('.category-item[data-category="Renamed"]')).toBeVisible();
  expect((await stored(page, keys.custom))[0].category).toBe('Renamed');
  await tab(page, 'stock');
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`#stockRoot [data-id="${custom.id}"] [data-act=del]`).click();
  await expect(page.locator('#toast')).toHaveText('Product removed');
  expect(await stored(page, keys.custom)).toEqual([]);
  expect(await stored(page, keys.stock)).toEqual({});
  expect(await stored(page, keys.selection)).toEqual({});
  await page.reload();
  await expect(page.locator('#productsRoot .product-card')).toHaveCount(catalog.length);
});

for (const fallback of [false, true]) {
  test(`stock edits from two tabs preserve different products and concurrent increments (${fallback ? 'IndexedDB' : 'Web Locks'})`, async ({ context, page }) => {
    if (fallback) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    await setup(page);
    const other = await context.newPage();
    await setup(other);
    await tab(page, 'stock');
    await tab(other, 'stock');
    await page.locator(`#stockRoot [data-id="${p.id}"] [data-act=inc]`).click();
    await other.locator(`#stockRoot [data-id="${second.id}"] [data-act=inc]`).click();
    await expect.poll(() => stored(page, keys.stock)).toEqual({ [p.id]: 1, [second.id]: 1 });
    for (let i = 0; i < 5; i++) {
      await Promise.all([page, other].map(tab => tab.locator(`#stockRoot [data-id="${p.id}"] [data-act=inc]`).click()));
    }
    await expect.poll(() => stored(page, keys.stock)).toEqual({ [p.id]: 11, [second.id]: 1 });
    await expect(page.locator(`#stockRoot [data-id="${p.id}"] .qty-val`)).toHaveText('11');
    await expect(other.locator(`#stockRoot [data-id="${p.id}"] .qty-val`)).toHaveText('11');
  });
}

test('full real localStorage keeps the product form and reports failure', async ({ page }) => {
  await setup(page);
  await tab(page, 'stock');
  await page.evaluate(() => {
    let text = '';
    for (let size = 2 ** 22; size > 0; size = Math.floor(size / 2)) {
      try { localStorage.setItem('__quota_filler', text + 'x'.repeat(size)); text += 'x'.repeat(size); } catch (_) {}
    }
  });
  await page.locator('#newProductName').fill('Quota product');
  await page.locator('#addProductForm button[type=submit]').click();
  await expect(page.locator('#addProductError')).toContainText('Couldn’t save');
  await expect(page.locator('#newProductName')).toHaveValue('Quota product');
  expect(await stored(page, keys.custom)).toBeNull();
  await page.reload();
  await expect(page.locator('#productsRoot .product-card')).toHaveCount(catalog.length);
});

test('signed-out keyboard focus stays in login and edit handlers reject changes', async ({ page }) => {
  await setup(page, {}, null);
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#loginScreen'))).toBe(true);
  }
  await page.evaluate(() => {
    document.querySelector('#newProductName').value = 'Unauthorized product';
    document.querySelector('#addProductForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document.querySelector('.tab-btn[data-tab=stock]').click();
  });
  expect(await stored(page, keys.custom)).toBeNull();
  await expect(page.locator('#panel-products')).toHaveClass('panel active');
  await page.locator('#btnLoginBartender').click();
  await expect(page.locator('#addProductForm')).toBeHidden();
  await expect(page.locator('#stockRoot [data-act=del]')).toHaveCount(0);
});

for (const packSize of [1, 12]) {
  test(`typing ${packSize === 1 ? 'units' : 'cartons'} adds on the first tap`, async ({ page }) => {
    const pending = { ...item({ qty: packSize }), cartons: 1, packSize, code: 'TEST', warnings: [], oneOff: false, fromCount: null, countValue: null, hadDate: false, bestBefore: null, useBy: null };
    await setup(page, { [keys.draft]: draft([], pending) });
    await tab(page, 'receive');
    await page.locator(packSize === 1 ? '#rxQty' : '#rxCartons').fill('2');
    await page.locator('#rxConfirm [data-rx-act=confirm]').click();
    await expect(page.locator('#rxDraft .qty-val')).toHaveText(String(2 * packSize));
    expect((await stored(page, keys.draft)).pending).toBeNull();
  });
}

test('carton imports reject invalid pack sizes and accept a valid carton', async ({ page }) => {
  await setup(page);
  await tab(page, 'receive');
  await page.locator('#rxSegLinks').click();
  const links = Object.fromEntries([0, 1, 2.5, 1000, 12].map((size, index) => [`raw:PACK${index}`, { productId: p.id, kind: 'carton', packSize: size }]));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#rxImport').setInputFiles({ name: 'links.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ type: 'barcode-links', links })) });
  await expect(page.locator('#rxImportResult')).toContainText('4 invalid');
  expect(Object.values(await stored(page, 'bar-restock-barcodes-v1')).map(link => link.packSize)).toEqual([12]);
});

test('failed category deletion and rename preserve saved categories and products', async ({ page }) => {
  const custom = { id: 'custom-category', name: 'Category product', category: 'Review', custom: true };
  await setup(page, { [keys.categories]: ['Review', 'Empty'], [keys.custom]: [custom] });
  await blockWrites(page, keys.categories);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.category-item[data-category="Empty"] [data-act=delete]').click();
  await expect(page.locator('#toast')).toContainText('Couldn’t save');
  expect(await stored(page, keys.categories)).toEqual(['Review', 'Empty']);
  await page.evaluate(() => window.__restoreWrites());
  await blockWrites(page, keys.custom);
  await page.locator('.category-item[data-category="Review"] [data-act=rename]').click();
  await page.locator('.category-item[data-category="Review"] input').fill('Renamed');
  await page.locator('.category-item[data-category="Review"] [data-act=save]').click();
  await expect(page.locator('.category-item[data-category="Review"] .field-error')).toContainText('Couldn’t save');
  expect(await stored(page, keys.categories)).toEqual(['Review', 'Empty']);
  expect(await stored(page, keys.custom)).toEqual([custom]);
});

test('shelf save failures never report success or change the layout', async ({ page }) => {
  const layout = { levels: [{ id: 'review', name: 'Review shelf', slots: [{ id: p.id, facings: 1 }] }] };
  await setup(page, { [keys.shelves]: layout });
  await tab(page, 'shelves');
  await page.locator('#btnShelvesEdit').click();
  await blockWrites(page, keys.shelves);
  await page.locator('#newShelfName').fill('Failed shelf');
  await page.locator('[data-add-level] button[type=submit]').click();
  await expect(page.locator('#toast')).toContainText('Couldn’t save');
  await expect(page.locator('#newShelfName')).toHaveValue('Failed shelf');
  await page.locator('[data-act=slot-remove]').click();
  await expect(page.locator('#toast')).toContainText('Couldn’t save');
  await expect(page.locator('.shelf-slot')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#btnShelvesReset').click();
  await expect(page.locator('#toast')).toContainText('Couldn’t save');
  expect(await stored(page, keys.shelves)).toEqual(layout);
});

async function delayPhoto(page) {
  await page.evaluate(() => {
    const OriginalImage = window.Image;
    window.Image = function (...args) {
      const image = new OriginalImage(...args);
      Object.defineProperty(image, 'onload', { set(handler) { image.addEventListener('load', event => setTimeout(() => handler.call(image, event), 1000)); } });
      return image;
    };
  });
}
test('photo conversion blocks early submission and never leaks into another product', async ({ page }) => {
  await setup(page);
  await tab(page, 'stock');
  await delayPhoto(page);
  await page.locator('#newProductName').fill('Photo first');
  await page.locator('#newProductPhoto').setInputFiles(new URL('../icon-512.png', import.meta.url).pathname);
  await expect(page.locator('#addProductForm button[type=submit]')).toBeDisabled();
  await page.locator('#newProductName').press('Enter');
  expect(await stored(page, keys.custom)).toBeNull();
  await expect(page.locator('#newProductPreview')).toBeVisible();
  await page.locator('#addProductForm button[type=submit]').click();
  await page.locator('#newProductName').fill('Photo second');
  await page.locator('#addProductForm button[type=submit]').click();
  const products = await stored(page, keys.custom);
  expect(products[0].image).toMatch(/^data:image\/jpeg/);
  expect(products[1].image).toBeUndefined();
});

test('removing a photo ignores its late conversion and photo-quota fallback stays visible', async ({ page }) => {
  await setup(page);
  await tab(page, 'stock');
  await delayPhoto(page);
  await page.locator('#newProductPhoto').setInputFiles(new URL('../icon-512.png', import.meta.url).pathname);
  await page.locator('#btnRemovePhoto').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('#newProductPreview')).toBeHidden();
  await page.locator('#newProductPhoto').setInputFiles(new URL('../icon-512.png', import.meta.url).pathname);
  await expect(page.locator('#newProductPreview')).toBeVisible();
  await blockWrites(page, keys.custom, 'photo');
  await page.locator('#newProductName').fill('Without photo');
  await page.locator('#addProductForm button[type=submit]').click();
  await expect(page.locator('#toast')).toContainText('without the photo');
  expect((await stored(page, keys.custom))[0].image).toBeUndefined();
});

test('dialogs contain keyboard focus and restore the shelf opener after rendering', async ({ page }) => {
  await setup(page);
  await tab(page, 'shelves');
  await page.locator('.shelf-slot').first().click();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#sheet'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await page.locator('#btnShelvesEdit').click();
  const opener = page.locator('[data-level="top"] [data-act=slot-add]');
  await opener.click();
  await page.locator('#pickerSearch').fill(p.name);
  await page.locator(`[data-pick="${p.id}"]`).click();
  await page.locator('#btnSheetClose').click();
  await expect(opener).toBeFocused();
});

test('all six panels fit seven widths in both color schemes', async ({ page }) => {
  test.setTimeout(60000);
  await setup(page);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 375, 768, 820, 1024, 1180, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const panel of ['products', 'stock', 'receive', 'par', 'restock', 'shelves']) {
        await tab(page, panel);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${panel}, ${width}px, ${colorScheme}`).toBe(true);
      }
    }
  }
});

test('service worker caches the new storage script and the website reloads offline', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  await setup(page);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Service worker not active');
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await page.evaluate(async () => !!await caches.match('./storage.js'))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#productsRoot .product-card')).toHaveCount(catalog.length);
  await tab(page, 'stock');
  await page.locator(`#stockRoot [data-id="${p.id}"] [data-act=inc]`).click();
  await expect(page.locator(`#stockRoot [data-id="${p.id}"] .qty-val`)).toHaveText('1');
  await context.close();
});
