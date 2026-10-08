// Run with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const GS1 = require("../gs1.js");
const GS = "\u001d";
const NOW = new Date("2026-10-08T00:00:00Z");

// Valid GTINs used below (check digits computed per GS1 mod-10).
const EAN13 = "9312345678907";
const UPCA = "012345678905";
const GTIN14_UPCA = "00012345678905";
const ITF14 = "19312345678904";

test("check digit and validation", () => {
  assert.equal(GS1.checkDigit("931234567890"), "7");
  assert.equal(GS1.checkDigit("01234567890"), "5");
  assert.equal(GS1.checkDigit("1931234567890"), "4");
  assert.ok(GS1.isValidGtin(EAN13));
  assert.ok(GS1.isValidGtin(UPCA));
  assert.ok(GS1.isValidGtin(ITF14));
  assert.ok(GS1.isValidGtin("96385074")); // EAN-8
  assert.ok(!GS1.isValidGtin("9312345678908"));
  assert.ok(!GS1.isValidGtin("12345"));
  assert.ok(!GS1.isValidGtin("abc"));
});

test("GTIN normalisation to GTIN-14", () => {
  assert.deepEqual(GS1.normalizeGtin(UPCA), { gtin14: GTIN14_UPCA, valid: true });
  assert.deepEqual(GS1.normalizeGtin(GTIN14_UPCA), { gtin14: GTIN14_UPCA, valid: true });
  assert.deepEqual(GS1.normalizeGtin("0" + UPCA), { gtin14: GTIN14_UPCA, valid: true }); // EAN-13 form of a UPC-A
  assert.deepEqual(GS1.normalizeGtin(EAN13), { gtin14: "0" + EAN13, valid: true });
  assert.deepEqual(GS1.normalizeGtin("96385074"), { gtin14: "00000096385074", valid: true });
  assert.equal(GS1.normalizeGtin("1234567"), null);
  assert.equal(GS1.normalizeGtin("12a45678"), null);
  assert.equal(GS1.normalizeGtin("9312345678908").valid, false);
  // UPC-A, its EAN-13 and GTIN-14 forms share one lookup key.
  const keys = [UPCA, "0" + UPCA, GTIN14_UPCA].map((c) => GS1.parseCode(c).key);
  assert.deepEqual(new Set(keys).size, 1);
  assert.equal(keys[0], "gtin:" + GTIN14_UPCA);
});

test("UPC-E expands to UPC-A when the decoder says UPC-E", () => {
  assert.equal(GS1.upcEtoA("01234565"), "012345000065");
  assert.equal(GS1.upcEtoA("04252614"), "042100005264");
  assert.deepEqual(GS1.normalizeGtin("04252614", "UPCE"), { gtin14: "00042100005264", valid: true });
  // Without a format hint an 8-digit code is an EAN-8.
  assert.equal(GS1.normalizeGtin("04252614").gtin14, "00000004252614");
});

test("dates: YYMMDD, DD=00 end of month, century window", () => {
  assert.equal(GS1.parseGs1Date("261231", NOW), "2026-12-31");
  assert.equal(GS1.parseGs1Date("270200", NOW), "2027-02-28");
  assert.equal(GS1.parseGs1Date("280200", NOW), "2028-02-29"); // leap year
  assert.equal(GS1.parseGs1Date("260400", NOW), "2026-04-30");
  assert.equal(GS1.parseGs1Date("761231", NOW), "2076-12-31"); // +50 → same century
  assert.equal(GS1.parseGs1Date("771231", NOW), "1977-12-31"); // +51 → previous century
  assert.equal(GS1.parseGs1Date("990101", NOW), "1999-01-01");
  assert.equal(GS1.parseGs1Date("261301", NOW), null);
  assert.equal(GS1.parseGs1Date("260231", NOW), null);
  assert.equal(GS1.parseGs1Date("2612", NOW), null);
  // Century window relative to the year passed in.
  assert.equal(GS1.parseGs1Date("010101", new Date("2099-06-01T00:00:00Z")), "2101-01-01");
});

test("AI length table", () => {
  assert.equal(GS1.aiLength("01"), 2);
  assert.equal(GS1.aiLength("10"), 2);
  assert.equal(GS1.aiLength("24"), 3);
  assert.equal(GS1.aiLength("31"), 4);
  assert.equal(GS1.aiLength("80"), 4);
});

test("element string: fixed then variable AIs with GS separators", () => {
  const s = `01${ITF14}15261231` + `10LOT42${GS}17270200` + `21SER1`;
  const r = GS1.parseCode(s, { now: NOW });
  assert.equal(r.type, "gs1");
  assert.equal(r.gtin14, ITF14);
  assert.equal(r.bestBefore, "2026-12-31");
  assert.equal(r.useBy, "2027-02-28");
  assert.equal(r.batch, "LOT42");
  assert.equal(r.ais["21"], "SER1");
  assert.equal(r.key, "gtin:" + ITF14);
  assert.deepEqual(r.warnings, []);
});

