/* Local persistence shared by the website and iPad bundle. */
(function (root) {
  "use strict";
  const JOURNAL_KEY = "bar-restock-transaction-v1";
  const LOCK_NAME = "bar-restock-storage";

  function createStore(storage, onError, options = {}) {
    const locks = options.locks === undefined ? root.navigator && root.navigator.locks : options.locks;
    let idb = options.indexedDB;
    if (idb === undefined) { try { idb = root.indexedDB; } catch (_) {} }
    const fail = () => onError("Couldn’t save — storage is full or blocked");
    let database;

    function writeRaw(key, value) {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    }

    // An interrupted multi-key operation is rolled back unless its commit marker
    // was saved. Recovery runs under the same cross-tab lock as mutations.
    function recover() {
      try {
        const raw = storage.getItem(JOURNAL_KEY);
        if (!raw) return true;
        const journal = JSON.parse(raw);
        if (!Array.isArray(journal.entries) || !["pending", "success"].includes(journal.phase)) throw new Error("Invalid transaction");
        for (const entry of journal.entries) {
          if (!entry || typeof entry.key !== "string" || !entry.key.startsWith("bar-restock-") || entry.key === JOURNAL_KEY ||
              ![entry.before, entry.after].every((v) => v === null || typeof v === "string")) throw new Error("Invalid transaction entry");
        }
        for (const entry of journal.entries) {
          const value = journal.phase === "success" ? entry.after : entry.before;
          if (storage.getItem(entry.key) !== value) writeRaw(entry.key, value);
        }
        storage.removeItem(JOURNAL_KEY);
        return true;
      } catch (_) {
        fail();
        return false;
      }
    }

    function save(key, value, quiet) {
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (_) {
        if (!quiet) fail();
        return false;
      }
    }

    // Call while holding withLock. Keep both versions until every key and the
    // commit marker are saved, so a quota error never leaves a partial receipt.
    function batch(values) {
      let entries;
      let prepared = false;
      try {
        entries = Object.entries(values).map(([key, value]) => ({
          key, before: storage.getItem(key), after: JSON.stringify(value),
        })).filter((entry) => entry.before !== entry.after);
        if (!entries.length) return true;
        storage.setItem(JOURNAL_KEY, JSON.stringify({ phase: "pending", entries }));
        prepared = true;
        for (const entry of entries) writeRaw(entry.key, entry.after);
        // Same-length phase names avoid growing the marker at the quota limit.
        storage.setItem(JOURNAL_KEY, JSON.stringify({ phase: "success", entries }));
      } catch (_) {
        if (prepared) {
          // Keep the journal if rollback is blocked; the next operation/reload
          // retries recovery before allowing any further inventory mutation.
          try {
            for (const entry of entries.slice().reverse()) {
              if (storage.getItem(entry.key) !== entry.before) writeRaw(entry.key, entry.before);
            }
            storage.removeItem(JOURNAL_KEY);
          } catch (_) {}
        }
        fail();
        return false;
      }
      // A committed journal can safely remain if cleanup is temporarily blocked.
      try { storage.removeItem(JOURNAL_KEY); } catch (_) {}
      return true;
    }

    function openDatabase() {
      if (!database) database = new Promise((resolve, reject) => {
        if (!idb) return reject(new Error("Storage locking unavailable"));
        const request = idb.open(LOCK_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("mutex");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Storage locking blocked"));
      });
      return database;
    }

    async function withLock(change) {
      const run = () => recover() ? change() : false;
      try {
        if (locks) return await locks.request(LOCK_NAME, run);
        // Older Safari has IndexedDB but no Web Locks. A readwrite transaction
        // serializes its synchronous localStorage operation across tabs too.
        const db = await openDatabase();
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction("mutex", "readwrite");
          let result;
          transaction.objectStore("mutex").get("lock").onsuccess = () => {
            try { result = run(); } catch (_) { transaction.abort(); }
          };
          transaction.oncomplete = () => resolve(result);
          transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Storage locking failed"));
        });
      } catch (_) {
        fail();
        return false;
      }
    }

    return { save, batch, recover, withLock, journalKey: JOURNAL_KEY };
  }

  if (typeof module === "object" && module.exports) module.exports = createStore;
  else root.BarRestockStorage = createStore;
})(globalThis);
