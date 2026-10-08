import assert from "node:assert/strict";
import test from "node:test";
import { createNativeBridge } from "./bridge.js";

function bridgeWith(overrides = {}) {
  return createNativeBridge({
    clipboard: { write: async () => {} },
    share: { share: async () => ({ activityType: "com.apple.UIKit.activity.CopyToPasteboard" }) },
    appLauncher: { openUrl: async () => ({ completed: true }) },
    filesystem: { writeFile: async () => ({ uri: "file:///cache/export.json" }), rmdir: async () => {} },
    ...overrides,
  });
}

test("restock text reaches the native clipboard without losing quantities or line breaks", async () => {
  let clipboardValue;
  const bridge = bridgeWith({ clipboard: { write: async (value) => { clipboardValue = value; } } });
  const text = "Restock list\n────────────\nFridge:\n  3× Água com gás\n\nTotal: 3 items (1 products)";
  await bridge.copyText(text);
  assert.deepEqual(clipboardValue, { string: text });
});

test("clipboard failures remain visible to the application", async () => {
  const error = new Error("Clipboard unavailable");
  const bridge = bridgeWith({ clipboard: { write: async () => { throw error; } } });
  await assert.rejects(bridge.copyText("Restock list"), (actual) => actual === error);
});

test("the native share sheet receives the restock title and text", async () => {
  let shareValue;
  const result = { activityType: "com.apple.UIKit.activity.Mail" };
  const bridge = bridgeWith({ share: { share: async (value) => { shareValue = value; return result; } } });
  assert.equal(await bridge.shareText({ title: "Bar Restock", text: "2× Tonic" }), result);
  assert.deepEqual(shareValue, { title: "Bar Restock", text: "2× Tonic", dialogTitle: "Bar Restock" });
});

test("dismissing the iPad share sheet is a normal outcome", async () => {
  const bridge = bridgeWith({ share: { share: async () => { throw new Error("Share canceled"); } } });
  assert.equal(await bridge.shareText({ title: "Bar Restock", text: "2× Tonic" }), null);
});

test("a genuine share failure is not mistaken for dismissal", async () => {
  const error = new Error("Can't share while sharing is in progress");
  const bridge = bridgeWith({ share: { share: async () => { throw error; } } });
  await assert.rejects(bridge.shareText({ title: "Bar Restock", text: "2× Tonic" }), (actual) => actual === error);
});

test("a reminder opens the mail app with its encoded recipient and draft", async () => {
  let launchValue;
  const bridge = bridgeWith({ appLauncher: { openUrl: async (value) => { launchValue = value; return { completed: true }; } } });
  const url = "mailto:arthurfaria%40guarasolutions.com?subject=Low%20stock&body=2%C3%97%20Tonic%0A";
  await bridge.openMailto(url);
  assert.deepEqual(launchValue, { url });
});

test("a missing mail app reports failure instead of a prepared reminder", async () => {
  const bridge = bridgeWith({ appLauncher: { openUrl: async () => ({ completed: false }) } });
  await assert.rejects(bridge.openMailto("mailto:example%40example.com?subject=Low%20stock"), /No mail app/);
});

test("the bridge prevents unrelated external navigation", async () => {
  let launches = 0;
  const bridge = bridgeWith({ appLauncher: { openUrl: async () => { launches++; return { completed: true }; } } });
  for (const url of ["https://example.com", "javascript:alert(1)", "file:///tmp/report", null]) {
    await assert.rejects(bridge.openMailto(url), TypeError);
  }
  assert.equal(launches, 0);
});

test("barcode JSON is shared as a UTF8 file and retained until the share sheet closes", async () => {
  const events = [];
  const uri = "file:///private/cache/bar-restock-barcodes-2026-10-08.json";
  let writeOptions;
  let shareOptions;
  let cleanupOptions;
  let shareStarted;
  let finishShare;
  const started = new Promise((resolve) => { shareStarted = resolve; });
  const pending = new Promise((resolve) => { finishShare = resolve; });
  const bridge = bridgeWith({
    filesystem: {
      writeFile: async (options) => { events.push("write"); writeOptions = options; return { uri }; },
      rmdir: async (options) => { events.push("cleanup"); cleanupOptions = options; },
    },
    share: { share: async (options) => { events.push("share"); shareOptions = options; shareStarted(); return pending; } },
  });
  const name = "bar-restock-barcodes-2026-10-08.json";
  const contents = '{"app":"bar-restock","links":{"raw:Água":{"productId":"p1","packSize":12}}}\n';
  const exportPromise = bridge.shareJsonFile({ name, contents, title: "Bar Restock barcode links" });
  await started;
  assert.deepEqual(events, ["write", "share"]);
  assert.match(writeOptions.path, /^bar-restock-exports\/[^/]+\/bar-restock-barcodes-2026-10-08\.json$/);
  assert.equal(writeOptions.directory, "CACHE");
  assert.equal(writeOptions.encoding, "utf8");
  assert.equal(writeOptions.recursive, true);
  assert.equal(writeOptions.data, contents);
  assert.deepEqual(shareOptions, { title: "Bar Restock barcode links", dialogTitle: "Bar Restock barcode links", files: [uri] });
  const result = { activityType: "com.apple.DocumentManagerUICore.SaveToFiles" };
  finishShare(result);
  assert.equal(await exportPromise, result);
  assert.deepEqual(events, ["write", "share", "cleanup"]);
  assert.deepEqual(cleanupOptions, { path: writeOptions.path.slice(0, -(name.length + 1)), directory: "CACHE", recursive: true });
});

