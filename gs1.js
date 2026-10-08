/*
 * GS1 / GTIN parsing for the Receive delivery screen. Pure functions, no DOM.
 * Works as a classic <script> (window.BarRestockGS1) and as a CommonJS module (node tests).
 *
 * Handles:
 *  - plain GTINs: EAN-8, UPC-A (12), UPC-E (8, when the decoder says UPC-E), EAN-13, GTIN-14 / ITF-14
 *    → normalised to GTIN-14 for lookups, with check-digit validation
 *  - GS1 element strings from GS1-128 / GS1 DataMatrix / GS1 QR (FNC1 as \u001d, optional ]C1 ]d2 ]Q3 ]e0 prefix)
 *  - the human-readable form "(01)09300000000000(15)261231(10)ABC"
 *  - GS1 Digital Link URIs "https://example.com/01/09300000000000/10/ABC?15=261231" (parsed only, never opened)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BarRestockGS1 = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GS = "\u001d";

  // AIs with a predefined (fixed) data length, keyed by the first two digits of the AI.
  // Values are data lengths (excluding the AI itself). From the GS1 General Specifications, fig. 5.10.1-2.
  const FIXED_BY_PREFIX = {
    "00": 18, "01": 14, "02": 14, "03": 14, "04": 16,
    "11": 6, "12": 6, "13": 6, "14": 6, "15": 6, "16": 6, "17": 6, "18": 6, "19": 6,
    "20": 2, "31": 6, "32": 6, "33": 6, "34": 6, "35": 6, "36": 6, "41": 13,
  };
  // Maximum lengths for the variable-length AIs we care about (others default to 90).
  const VARIABLE_MAX = { "10": 20, "21": 20, "22": 20, "30": 8, "37": 8, "240": 30, "241": 30, "250": 30, "251": 30, "400": 30, "90": 30 };

  // Length of the AI (2, 3 or 4 digits) from its first two digits.
  function aiLength(two) {
    const n = Number(two);
    if (["23", "24", "25", "40", "41", "42", "71"].includes(two)) return 3;
    if ((n >= 31 && n <= 36) || ["39", "43", "70", "72", "80", "81", "82"].includes(two)) return 4;
    return 2;
  }

  const LABELS = {
    "00": "SSCC", "01": "GTIN", "02": "Contained GTIN", "10": "Batch/lot", "11": "Production date",
    "13": "Packaging date", "15": "Best before", "16": "Sell by", "17": "Use by", "21": "Serial",
    "30": "Count", "37": "Count of contained items",
  };

  /* ---------- GTIN helpers ---------- */

  function onlyDigits(s) {
    return typeof s === "string" && /^\d+$/.test(s);
  }

  // GS1 mod-10 check digit for the digits that precede it.
  function checkDigit(body) {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      const d = body.charCodeAt(body.length - 1 - i) - 48;
      sum += i % 2 === 0 ? d * 3 : d;
    }
    return String((10 - (sum % 10)) % 10);
  }

  function isValidGtin(code) {
    if (!onlyDigits(code) || ![8, 12, 13, 14].includes(code.length)) return false;
    return checkDigit(code.slice(0, -1)) === code.slice(-1);
  }

  // UPC-E (8 digits incl. number system and check) → UPC-A (12 digits).
  function upcEtoA(upce) {
    if (!onlyDigits(upce)) return null;
    let s = upce;
    if (s.length === 6) s = "0" + s + "?";
    if (s.length === 7) s = s + "?";
    if (s.length !== 8 || (s[0] !== "0" && s[0] !== "1")) return null;
    const ns = s[0];
    const d = s.slice(1, 7);
    const last = d[5];
    let body;
    if ("012".includes(last)) body = d.slice(0, 2) + last + "0000" + d.slice(2, 5);
    else if (last === "3") body = d.slice(0, 3) + "00000" + d.slice(3, 5);
    else if (last === "4") body = d.slice(0, 4) + "00000" + d[4];
    else body = d.slice(0, 5) + "0000" + last;
    const a11 = ns + body;
    const cd = checkDigit(a11);
    return a11 + cd;
  }

  /**
   * Normalise a GTIN-8/12/13/14 (or UPC-E when format says so) to GTIN-14.
   * Returns { gtin14, valid } or null when the input isn't a GTIN-shaped number.
   */
  function normalizeGtin(code, format) {
    if (code == null) return null;
    let s = String(code).trim().replace(/[\s-]/g, "");
    if (!onlyDigits(s)) return null;
    if (format && /upc-?e/i.test(format) && (s.length === 8 || s.length === 7 || s.length === 6)) {
      const a = upcEtoA(s);
      if (!a) return null;
      const valid = s.length !== 8 || a.slice(-1) === s.slice(-1);
      return { gtin14: a.padStart(14, "0"), valid };
    }
    if (![8, 12, 13, 14].includes(s.length)) return null;
    return { gtin14: s.padStart(14, "0"), valid: isValidGtin(s) };
  }

  /* ---------- Dates ---------- */

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /**
   * YYMMDD → "YYYY-MM-DD". DD=00 means the last day of the month.
   * Century per GS1 GenSpecs 7.12: within -49/+50 years of the current year.
   */
  function parseGs1Date(yymmdd, now) {
    if (!/^\d{6}$/.test(yymmdd || "")) return null;
    const yy = Number(yymmdd.slice(0, 2));
    const mm = Number(yymmdd.slice(2, 4));
    let dd = Number(yymmdd.slice(4, 6));
    if (mm < 1 || mm > 12) return null;
    const cur = (now instanceof Date ? now : new Date()).getFullYear();
    const curYY = cur % 100;
    const century = cur - curYY;
    const diff = yy - curYY;
    let year = century + yy;
    if (diff >= 51) year -= 100;
    else if (diff <= -50) year += 100;
    const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
    if (dd === 0) dd = lastDay;
    if (dd > lastDay) return null;
    return `${year}-${pad2(mm)}-${pad2(dd)}`;
  }

  /* ---------- Element strings ---------- */

  const SYMBOLOGY_PREFIX = /^\](C1|e0|d2|Q3|J1)/;

  /**
   * Parse a GS1 element string where FNC1 is \u001d (GS). Returns { ais: [[ai, value]...], error }.
   */
  function parseElementString(input) {
    let s = String(input || "");
    s = s.replace(SYMBOLOGY_PREFIX, "");
    // Leading FNC1 (as GS) just marks GS1 data.
    while (s.startsWith(GS)) s = s.slice(1);
    const ais = [];
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) {
        i++;
        continue;
      }
      const two = s.slice(i, i + 2);
      if (!/^\d\d$/.test(two)) return { ais, error: `Unexpected data at position ${i + 1}` };
      const len = aiLength(two);
      const ai = s.slice(i, i + len);
      if (!/^\d+$/.test(ai) || ai.length !== len) return { ais, error: `Incomplete AI at position ${i + 1}` };
      i += len;
      const fixed = FIXED_BY_PREFIX[two];
      if (fixed) {
        const value = s.slice(i, i + fixed);
        if (value.length !== fixed || value.includes(GS)) return { ais, error: `AI (${ai}) is too short` };
        ais.push([ai, value]);
        i += fixed;
      } else {
        const max = VARIABLE_MAX[ai] || VARIABLE_MAX[two] || 90;
        let end = s.indexOf(GS, i);
        if (end === -1) end = s.length;
        if (end - i > max) end = i + max;
        ais.push([ai, s.slice(i, end)]);
        i = end;
      }
    }
    return { ais, error: null };
  }

  // "(01)09300000000000(15)261231(10)ABC" → AI pairs.
  function parseHri(input) {
    const s = String(input || "").trim();
    const re = /\((\d{2,4})\)([^(]*)/g;
    const ais = [];
    let m;
    let consumed = 0;
    let error = null;
    while ((m = re.exec(s))) {
      if (m.index !== consumed) return { ais, error: "Unexpected text between AIs" };
      const ai = m[1];
      let value = m[2].trim();
      const fixed = FIXED_BY_PREFIX[ai.slice(0, 2)];
      if (fixed && value.length > fixed) {
        error = `Ignored extra text after (${ai})`;
        value = value.slice(0, fixed);
      }
      ais.push([ai, value]);
      consumed = re.lastIndex;
    }
    if (!ais.length || consumed !== s.length) return { ais, error: "Not a GS1 bracketed string" };
    return { ais, error };
  }

  // GS1 Digital Link: path pairs /01/{gtin}/10/{lot}/21/{serial} + numeric query params (?15=YYMMDD&17=...).
  function parseDigitalLink(input) {
    let url;
    try {
      url = new URL(String(input || "").trim());
    } catch (_) {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    const segs = url.pathname.split("/").filter(Boolean).map((x) => {
      try {
        return decodeURIComponent(x);
      } catch (_) {
        return x;
      }
    });
    const start = segs.findIndex((x, i) => (x === "01" || x === "02" || x === "00" || x === "gtin") && i + 1 < segs.length);
    if (start === -1) return null;
    const ais = [];
    for (let i = start; i + 1 < segs.length; i += 2) {
      const ai = segs[i] === "gtin" ? "01" : segs[i];
      if (!/^\d{2,4}$/.test(ai)) break;
      ais.push([ai, segs[i + 1]]);
    }
    for (const [k, v] of url.searchParams) {
      if (/^\d{2,4}$/.test(k)) ais.push([k, v]);
    }
    if (!ais.length) return null;
    // The primary key must be a numeric 14-digit GTIN (8/12/13 allowed, padded) or SSCC.
    const pk = ais[0];
    if ((pk[0] === "01" || pk[0] === "02") && !normalizeGtin(pk[1])) return null;
    return { ais, error: null };
  }

  /* ---------- Main entry ---------- */

  /**
   * Interpret a scanned or typed code.
   * opts: { symbologyIdentifier, format, now, source }
   * Returns {
   *   type: "gs1" | "gtin" | "raw", raw, display,
   *   key            — lookup key for barcode links ("gtin:<14>" or "raw:<text>"),
   *   gtin14         — GTIN to link (the (01) GTIN, or the (02) contained GTIN when that's all there is),
   *   containedGtin14, count, countSource ("37" | "30" | null),
   *   bestBefore, useBy, batch, ais: {ai: value}, warnings: []
   * }
   */
  function parseCode(input, opts) {
    const o = opts || {};
    const raw = String(input == null ? "" : input);
    const res = {
      type: "raw", raw, display: raw.replace(/\u001d/g, "<GS>").trim(), key: null,
      gtin14: null, containedGtin14: null, count: null, countSource: null,
      bestBefore: null, useBy: null, batch: null, ais: {}, warnings: [],
    };
    const text = raw.replace(/[\r\n]+$/g, "").trim() || raw;
    if (!text.trim()) {
      res.warnings.push("Empty code");
      return res;
    }
    const sym = String(o.symbologyIdentifier || "");
    const symIsGs1 = /^\](C1|e0|d2|Q3)/.test(sym);
    let parsed = null;

    if (/^https?:\/\//i.test(text)) {
      parsed = parseDigitalLink(text);
      if (parsed) res.digitalLink = true;
    } else if (/^\(\d{2,4}\)/.test(text)) {
      parsed = parseHri(text);
      if (parsed.error) {
        res.warnings.push(parsed.error);
        parsed = parsed.ais.length ? parsed : null;
      }
    } else if (symIsGs1 || SYMBOLOGY_PREFIX.test(text) || text.includes(GS)) {
      parsed = parseElementString(text);
      if (parsed.error) res.warnings.push(parsed.error);
      if (!parsed.ais.length) parsed = null;
    } else if (onlyDigits(text.replace(/[\s-]/g, ""))) {
      const digits = text.replace(/[\s-]/g, "");
      const g = normalizeGtin(digits, o.format);
      if (g && !(digits.length > 14)) {
        res.type = "gtin";
        res.gtin14 = g.gtin14;
        res.key = "gtin:" + g.gtin14;
        res.display = digits;
        if (!g.valid) res.warnings.push("Check digit doesn't match — double-check the number.");
        return res;
      }
      // A long all-digit string may be a GS1 element string typed without separators.
      if (/^(01|02)\d{14}/.test(digits)) {
        const p = parseElementString(digits);
        if (!p.error && p.ais.length) parsed = p;
      }
    }

    if (!parsed) {
      res.key = "raw:" + text.trim().slice(0, 200);
      return res;
    }

    res.type = "gs1";
    for (const [ai, value] of parsed.ais) res.ais[ai] = value;
    res.display = parsed.ais.map(([ai, v]) => `(${ai})${v}`).join("");
    const a = res.ais;
    if (a["01"]) {
      const g = normalizeGtin(a["01"]);
      if (g) {
        res.gtin14 = g.gtin14;
        if (!g.valid) res.warnings.push("GTIN check digit doesn't match.");
      } else res.warnings.push("GTIN (01) isn't a valid number.");
    }
    if (a["02"]) {
      const g = normalizeGtin(a["02"]);
      if (g) {
        res.containedGtin14 = g.gtin14;
        if (!g.valid) res.warnings.push("Contained GTIN check digit doesn't match.");
      }
    }
    // (02)+(37): a carton/pallet containing N of the (02) item. (01)+(30): variable count of the (01) item.
    if (a["37"] && /^\d{1,8}$/.test(a["37"])) {
      res.count = Number(a["37"]);
      res.countSource = "37";
    } else if (a["30"] && /^\d{1,8}$/.test(a["30"])) {
      res.count = Number(a["30"]);
      res.countSource = "30";
    }
    if (a["15"]) {
      res.bestBefore = parseGs1Date(a["15"], o.now);
      if (!res.bestBefore) res.warnings.push("Best-before date (15) isn't a valid date.");
    }
    if (a["17"]) {
      res.useBy = parseGs1Date(a["17"], o.now);
      if (!res.useBy) res.warnings.push("Use-by date (17) isn't a valid date.");
    }
    if (a["10"] != null && a["10"] !== "") res.batch = a["10"].slice(0, 20);
    // What we look up: the contained item when the code describes a carton of them, else the (01) item.
    const lookup = res.containedGtin14 && res.countSource === "37" ? res.containedGtin14 : res.gtin14 || res.containedGtin14;
    res.key = lookup ? "gtin:" + lookup : "raw:" + text.trim().slice(0, 200);
    res.lookupGtin14 = lookup || null;
    return res;
  }

  return {
    GS, LABELS, checkDigit, isValidGtin, upcEtoA, normalizeGtin, parseGs1Date,
    parseElementString, parseHri, parseDigitalLink, parseCode, aiLength,
  };
});
