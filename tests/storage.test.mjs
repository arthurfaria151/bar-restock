import assert from 'node:assert/strict';
import test from 'node:test';
import createStore from '../storage.js';

function fixture() {
  const values = new Map([['bar-restock-stock-v1', '{"p":2}'], ['bar-restock-delivery-draft-v1', '{"id":"draft","qty":4}']]);
  const errors = [];
  let reject = () => false;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (reject(key, value)) throw new Error('quota'); values.set(key, value); },
    removeItem(key) { if (reject(key, null)) throw new Error('blocked'); values.delete(key); },
  };
  const store = createStore(storage, message => errors.push(message), { locks: { request: async (_, work) => work() } });
  return { values, errors, storage, store, reject: fn => { reject = fn; } };
}

const receipt = {
  'bar-restock-deliveries-v1': [{ id: 'draft', qty: 4 }],
  'bar-restock-delivery-draft-v1': { id: 'next', qty: 0 },
  'bar-restock-stock-v1': { p: 6 },
};

test('a successful receipt persists every key and clears its recovery journal', async () => {
  const f = fixture();
  assert.equal(await f.store.withLock(() => f.store.batch(receipt)), true);
  for (const [key, value] of Object.entries(receipt)) assert.deepEqual(JSON.parse(f.storage.getItem(key)), value);
  assert.equal(f.storage.getItem(f.store.journalKey), null);
  assert.deepEqual(f.errors, []);
});

for (const key of ['bar-restock-transaction-v1', ...Object.keys(receipt)]) {
  test(`a blocked ${key} leaves all receipt data unchanged`, async () => {
    const f = fixture();
    const before = new Map(f.values);
    f.reject(k => k === key);
    assert.equal(await f.store.withLock(() => f.store.batch(receipt)), false);
    assert.deepEqual(f.values, before);
    assert.equal(f.errors.length, 1);
  });
}

test('a failed commit marker rolls back the entire receipt', () => {
  const f = fixture();
  const before = new Map(f.values);
  f.reject((key, value) => key === f.store.journalKey && value?.includes('"phase":"success"'));
  assert.equal(f.store.batch(receipt), false);
  assert.deepEqual(f.values, before);
});

test('an interrupted pending transaction recovers the original counts and draft', () => {
  const f = fixture();
  const entries = Object.entries(receipt).map(([key, value]) => ({ key, before: f.storage.getItem(key), after: JSON.stringify(value) }));
  f.storage.setItem(f.store.journalKey, JSON.stringify({ phase: 'pending', entries }));
  f.storage.setItem(entries[0].key, entries[0].after);
  f.storage.setItem(entries[1].key, entries[1].after);
  assert.equal(f.store.recover(), true);
  for (const entry of entries) assert.equal(f.storage.getItem(entry.key), entry.before);
  assert.equal(f.storage.getItem(f.store.journalKey), null);
});

test('an interrupted successful transaction is recovered without adding stock again', () => {
  const f = fixture();
  const entries = Object.entries(receipt).map(([key, value]) => ({ key, before: f.storage.getItem(key), after: JSON.stringify(value) }));
  f.storage.setItem(f.store.journalKey, JSON.stringify({ phase: 'success', entries }));
  assert.equal(f.store.recover(), true);
  assert.equal(f.store.recover(), true);
  assert.equal(JSON.parse(f.storage.getItem('bar-restock-stock-v1')).p, 6);
});

test('blocked rollback retains the journal until recovery can finish', async () => {
  const f = fixture();
  const before = new Map(f.values);
  f.reject((key, value) => key === 'bar-restock-stock-v1' || (key === 'bar-restock-delivery-draft-v1' && value?.includes('"id":"draft"')));
  assert.equal(f.store.batch(receipt), false);
  assert.ok(f.storage.getItem(f.store.journalKey));
  let changed = false;
  assert.equal(await f.store.withLock(() => { changed = true; }), false);
  assert.equal(changed, false);
  f.reject(() => false);
  assert.equal(f.store.recover(), true);
  assert.deepEqual(f.values, before);
});

test('malformed recovery data cannot write unrelated storage', () => {
  const f = fixture();
  f.storage.setItem(f.store.journalKey, JSON.stringify({ phase: 'pending', entries: [{ key: 'unrelated', before: 'bad', after: null }] }));
  assert.equal(f.store.recover(), false);
  assert.equal(f.storage.getItem('unrelated'), null);
});