test("dismissing a JSON export cleans its temporary file without claiming success", async () => {
  let cleaned = false;
  const bridge = bridgeWith({
    filesystem: { writeFile: async () => ({ uri: "file:///cache/export.json" }), rmdir: async () => { cleaned = true; } },
    share: { share: async () => { throw new Error("Share canceled"); } },
  });
  assert.equal(await bridge.shareJsonFile({ name: "barcodes.json", contents: "{}\n", title: "Barcode links" }), null);
  assert.equal(cleaned, true);
});

test("a failed JSON share remains retriable and cleans its temporary file", async () => {
  let cleaned = false;
  const error = new Error("Error sharing item");
  const bridge = bridgeWith({
    filesystem: { writeFile: async () => ({ uri: "file:///cache/export.json" }), rmdir: async () => { cleaned = true; } },
    share: { share: async () => { throw error; } },
  });
  await assert.rejects(bridge.shareJsonFile({ name: "barcodes.json", contents: "{}", title: "Barcode links" }), (actual) => actual === error);
  assert.equal(cleaned, true);
});

test("a failed cache write prevents sharing and still attempts cleanup", async () => {
  let cleaned = false;
  let shared = false;
  const error = new Error("No space left");
  const bridge = bridgeWith({
    filesystem: { writeFile: async () => { throw error; }, rmdir: async () => { cleaned = true; } },
    share: { share: async () => { shared = true; } },
  });
  await assert.rejects(bridge.shareJsonFile({ name: "barcodes.json", contents: "{}", title: "Barcode links" }), (actual) => actual === error);
  assert.equal(shared, false);
  assert.equal(cleaned, true);
});

test("a cleanup failure cannot turn share dismissal into an export failure", async () => {
  const bridge = bridgeWith({
    filesystem: { writeFile: async () => ({ uri: "file:///cache/export.json" }), rmdir: async () => { throw new Error("Already purged"); } },
    share: { share: async () => { throw new Error("Share canceled"); } },
  });
  assert.equal(await bridge.shareJsonFile({ name: "barcodes.json", contents: "{}", title: "Barcode links" }), null);
});

test("invalid JSON or filenames cannot write outside the export cache", async () => {
  let filesystemCalls = 0;
  let shareCalls = 0;
  const bridge = bridgeWith({
    filesystem: {
      writeFile: async () => { filesystemCalls++; return { uri: "file:///cache/export.json" }; },
      rmdir: async () => { filesystemCalls++; },
    },
    share: { share: async () => { shareCalls++; } },
  });
  for (const name of ["../barcodes.json", "/barcodes.json", "folder/barcodes.json", "folder\\barcodes.json", "barcodes..json", "barcodes.txt", "", null]) {
    await assert.rejects(bridge.shareJsonFile({ name, contents: "{}", title: "Barcode links" }), TypeError);
  }
  await assert.rejects(bridge.shareJsonFile({ name: "barcodes.json", contents: null, title: "Barcode links" }), TypeError);
  await assert.rejects(bridge.shareJsonFile({ name: "barcodes.json", contents: "not JSON", title: "Barcode links" }), SyntaxError);
  assert.equal(filesystemCalls, 0);
  assert.equal(shareCalls, 0);
});

test("simultaneous exports with the same filename use separate cache folders", async () => {
  const paths = [];
  const bridge = bridgeWith({
    filesystem: {
      writeFile: async (options) => { paths.push(options.path); return { uri: `file:///cache/${options.path}` }; },
      rmdir: async () => {},
    },
  });
  await Promise.all([
    bridge.shareJsonFile({ name: "barcodes.json", contents: '{"links":1}', title: "Barcode links" }),
    bridge.shareJsonFile({ name: "barcodes.json", contents: '{"links":2}', title: "Barcode links" }),
  ]);
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  assert.ok(paths.every((path) => path.startsWith("bar-restock-exports/") && path.endsWith("/barcodes.json")));
});