test("element string with symbology identifiers ]C1 ]d2 ]Q3 and leading FNC1", () => {
  const body = `01${ITF14}10ABC${GS}15261231`;
  for (const prefix of ["]C1", "]d2", "]Q3"]) {
    const r = GS1.parseCode(prefix + body, { now: NOW });
    assert.equal(r.gtin14, ITF14, prefix);
    assert.equal(r.batch, "ABC", prefix);
    assert.equal(r.bestBefore, "2026-12-31", prefix);
  }
  // Decoders that report the identifier separately and put FNC1 as a leading GS.
  const r2 = GS1.parseCode(GS + body, { symbologyIdentifier: "]C1", now: NOW });
  assert.equal(r2.batch, "ABC");
  // Identifier passed separately, no GS at the start.
  const r3 = GS1.parseCode(body, { symbologyIdentifier: "]d2", now: NOW });
  assert.equal(r3.gtin14, ITF14);
});

test("variable AI ends at GS, end of data, or its maximum length", () => {
  const r = GS1.parseCode(`]C110${"X".repeat(25)}`, { now: NOW });
  assert.equal(r.ais["10"], "X".repeat(20)); // (10) max 20
  const r2 = GS1.parseCode(`]C1010${UPCA.padStart(13, "0")}37${"12"}`, { now: NOW });
  assert.equal(r2.count, 12);
});

test("carton: (02) contained GTIN + (37) count", () => {
  const r = GS1.parseCode(`]C102${"0" + EAN13}3724${GS}10B7${GS}17261015`, { now: NOW });
  assert.equal(r.containedGtin14, "0" + EAN13);
  assert.equal(r.count, 24);
  assert.equal(r.countSource, "37");
  assert.equal(r.key, "gtin:0" + EAN13); // looks up the contained item
  assert.equal(r.useBy, "2026-10-15");
  assert.equal(r.batch, "B7");
});

test("(01) + (30) variable count", () => {
  const r = GS1.parseCode(`(01)${ITF14}(30)6`, { now: NOW });
  assert.equal(r.count, 6);
  assert.equal(r.countSource, "30");
  assert.equal(r.key, "gtin:" + ITF14);
});

test("human-readable bracketed form", () => {
  const r = GS1.parseCode("(01)09312345678907(15)261231(10)ABC", { now: NOW });
  assert.equal(r.type, "gs1");
  assert.equal(r.gtin14, "09312345678907");
  assert.equal(r.bestBefore, "2026-12-31");
  assert.equal(r.batch, "ABC");
  assert.equal(r.display, "(01)09312345678907(15)261231(10)ABC");
  // Spec example with an invalid GTIN check digit: parsed, but warns.
  const r2 = GS1.parseCode("(01)09300000000000(15)261231(10)ABC", { now: NOW });
  assert.equal(r2.gtin14, "09300000000000");
  assert.ok(r2.warnings.some((w) => /check digit/i.test(w)));
  // Garbage after the AIs is reported.
  const r3 = GS1.parseCode("(01)09312345678907 trailing", { now: NOW });
  assert.equal(r3.gtin14, "09312345678907");
  assert.ok(r3.warnings.length >= 1);
});

test("GS1 Digital Link URLs (parsed, not opened)", () => {
  const r = GS1.parseCode("https://id.example.com/01/09312345678907/10/LOT%2F9?15=261231&17=270200&3103=000750", { now: NOW });
  assert.equal(r.type, "gs1");
  assert.ok(r.digitalLink);
  assert.equal(r.gtin14, "09312345678907");
  assert.equal(r.batch, "LOT/9");
  assert.equal(r.bestBefore, "2026-12-31");
  assert.equal(r.useBy, "2027-02-28");
  // Custom path prefix and a 13-digit GTIN.
  const r2 = GS1.parseCode("https://brand.example/products/01/9312345678907", { now: NOW });
  assert.equal(r2.gtin14, "09312345678907");
  // Not a digital link → raw text key.
  const r3 = GS1.parseCode("https://example.com/hello", { now: NOW });
  assert.equal(r3.type, "raw");
  assert.equal(r3.key, "raw:https://example.com/hello");
  assert.equal(GS1.parseDigitalLink("javascript:alert(1)"), null);
});

test("plain scans and manual entry", () => {
  const r = GS1.parseCode(" 9312345678907 ");
  assert.equal(r.type, "gtin");
  assert.equal(r.key, "gtin:09312345678907");
  assert.deepEqual(r.warnings, []);
  const bad = GS1.parseCode("9312345678908");
  assert.equal(bad.type, "gtin");
  assert.ok(bad.warnings.length === 1); // accepted, with a warning
  const itf = GS1.parseCode(ITF14);
  assert.equal(itf.key, "gtin:" + ITF14);
  const raw = GS1.parseCode("BOX-17 <b>hi</b>");
  assert.equal(raw.type, "raw");
  assert.equal(raw.key, "raw:BOX-17 <b>hi</b>");
  // Typed element string without brackets or separators.
  const typed = GS1.parseCode(`01${ITF14}15261231`, { now: NOW });
  assert.equal(typed.type, "gs1");
  assert.equal(typed.bestBefore, "2026-12-31");
  assert.equal(GS1.parseCode("").warnings[0], "Empty code");
});

test("malformed element strings don't throw", () => {
  for (const s of ["]C101123", "]C1ZZ", `]C115${GS}`, "]d2", "(01)", "(x)1", GS + GS]) {
    assert.doesNotThrow(() => GS1.parseCode(s, { now: NOW }), s);
  }
  const r = GS1.parseCode("]C101123", { now: NOW });
  assert.equal(r.gtin14, null);
});
