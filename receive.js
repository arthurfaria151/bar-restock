/*
 * Receive delivery: scan cartons/bottles with the camera (or type the code), confirm each line,
 * then finish to add everything to Stock. Also: barcode links (admin), delivery history and
 * the "Dates to watch" card on Stock built from delivery lots.
 *
 * Loaded before app.js; app.js calls window.BarRestockReceive(api) with the helpers it shares.
 * Everything scanned or typed is untrusted: it only reaches the page through escapeHtml() or
 * textContent, and GS1 Digital Link URLs are parsed for their data, never opened.
 */
(function () {
  "use strict";

  const LINKS_KEY = "bar-restock-barcodes-v1"; // { "gtin:<GTIN-14>" | "raw:<text>": { productId, kind, packSize, code, updatedAt } }
  const DRAFT_KEY = "bar-restock-delivery-draft-v1"; // in-progress delivery { id, startedAt, items, pending }
  const DELIVERIES_KEY = "bar-restock-deliveries-v1"; // finished deliveries, newest first
  const LOTS_CLEARED_KEY = "bar-restock-lots-cleared-v1"; // { "<deliveryId>:<itemIndex>": ISO time cleared }
  const DECODER_JS = "vendor/zxing-wasm/zxing-reader.iife.js";
  const DECODER_WASM = "vendor/zxing-wasm/zxing_reader.wasm";
  const FORMATS = ["EAN13", "EAN8", "UPCA", "UPCE", "ITF", "Code128", "QRCode", "DataMatrix", "DataBar", "DataBarExp"];
  const REPEAT_MS = 2000; // the same code seen again within this window is ignored
  const SCAN_EVERY_MS = 140;
  const MAX_DELIVERIES = 300;
  const PACK_MAX = 999;
  const QTY_MAX = 99999;
  const BATCH_MAX = 20;
  const EXPIRED_SHOW_DAYS = 30; // expired lots older than this drop off the Stock card

  window.BarRestockReceive = function (api) {
    const GS1 = window.BarRestockGS1;
    const $ = (sel) => document.querySelector(sel);
    const esc = api.escapeHtml;
    const ICON = api.ICON;

    const rx = {
      view: "scan", // scan | history | links
      links: loadLinks(),
      draft: loadDraft(),
      deliveries: loadDeliveries(),
      cleared: api.loadMap(LOTS_CLEARED_KEY),
      stream: null,
      track: null,
      torchOn: false,
      starting: false,
      decoderPromise: null,
      loopTimer: null,
      decoding: false,
      seen: new Map(), // code text -> last time seen
      audio: null,
      sheet: null, // { mode: "link" | "pick" | "edit-link" | "edit-item" | "delivery", ... }
      finishing: false,
      datesOpen: false,
      lastFinished: null,
      linkSearch: "",
    };

    /* ---------- storage ---------- */

    function loadLinks() {
      const raw = api.loadMap(LINKS_KEY);
      const out = {};
      for (const [key, v] of Object.entries(raw)) {
        const clean = cleanLink(key, v);
        if (clean) out[key] = clean;
      }
      return out;
    }

    function validLinkKey(key) {
      return typeof key === "string" && (/^gtin:\d{14}$/.test(key) || /^raw:[^\u0000-\u0008]{1,200}$/.test(key));
    }

    function cleanLink(key, v) {
      if (!validLinkKey(key) || !v || typeof v !== "object") return null;
      if (typeof v.productId !== "string" || !v.productId) return null;
      const kind = v.kind === "carton" ? "carton" : "unit";
      const pack = kind === "carton" ? Number(v.packSize) : 1;
      if (!Number.isInteger(pack) || pack < (kind === "carton" ? 2 : 1) || pack > PACK_MAX) return null;
      return {
        productId: v.productId.slice(0, 120),
        kind,
        packSize: pack,
        code: typeof v.code === "string" ? v.code.slice(0, 200) : key.replace(/^(gtin|raw):/, ""),
        updatedAt: typeof v.updatedAt === "string" ? v.updatedAt.slice(0, 40) : new Date().toISOString(),
      };
    }

    function saveLinks() {
      if (api.saveJson(LINKS_KEY, rx.links)) return true;
      rx.links = loadLinks();
      return false;
    }

    function newId() {
      return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function emptyDraft() {
      return { id: newId(), startedAt: null, items: [], pending: null };
    }

    function loadDraft() {
      const raw = api.loadJson(DRAFT_KEY, null);
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return emptyDraft();
      return {
        id: typeof raw.id === "string" ? raw.id : newId(),
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
        items: raw.items.map(cleanItem).filter(Boolean),
        pending: raw.pending && typeof raw.pending === "object" ? cleanPending(raw.pending) : null,
      };
    }

    function cleanItem(it) {
      if (!it || typeof it.productId !== "string") return null;
      const qty = clampInt(it.qty, 1, QTY_MAX);
      if (!qty) return null;
      return {
        uid: typeof it.uid === "string" ? it.uid : newId(),
        productId: it.productId,
        name: String(it.name || "").slice(0, 120),
        qty,
        date: validIsoDate(it.date) ? it.date : null,
        dateKind: it.dateKind === "useBy" ? "useBy" : "bestBefore",
        batch: it.batch ? String(it.batch).slice(0, BATCH_MAX) : null,
        codes: Array.isArray(it.codes) ? it.codes.filter((c) => typeof c === "string").slice(0, 20).map((c) => c.slice(0, 200)) : [],
      };
    }

    function cleanPending(p) {
      const base = cleanItem(p);
      if (!base) return null;
      return Object.assign(base, {
        cartons: clampInt(p.cartons, 1, QTY_MAX) || 1,
        packSize: clampInt(p.packSize, 1, PACK_MAX) || 1,
        code: typeof p.code === "string" ? p.code.slice(0, 200) : "",
        warnings: Array.isArray(p.warnings) ? p.warnings.filter((w) => typeof w === "string").slice(0, 5) : [],
        oneOff: !!p.oneOff,
        fromCount: p.fromCount === "37" || p.fromCount === "30" ? p.fromCount : null,
        countValue: clampInt(p.countValue, 0, QTY_MAX),
        hadDate: !!p.hadDate,
        bestBefore: validIsoDate(p.bestBefore) ? p.bestBefore : null,
        useBy: validIsoDate(p.useBy) ? p.useBy : null,
      });
    }

    function saveDraft() {
      if (api.saveJson(DRAFT_KEY, rx.draft)) return true;
      rx.draft = loadDraft();
      return false;
    }

    function loadDeliveries() {
      const raw = api.loadJson(DELIVERIES_KEY, []);
      return Array.isArray(raw) ? raw.filter((d) => d && typeof d.id === "string" && Array.isArray(d.items)) : [];
    }

    /* ---------- small helpers ---------- */

    function clampInt(v, min, max) {
      const n = Math.floor(Number(v));
      if (v === "" || v === null || v === undefined || !Number.isFinite(n)) return null;
      return Math.min(max, Math.max(min, n));
    }

    function validIsoDate(s) {
      if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
      const [y, m, d] = s.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    }

    function todayIso() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function daysUntil(iso) {
      const [y, m, d] = iso.split("-").map(Number);
      const t = todayIso().split("-").map(Number);
      return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t[0], t[1] - 1, t[2])) / 86400000);
    }

    function fmtDate(iso) {
      if (!validIsoDate(iso)) return "";
      const [y, m, d] = iso.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
    }

    function fmtDateTime(iso) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    }

    function relDays(n) {
      if (n === 0) return "today";
      if (n === 1) return "tomorrow";
      if (n === -1) return "yesterday";
      return n > 0 ? `in ${n} days` : `${-n} days ago`;
    }

    const dateLabel = (kind) => (kind === "useBy" ? "Use by" : "Best before");
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
    const product = (id) => api.productById(id);
    const productName = (it) => (product(it.productId) || {}).name || it.name || "Removed product";

    function thumb(id, size) {
      const p = product(id);
      return p ? api.thumbMarkup(p, size) : `<div class="thumb-fallback" aria-hidden="true">?</div>`;
    }

    function codeLabel(key, link) {
      if (link && link.code) return link.code;
      return key.replace(/^(gtin|raw):/, "");
    }

    function draftUnits() {
      return rx.draft.items.reduce((s, it) => s + it.qty, 0);
    }

    /* ---------- feedback ---------- */

    function prepareAudio() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!rx.audio) rx.audio = new Ctx();
        if (rx.audio.state === "suspended") rx.audio.resume().catch(() => {});
      } catch (_) {
        rx.audio = null;
      }
    }

    function feedback(ok) {
      try {
        if (navigator.vibrate) navigator.vibrate(ok ? 60 : [40, 60, 40]);
      } catch (_) {}
      try {
        const ctx = rx.audio;
        if (ctx && ctx.state === "running") {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = "sine";
          o.frequency.value = ok ? 1760 : 440;
          g.gain.setValueAtTime(0.0001, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
          o.connect(g).connect(ctx.destination);
          o.start();
          o.stop(ctx.currentTime + 0.13);
        }
      } catch (_) {}
      const vp = $("#rxViewport");
      if (vp) {
        vp.classList.remove("flash", "flash-warn");
        void vp.offsetWidth; // restart the animation
        vp.classList.add(ok ? "flash" : "flash-warn");
      }
    }

    /* ---------- decoder + camera ---------- */

    function loadDecoder() {
      if (rx.decoderPromise) return rx.decoderPromise;
      rx.decoderPromise = new Promise((resolve, reject) => {
        const ready = () => {
          try {
            const wasmUrl = new URL(DECODER_WASM, document.baseURI).href;
            // Never fetch the wasm from a CDN: point the loader at the vendored copy (precached by the SW).
            const p = window.ZXingWASM.prepareZXingModule({
              overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
              fireImmediately: true,
            });
            Promise.resolve(p).then(() => resolve(window.ZXingWASM), reject);
          } catch (err) {
            reject(err);
          }
        };
        if (window.ZXingWASM) {
          ready();
          return;
        }
        const s = document.createElement("script");
        s.src = DECODER_JS;
        s.async = true;
        s.onload = ready;
        s.onerror = () => reject(new Error("decoder script failed to load"));
        document.head.appendChild(s);
      });
      rx.decoderPromise.catch(() => {
        rx.decoderPromise = null;
      });
      return rx.decoderPromise;
    }

    function setCamStatus(text, tone) {
      const el = $("#rxCamStatus");
      if (!el) return;
      el.textContent = text || "";
      el.hidden = !text;
      el.dataset.tone = tone || "";
    }

    async function startCamera() {
      if (!api.roleId() || !api.catalogReady()) return;
      if (rx.stream || rx.starting) return;
      prepareAudio(); // must happen inside the tap for iOS
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCamStatus("This browser can’t use the camera here. Type the code below instead.", "warn");
        return;
      }
      rx.starting = true;
      renderCamControls();
      setCamStatus("Starting camera…");
      const decoder = loadDecoder();
      decoder.catch(() => {}); // handled below
      let stage = "camera";
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (api.currentTab() !== "receive" || document.hidden || rx.view !== "scan") {
          stream.getTracks().forEach((t) => t.stop());
          setCamStatus("");
          return;
        }
        rx.stream = stream;
        rx.track = stream.getVideoTracks()[0] || null;
        const video = $("#rxVideo");
        video.srcObject = stream;
        await video.play().catch(() => {});
        stage = "decoder";
        setCamStatus("Loading scanner…");
        await decoder;
        if (!rx.stream) return;
        setCamStatus("");
        rx.seen.clear();
        scheduleScan(0);
      } catch (err) {
        stopCamera();
        const name = err && err.name;
        if (stage === "decoder") {
          setCamStatus("The scanner couldn’t load. Type the code below instead.", "warn");
        } else if (name === "NotAllowedError" || name === "SecurityError") {
          setCamStatus("Camera access is off. Allow the camera for this app in Settings, then tap Start again — or type the code below.", "warn");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setCamStatus("No camera found. Type the code below instead.", "warn");
        } else {
          setCamStatus("Couldn’t start the camera. Type the code below instead.", "warn");
        }
      } finally {
        rx.starting = false;
        renderCamControls();
      }
    }

    function stopCamera() {
      clearTimeout(rx.loopTimer);
      rx.loopTimer = null;
      if (rx.stream) rx.stream.getTracks().forEach((t) => t.stop());
      rx.stream = null;
      rx.track = null;
      rx.torchOn = false;
      const video = $("#rxVideo");
      if (video && video.srcObject) {
        try {
          video.pause();
        } catch (_) {}
        video.srcObject = null;
      }
      renderCamControls();
    }

    function torchSupported() {
      try {
        const caps = rx.track && rx.track.getCapabilities ? rx.track.getCapabilities() : null;
        return !!(caps && caps.torch);
      } catch (_) {
        return false;
      }
    }

    async function toggleTorch() {
      if (!rx.track || !torchSupported()) return;
      const next = !rx.torchOn;
      try {
        await rx.track.applyConstraints({ advanced: [{ torch: next }] });
        rx.torchOn = next;
      } catch (_) {
        api.showToast("Couldn’t switch the light");
      }
      renderCamControls();
    }

    function renderCamControls() {
      const vp = $("#rxViewport");
      if (!vp) return;
      const live = !!rx.stream;
      vp.classList.toggle("is-live", live);
      vp.classList.toggle("is-paused", live && (!!rx.draft.pending || !!rx.sheet));
      $("#rxStart").hidden = live;
      $("#rxStart").disabled = rx.starting;
      $("#rxStop").hidden = !live;
      const torch = $("#rxTorch");
      torch.hidden = !live || !torchSupported();
      torch.setAttribute("aria-pressed", rx.torchOn ? "true" : "false");
      torch.querySelector("span").textContent = rx.torchOn ? "Light on" : "Light";
      $("#rxHint").textContent = live
        ? rx.draft.pending
          ? "Paused — add or skip the scanned item to keep going."
          : "Hold a barcode inside the frame. It reads automatically."
        : "";
    }

    function scheduleScan(delay) {
      clearTimeout(rx.loopTimer);
      rx.loopTimer = setTimeout(scanFrame, delay);
    }

    async function scanFrame() {
      rx.loopTimer = null;
      const video = $("#rxVideo");
      if (!rx.stream || !video || rx.decoding) return;
      const busy = !!rx.draft.pending || !!rx.sheet;
      if (video.readyState >= 2 && video.videoWidth) {
        rx.decoding = true;
        try {
          const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
          const w = Math.round(video.videoWidth * scale);
          const h = Math.round(video.videoHeight * scale);
          const canvas = rx.canvas || (rx.canvas = document.createElement("canvas"));
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(video, 0, 0, w, h);
          const results = await window.ZXingWASM.readBarcodes(ctx.getImageData(0, 0, w, h), {
            formats: FORMATS,
            tryHarder: true,
            maxNumberOfSymbols: 1,
            textMode: "HRI", // GS1 data arrives as "(01)…(17)…", which gs1.js parses
          });
          const hit = results.find((r) => r.isValid && r.text);
          if (hit) onDecoded(hit, busy);
        } catch (_) {
          // a bad frame is not fatal; try the next one
        } finally {
          rx.decoding = false;
        }
      }
      if (rx.stream) scheduleScan(busy ? SCAN_EVERY_MS * 3 : SCAN_EVERY_MS);
    }

    function onDecoded(hit, busy) {
      const now = Date.now();
      const last = rx.seen.get(hit.text) || 0;
      rx.seen.delete(hit.text);
      rx.seen.set(hit.text, now);
      if (rx.seen.size > 50) rx.seen.delete(rx.seen.keys().next().value);
      // While an item waits for confirmation we only remember what's in view; and a code that was
      // seen less than ~2s ago (e.g. still in front of the camera) is not read again.
      if (busy || now - last < REPEAT_MS) return;
      handleCode(hit.text, { format: hit.format, symbologyIdentifier: hit.symbologyIdentifier, source: "camera" });
    }

    /* ---------- code handling ---------- */

    function handleCode(text, meta) {
      if (!api.roleId() || !api.catalogReady()) return false;
      const parsed = GS1.parseCode(text, { format: meta.format, symbologyIdentifier: meta.symbologyIdentifier, now: new Date() });
      if (!parsed.key) {
        feedback(false);
        api.showToast("Nothing to read in that code");
        return false;
      }
      // Web links (including GS1 Digital Link) are only read as data here — never opened.
      const link = rx.links[parsed.key];
      const p = link ? product(link.productId) : null;
      feedback(true);
      if (link && p) setPending(buildPending(parsed, link, p, false));
      else openUnknown(parsed, !!link && !p);
      return true;
    }

    function buildPending(parsed, link, p, oneOff) {
      const pack = link && link.kind === "carton" ? link.packSize : 1;
      let cartons = 1;
      let qty = pack;
      if (parsed.countSource === "37") {
        // (02)+(37): N of the contained item; each is a carton of `pack` when that item is linked as a carton.
        cartons = parsed.count;
        qty = parsed.count * pack;
      } else if (parsed.countSource === "30") {
        // (01)+(30): variable count — the count is the number of items.
        qty = parsed.count;
        cartons = pack > 1 ? Math.max(1, Math.round(qty / pack)) : qty;
      }
      const date = parsed.useBy || parsed.bestBefore || null;
      return {
        uid: newId(),
        productId: p.id,
        name: p.name,
        qty: Math.max(1, Math.min(QTY_MAX, qty)),
        cartons: Math.max(1, Math.min(QTY_MAX, cartons)),
        packSize: pack,
        date,
        dateKind: parsed.useBy ? "useBy" : "bestBefore",
        hadDate: !!date,
        bestBefore: parsed.bestBefore,
        useBy: parsed.useBy,
        batch: parsed.batch ? parsed.batch.slice(0, BATCH_MAX) : null,
        code: parsed.display.slice(0, 200),
        codes: [parsed.display.slice(0, 200)],
        warnings: parsed.warnings.slice(0, 5),
        oneOff: !!oneOff,
        fromCount: parsed.countSource,
        countValue: parsed.count,
      };
    }

    function setPending(item) {
      rx.draft.pending = item;
      if (!rx.draft.startedAt) rx.draft.startedAt = new Date().toISOString();
      rx.lastFinished = null;
      if (!saveDraft()) return;
      renderPending();
      renderDraft();
      renderCamControls();
      const card = $("#rxConfirm");
      if (card && window.matchMedia("(max-width: 899px)").matches) {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    /* ---------- unknown codes: link (manager) or pick once (staff) ---------- */

    function kindFieldset(packValue) {
      return `
        <fieldset class="field rx-kind">
          <legend class="field-label">This barcode is on</legend>
          <div class="segmented" role="radiogroup" aria-label="Barcode is on">
            <button type="button" class="seg" role="radio" data-rx-kind="unit" aria-checked="true">A single unit</button>
            <button type="button" class="seg" role="radio" data-rx-kind="carton" aria-checked="false">A carton or pack</button>
          </div>
          <div class="rx-pack" hidden>
            <label class="field-label" for="rxPackSize">Units per carton</label>
            <input id="rxPackSize" class="input rx-pack-input" type="number" inputmode="numeric" min="2" max="${PACK_MAX}" value="${packValue}" />
          </div>
        </fieldset>`;
    }

    function pickerMarkup() {
      return `
        <div class="picker-search">
          ${ICON("search")}
          <input id="rxPickerSearch" class="input" type="search" placeholder="Search products" autocomplete="off" enterkeyhint="search" aria-label="Search products" />
        </div>
        <div id="rxPickerResults"></div>`;
    }

    function openUnknown(parsed, productGone) {
      const manager = api.isManager();
      rx.sheet = { mode: manager ? "link" : "pick", parsed, kind: "unit", packSize: 24, selected: null };
      rx.linkSearch = "";
      const codeLine = `<div class="rx-code"><span class="rx-code-label">Code</span><code>${esc(parsed.display)}</code></div>`;
      const describes = parsed.countSource === "37"
        ? `<p class="rx-sheet-note">This carton label holds ${esc(parsed.count)} of item <code>${esc(parsed.containedGtin14)}</code> — link that item.</p>`
        : "";
      const gone = productGone ? `<p class="rx-sheet-note">This barcode was linked to a product that has since been removed.</p>` : "";
      const warn = parsed.warnings.length ? `<p class="rx-warn">${ICON("alert")}<span>${esc(parsed.warnings.join(" "))}</span></p>` : "";
      if (manager) {
        api.openSheet("Link this barcode", `
          ${codeLine}${describes}${gone}${warn}
          ${kindFieldset(24)}
          <p class="field-label rx-pick-label">Which product is it?</p>
          ${pickerMarkup()}
          <div class="rx-sheet-actions"><button type="button" class="btn btn-primary btn-block" data-rx-act="link-save" disabled>Choose a product</button></div>`);
      } else {
        api.openSheet("Unknown barcode", `
          <div class="rx-ask">${ICON("lock")}<div><strong>This barcode isn’t linked yet — ask a manager to link it.</strong>Until then, pick the product below. It’s used for this delivery only and the barcode won’t be remembered.</div></div>
          ${codeLine}${warn}
          ${pickerMarkup()}`);
      }
      renderPickerResults();
      syncLinkSheet();
      renderCamControls();
    }

    function renderPickerResults() {
      const box = $("#rxPickerResults");
      if (!box || !rx.sheet) return;
      const q = rx.linkSearch.trim().toLowerCase();
      const items = api.effectiveCatalog().filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.category || "").toLowerCase().includes(q));
      if (!items.length) {
        box.innerHTML = `<p class="picker-empty">No products match “${esc(q)}”.</p>`;
        return;
      }
      const sel = rx.sheet.selected;
      const action = rx.sheet.mode === "pick" ? "Use once" : "Select";
      box.innerHTML = api.groupByCategory(items).map((g) => `
        <h3 class="picker-group">${esc(g.title)}</h3>
        <ul class="picker-list">${g.items.map((p) => `<li><button type="button" class="picker-item${sel === p.id ? " is-selected" : ""}" data-rpick="${esc(p.id)}" aria-pressed="${sel === p.id ? "true" : "false"}">
          ${api.thumbMarkup(p, 44)}
          <span class="picker-name">${esc(p.name)}</span>
          <span class="picker-state">${sel === p.id ? `${ICON("check")}Selected` : action}</span>
        </button></li>`).join("")}</ul>`).join("");
    }

    function syncLinkSheet() {
      const s = rx.sheet;
      if (!s || (s.mode !== "link" && s.mode !== "edit-link")) return;
      document.querySelectorAll("[data-rx-kind]").forEach((b) => b.setAttribute("aria-checked", b.dataset.rxKind === s.kind ? "true" : "false"));
      const pack = $(".rx-pack");
      if (pack) pack.hidden = s.kind !== "carton";
      const btn = document.querySelector('[data-rx-act="link-save"]');
      if (btn) {
        const p = s.selected ? product(s.selected) : null;
        btn.disabled = !p;
        const what = s.kind === "carton" ? `carton of ${s.packSize}` : "single unit";
        btn.textContent = p
          ? s.mode === "edit-link" ? `Save · ${p.name}, ${what}` : `Link to ${p.name} · ${what}`
          : "Choose a product";
      }
    }

    function readPackSize() {
      const input = $("#rxPackSize");
      return input ? clampInt(input.value, 1, PACK_MAX) : null;
    }

    function saveLinkFromSheet() {
      const s = rx.sheet;
      if (!s || !api.isManager()) return;
      const p = product(s.selected);
      if (!p) return;
      let pack = 1;
      if (s.kind === "carton") {
        pack = readPackSize();
        if (!pack || pack < 2) {
          api.showToast("Enter how many units are in the carton (2 or more)");
          const input = $("#rxPackSize");
          if (input) input.focus();
          return;
        }
      }
      const key = s.mode === "edit-link" ? s.key : s.parsed.key;
      const prev = rx.links[key];
      rx.links[key] = {
        productId: p.id,
        kind: s.kind,
        packSize: pack,
        code: s.mode === "edit-link" ? codeLabel(key, prev) : linkCodeLabel(s.parsed),
        updatedAt: new Date().toISOString(),
      };
      if (!saveLinks()) return;
      const mode = s.mode;
      const parsed = s.parsed;
      rx.sheet = null;
      api.closeSheet();
      if (mode === "edit-link") {
        api.showToast("Barcode link saved");
        renderLinks();
      } else {
        api.showToast(`Linked to ${p.name}`);
        setPending(buildPending(parsed, rx.links[key], p, false));
      }
    }

    // What the admin list shows for a link: the GTIN as printed (no padding zeros), or the raw text.
    function linkCodeLabel(parsed) {
      if (parsed.key.startsWith("gtin:")) {
        const g = parsed.key.slice(5);
        return g.startsWith("0") ? g.slice(1) : g;
      }
      return parsed.display.slice(0, 200);
    }

    function pickOnce(id) {
      const s = rx.sheet;
      const p = product(id);
      if (!s || !p) return;
      const parsed = s.parsed;
      rx.sheet = null;
      api.closeSheet();
      setPending(buildPending(parsed, null, p, true));
    }

    function openEditLink(key) {
      if (!api.isManager()) return;
      const link = rx.links[key];
      if (!link) return;
      const packValue = link.kind === "carton" ? link.packSize : 24;
      rx.sheet = { mode: "edit-link", key, kind: link.kind, packSize: packValue, selected: product(link.productId) ? link.productId : null };
      rx.linkSearch = "";
      api.openSheet("Edit barcode link", `
        <div class="rx-code"><span class="rx-code-label">Code</span><code>${esc(codeLabel(key, link))}</code></div>
        ${kindFieldset(packValue)}
        <p class="field-label rx-pick-label">Product</p>
        ${pickerMarkup()}
        <div class="rx-sheet-actions"><button type="button" class="btn btn-primary btn-block" data-rx-act="link-save">Save</button></div>`);
      renderPickerResults();
      syncLinkSheet();
      const sel = document.querySelector("#rxPickerResults .is-selected");
      if (sel) sel.scrollIntoView({ block: "center" });
    }

    /* ---------- confirm card ---------- */

    function renderPending() {
      const box = $("#rxConfirm");
      if (!box) return;
      const it = rx.draft.pending;
      const p = it ? product(it.productId) : null;
      if (it && !p && api.catalogReady()) {
        rx.draft.pending = null;
        saveDraft();
      }
      $("#rxIdle").hidden = !!p;
      if (!p) {
        box.hidden = true;
        box.innerHTML = "";
        return;
      }
      box.hidden = false;
      const carton = it.packSize > 1;
      const both = it.useBy && it.bestBefore && it.useBy !== it.bestBefore;
      const countNote = it.fromCount === "37"
        ? `Carton label says ${plural(it.countValue, "item")}${carton ? ` of ${it.packSize}` : ""}.`
        : it.fromCount === "30" ? `Label says ${plural(it.countValue, "item")}.` : "";
      box.innerHTML = `
        <div class="rx-confirm-head">
          <div class="rx-confirm-thumb">${api.thumbMarkup(p, 96)}</div>
          <div class="rx-confirm-title">
            <div class="rx-eyebrow">${it.oneOff ? "This delivery only · not linked" : carton ? `Carton of ${esc(it.packSize)}` : "Single unit"}</div>
            <h3 class="card-title">${esc(p.name)}</h3>
            <div class="rx-confirm-code"><code>${esc(it.code)}</code></div>
          </div>
        </div>
        ${it.warnings.length ? `<p class="rx-warn">${ICON("alert")}<span>${esc(it.warnings.join(" "))}</span></p>` : ""}
        <div class="rx-qty-block">
          ${carton ? `
          <div class="rx-qty-line">
            <span class="rx-qty-label">Cartons</span>
            <div class="qty-row">
              <button type="button" class="qty-btn" data-rx-act="cartons-dec" aria-label="One carton fewer"${it.cartons <= 1 ? " disabled" : ""}>${ICON("minus")}</button>
              <input class="qty-input" id="rxCartons" type="number" inputmode="numeric" min="1" max="${QTY_MAX}" value="${it.cartons}" aria-label="Cartons" />
              <button type="button" class="qty-btn" data-rx-act="cartons-inc" aria-label="One more carton">${ICON("plus")}</button>
            </div>
            <span class="rx-times">× ${esc(it.packSize)}</span>
          </div>` : ""}
          <div class="rx-qty-line">
            <span class="rx-qty-label">${carton ? "Units" : "Quantity"}</span>
            <div class="qty-row">
              <button type="button" class="qty-btn" data-rx-act="qty-dec" aria-label="One fewer"${it.qty <= 1 ? " disabled" : ""}>${ICON("minus")}</button>
              <input class="qty-input" id="rxQty" type="number" inputmode="numeric" min="1" max="${QTY_MAX}" value="${it.qty}" aria-label="Units to add" />
              <button type="button" class="qty-btn" data-rx-act="qty-inc" aria-label="One more">${ICON("plus")}</button>
            </div>
          </div>
          ${countNote ? `<p class="rx-count-note">${esc(countNote)}</p>` : ""}
        </div>
        <div class="rx-date-row">
          <div class="field">
            <label class="field-label" for="rxDate">${it.hadDate ? `${dateLabel(it.dateKind)} <span class="rx-from-label">from label</span>` : `Best-before or use-by <span class="field-optional">(optional — skip if none)</span>`}</label>
            <div class="rx-date-inputs">
              <input id="rxDate" class="input" type="date" value="${it.date ? esc(it.date) : ""}" />
              <select id="rxDateKind" class="input" aria-label="Date type">
                <option value="bestBefore"${it.dateKind === "bestBefore" ? " selected" : ""}>Best before</option>
                <option value="useBy"${it.dateKind === "useBy" ? " selected" : ""}>Use by</option>
              </select>
            </div>
            ${both ? `<p class="rx-date-note">Label also shows best before ${esc(fmtDate(it.bestBefore))} — tracking the use-by date.</p>` : ""}
          </div>
          ${it.batch ? `<div class="rx-batch"><span class="field-label">Batch / lot</span><span class="rx-batch-val">${esc(it.batch)}</span></div>` : ""}
        </div>
        <div class="rx-confirm-actions">
          <button type="button" class="btn btn-ghost" data-rx-act="skip">Skip</button>
          <button type="button" class="btn btn-primary" data-rx-act="confirm">${ICON("plus")}<span>Add ${esc(plural(it.qty, "unit"))}</span></button>
        </div>`;
    }

    function updatePending(change) {
      const it = rx.draft.pending;
      if (!it) return;
      change(it);
      it.cartons = clampInt(it.cartons, 1, QTY_MAX) || 1;
      it.qty = clampInt(it.qty, 1, QTY_MAX) || 1;
      return saveDraft();
    }

    function sameLine(a, b) {
      return a.productId === b.productId && (a.date || null) === (b.date || null) && (a.batch || null) === (b.batch || null);
    }

    function confirmPending() {
      if (!api.roleId()) return;
      const it = rx.draft.pending;
      if (!it) return;
      const qtyEl = $("#rxQty");
      if (qtyEl) {
        const q = clampInt(qtyEl.value, 1, QTY_MAX);
        if (!q) {
          api.showToast("Enter how many units arrived");
          qtyEl.focus();
          return;
        }
        it.qty = q;
      }
      const dateEl = $("#rxDate");
      if (dateEl) it.date = validIsoDate(dateEl.value) ? dateEl.value : null;
      const kindEl = $("#rxDateKind");
      if (kindEl) it.dateKind = kindEl.value === "useBy" ? "useBy" : "bestBefore";
      const merged = rx.draft.items.find((x) => sameLine(x, it));
      if (merged) {
        merged.qty = Math.min(QTY_MAX, merged.qty + it.qty);
        if (it.code && !merged.codes.includes(it.code)) merged.codes.push(it.code);
        if (it.date) merged.dateKind = it.dateKind;
      } else {
        rx.draft.items.unshift({
          uid: it.uid,
          productId: it.productId,
          name: it.name,
          qty: it.qty,
          date: it.date,
          dateKind: it.dateKind,
          batch: it.batch,
          codes: it.code ? [it.code] : [],
        });
      }
      const name = productName(it);
      rx.draft.pending = null;
      if (!saveDraft()) return;
      renderPending();
      renderDraft();
      renderCamControls();
      api.showToast(merged ? `${name}: now ${merged.qty}` : `Added ${it.qty} × ${name}`);
    }

    function skipPending() {
      if (!api.roleId()) return;
      rx.draft.pending = null;
      if (!saveDraft()) return;
      renderPending();
      renderDraft();
      renderCamControls();
    }

    /* ---------- delivery list ---------- */

    function renderDraft() {
      const box = $("#rxDraft");
      if (!box) return;
      const items = rx.draft.items;
      const units = draftUnits();
      $("#rxDraftSummary").textContent = items.length
        ? `${plural(items.length, "line")} · ${plural(units, "unit")}`
        : "Nothing added yet";
      const finish = $("#rxFinish");
      finish.disabled = !items.length || rx.finishing;
      finish.querySelector("span").textContent = items.length ? `Finish delivery · ${plural(units, "unit")}` : "Finish delivery";
      $("#rxDiscard").hidden = !items.length;
      if (!items.length) {
        box.innerHTML = rx.lastFinished
          ? `<div class="rx-done">${ICON("check")}<div><strong>Delivery saved.</strong> ${esc(plural(rx.lastFinished.units, "unit"))} added to Stock. <button type="button" class="btn-link" data-rx-act="view-last">View it in History</button></div></div>`
          : `<p class="rx-empty">Each item you add lands here. Nothing changes in Stock until you finish the delivery.</p>`;
        return;
      }
      box.innerHTML = `<ul class="restock-list rx-list">${items.map((it) => {
        const meta = [];
        if (it.date) meta.push(`${dateLabel(it.dateKind)} ${esc(fmtDate(it.date))}`);
        if (it.batch) meta.push(`Batch ${esc(it.batch)}`);
        if (!meta.length) meta.push("No date");
        return `<li class="restock-item rx-item" data-uid="${esc(it.uid)}">
          ${thumb(it.productId, 56)}
          <button type="button" class="info rx-item-info" data-rx-act="edit-item" aria-label="Edit ${esc(productName(it))}">
            <span class="name">${esc(productName(it))}</span>
            <span class="cat">${meta.join(" · ")}</span>
          </button>
          <div class="qty-row">
            <button type="button" class="qty-btn" data-rx-act="item-dec" aria-label="One fewer ${esc(productName(it))}"${it.qty <= 1 ? " disabled" : ""}>${ICON("minus")}</button>
            <span class="qty-val">${it.qty}</span>
            <button type="button" class="qty-btn" data-rx-act="item-inc" aria-label="One more ${esc(productName(it))}">${ICON("plus")}</button>
          </div>
          <button type="button" class="icon-btn rx-remove" data-rx-act="item-remove" aria-label="Remove ${esc(productName(it))}">${ICON("trash")}</button>
        </li>`;
      }).join("")}</ul>`;
    }

    function itemByUid(uid) {
      return rx.draft.items.find((x) => x.uid === uid);
    }

    function openEditItem(uid) {
      const it = itemByUid(uid);
      if (!it) return;
      rx.sheet = { mode: "edit-item", uid };
      api.openSheet(productName(it), `
        <form class="rx-edit-form" data-rx-form="edit-item" novalidate>
          <div class="field">
            <label class="field-label" for="rxEditQty">Units</label>
            <input id="rxEditQty" class="input" type="number" inputmode="numeric" min="1" max="${QTY_MAX}" value="${it.qty}" />
          </div>
          <div class="field">
            <label class="field-label" for="rxEditDate">Date <span class="field-optional">(optional)</span></label>
            <div class="rx-date-inputs">
              <input id="rxEditDate" class="input" type="date" value="${it.date ? esc(it.date) : ""}" />
              <select id="rxEditKind" class="input" aria-label="Date type">
                <option value="bestBefore"${it.dateKind === "bestBefore" ? " selected" : ""}>Best before</option>
                <option value="useBy"${it.dateKind === "useBy" ? " selected" : ""}>Use by</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="rxEditBatch">Batch / lot <span class="field-optional">(optional)</span></label>
            <input id="rxEditBatch" class="input" type="text" maxlength="${BATCH_MAX}" value="${it.batch ? esc(it.batch) : ""}" autocomplete="off" />
          </div>
          ${it.codes.length ? `<p class="rx-sheet-note">Scanned: ${it.codes.map((c) => `<code>${esc(c)}</code>`).join(" ")}</p>` : ""}
          <div class="rx-sheet-actions rx-sheet-actions-row">
            <button type="button" class="btn btn-danger" data-rx-act="sheet-remove">${ICON("trash")}Remove</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>`);
      renderCamControls();
    }

    function saveEditItem() {
      const s = rx.sheet;
      const it = s && itemByUid(s.uid);
      if (!it) return;
      const qty = clampInt($("#rxEditQty").value, 1, QTY_MAX);
      if (!qty) {
        api.showToast("Enter a quantity of 1 or more");
        return;
      }
      const date = $("#rxEditDate").value;
      it.qty = qty;
      it.date = validIsoDate(date) ? date : null;
      it.dateKind = $("#rxEditKind").value === "useBy" ? "useBy" : "bestBefore";
      it.batch = $("#rxEditBatch").value.trim().slice(0, BATCH_MAX) || null;
      // Editing can make two lines identical: merge them.
      const twin = rx.draft.items.find((x) => x !== it && sameLine(x, it));
      if (twin) {
        twin.qty = Math.min(QTY_MAX, twin.qty + it.qty);
        twin.codes = Array.from(new Set(twin.codes.concat(it.codes))).slice(0, 20);
        rx.draft.items = rx.draft.items.filter((x) => x !== it);
      }
      if (!saveDraft()) return;
      rx.sheet = null;
      api.closeSheet();
      renderDraft();
    }

    function removeItem(uid) {
      const it = itemByUid(uid);
      if (!it) return;
      rx.draft.items = rx.draft.items.filter((x) => x.uid !== uid);
      if (!saveDraft()) return;
      renderDraft();
      api.showToast(`Removed ${productName(it)}`);
    }

    function discardDraft() {
      if (!rx.draft.items.length) return;
      if (!confirm("Discard this delivery? Nothing has been added to stock yet.")) return;
      rx.draft = emptyDraft();
      if (!saveDraft()) return;
      renderPending();
      renderDraft();
      renderCamControls();
    }

    async function finishDelivery() {
      if (rx.finishing || !api.roleId() || !api.catalogReady()) return;
      const snapshot = JSON.stringify(rx.draft);
      const draftId = rx.draft.id;
      const items = rx.draft.items.filter((it) => product(it.productId));
      const dropped = rx.draft.items.length - items.length;
      if (!items.length) return;
      const units = items.reduce((s, it) => s + it.qty, 0);
      const msg = `Add ${plural(units, "unit")} (${plural(items.length, "line")}) to stock and save this delivery?` +
        (dropped ? `\n\n${plural(dropped, "line")} for removed products will be left out.` : "") +
        (rx.draft.pending ? "\n\nThe scanned item that hasn't been added yet will be dropped." : "");
      if (!confirm(msg)) return;
      // Guard against a second tap (or another tab) committing the same draft twice.
      rx.finishing = true;
      renderDraft();
      try {
        await api.withStorageLock(() => {
          if (!api.roleId()) return false;
          const latest = loadDeliveries();
          if (latest.some((d) => d.id === draftId)) {
            api.showToast("This delivery was already saved");
            rx.deliveries = latest;
            rx.draft = loadDraft();
            return false;
          }
          if (JSON.stringify(loadDraft()) !== snapshot) {
            rx.draft = loadDraft();
            renderPending();
            api.showToast("Delivery changed in another tab — review it before finishing");
            return false;
          }
          const record = {
            id: rx.draft.id,
            at: new Date().toISOString(),
            startedAt: rx.draft.startedAt,
            receivedBy: api.roleLabel(),
            role: api.roleId(),
            units,
            items: items.map((it) => ({
              productId: it.productId,
              name: productName(it),
              qty: it.qty,
              date: it.date,
              dateKind: it.dateKind,
              batch: it.batch,
              code: it.codes[0] || null,
              codes: it.codes,
            })),
          };
          const next = [record].concat(latest).slice(0, MAX_DELIVERIES);
          const draft = emptyDraft();
          const changes = {};
          for (const it of items) changes[it.productId] = (changes[it.productId] || 0) + it.qty;
          if (!api.addStock(changes, { [DELIVERIES_KEY]: next, [DRAFT_KEY]: draft })) return false;
          rx.deliveries = next;
          rx.draft = draft;
          rx.lastFinished = { id: record.id, units };
          stopCamera();
          setCamStatus("");
          renderPending();
          renderDatesCard();
          api.showToast(`Delivery saved — ${plural(units, "unit")} added to stock`);
          return true;
        });
      } finally {
        rx.finishing = false;
        renderDraft();
      }
    }

    /* ---------- history ---------- */

    function renderHistory() {
      const box = $("#rxHistory");
      if (!box) return;
      rx.deliveries = loadDeliveries();
      if (!rx.deliveries.length) {
        box.innerHTML = `<div class="empty-state rx-empty-state"><strong>No deliveries yet</strong>Finished deliveries show up here, newest first.</div>`;
        return;
      }
      box.innerHTML = `<ul class="restock-list rx-history">${rx.deliveries.map((d) => {
        const units = d.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
        const names = d.items.slice(0, 3).map((it) => esc(it.name || "Product")).join(", ") + (d.items.length > 3 ? ` +${d.items.length - 3} more` : "");
        return `<li><button type="button" class="rx-history-row" data-rx-act="open-delivery" data-id="${esc(d.id)}">
          <span class="rx-history-icon">${ICON("package")}</span>
          <span class="info">
            <span class="name">${esc(fmtDateTime(d.at))}</span>
            <span class="cat">${esc(plural(d.items.length, "line"))} · ${esc(plural(units, "unit"))} · ${esc(d.receivedBy || "Staff")}</span>
            <span class="cat rx-history-names">${names}</span>
          </span>
          ${ICON("chevron-right")}
        </button></li>`;
      }).join("")}</ul>`;
    }

    function openDelivery(id) {
      const d = rx.deliveries.find((x) => x.id === id);
      if (!d) return;
      rx.sheet = { mode: "delivery", id };
      const units = d.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
      api.openSheet(`Delivery · ${fmtDateTime(d.at)}`, `
        <p class="rx-sheet-note">${esc(plural(units, "unit"))} received by ${esc(d.receivedBy || "Staff")}.</p>
        <ul class="rx-detail-list">${d.items.map((it) => {
          const meta = [];
          if (it.date) meta.push(`${dateLabel(it.dateKind)} ${esc(fmtDate(it.date))}`);
          if (it.batch) meta.push(`Batch ${esc(it.batch)}`);
          return `<li>
            ${thumb(it.productId, 44)}
            <div class="info"><div class="name">${esc(it.name || "Product")}</div><div class="cat">${meta.join(" · ") || "No date"}</div>${
              it.code ? `<div class="rx-detail-code"><code>${esc(it.code)}</code></div>` : ""}</div>
            <span class="rx-detail-qty">+${esc(it.qty)}</span>
          </li>`;
        }).join("")}</ul>`);
    }

    /* ---------- barcode links (managers) ---------- */

    function renderLinks() {
      const box = $("#rxLinks");
      if (!box) return;
      if (!api.isManager()) {
        box.innerHTML = "";
        return;
      }
      rx.links = loadLinks();
      const entries = Object.entries(rx.links).sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));
      $("#rxLinksSummary").textContent = entries.length ? plural(entries.length, "linked barcode") : "No barcodes linked yet";
      $("#rxExport").disabled = !entries.length;
      if (!entries.length) {
        box.innerHTML = `<div class="empty-state rx-empty-state"><strong>No barcodes linked yet</strong>Scan an unknown barcode on the Scan tab to link it, or import a file from another device.</div>`;
        return;
      }
      box.innerHTML = `<ul class="restock-list rx-links">${entries.map(([key, l]) => {
        const p = product(l.productId);
        return `<li class="restock-item stock-item" data-key="${esc(key)}">
          ${thumb(l.productId, 56)}
          <div class="info">
            <div class="name">${p ? esc(p.name) : '<span class="rx-missing">Removed product</span>'}</div>
            <div class="cat"><code>${esc(codeLabel(key, l))}</code> · ${l.kind === "carton" ? `Carton of ${esc(l.packSize)}` : "Single unit"}</div>
          </div>
          <div class="stock-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-rx-act="link-edit">${ICON("pencil")}Edit</button>
            <button type="button" class="btn btn-danger" data-rx-act="link-delete" aria-label="Delete link for ${esc(codeLabel(key, l))}">${ICON("trash")}Delete</button>
          </div>
        </li>`;
      }).join("")}</ul>`;
    }

    function deleteLink(key) {
      if (!api.isManager() || !rx.links[key]) return;
      const l = rx.links[key];
      const p = product(l.productId);
      if (!confirm(`Delete the link for ${codeLabel(key, l)}${p ? ` (${p.name})` : ""}? Scanning it will ask for a product again.`)) return;
      delete rx.links[key];
      if (!saveLinks()) return;
      renderLinks();
      api.showToast("Link deleted");
    }

    async function exportLinks() {
      if (!api.isManager()) return;
      const data = { app: "bar-restock", type: "barcode-links", version: 1, exportedAt: new Date().toISOString(), links: rx.links };
      const json = JSON.stringify(data, null, 2) + "\n";
      const name = `bar-restock-barcodes-${todayIso()}.json`;
      if (window.BarRestockNative) {
        const button = $("#rxExport");
        button.disabled = true;
        try {
          const result = await window.BarRestockNative.shareJsonFile({
            name, contents: json, title: "Bar Restock barcode links",
          });
          if (result !== null) api.showToast("Barcode links exported");
        } catch (_) {
          api.showToast("Couldn’t export barcode links — try again");
        } finally {
          button.disabled = !Object.keys(rx.links).length;
        }
        return;
      }
      try {
        const file = new File([json], name, { type: "application/json" });
        if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "Bar Restock barcode links" });
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      api.showToast("Barcode links exported");
    }

    /*
     * Import policy — merge, file wins on conflicts: every valid entry in the file is added; when the
     * file and this device both have the same barcode, the file's link replaces this device's (the
     * person importing chose that file as the newer source). Links that are only on this device are
     * kept. Entries for products that don't exist here, or that are malformed, are skipped and counted.
     */
    function importLinksText(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        return { error: "That file isn’t valid JSON." };
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "That file doesn’t contain barcode links." };
      if (data.type !== undefined && data.type !== "barcode-links") return { error: "That file doesn’t contain barcode links." };
      const src = data.links !== undefined ? data.links : data;
      if (!src || typeof src !== "object" || Array.isArray(src)) return { error: "That file doesn’t contain barcode links." };
      const known = new Set(api.effectiveCatalog().map((p) => p.id));
      const incoming = {};
      let invalid = 0;
      let unknown = 0;
      for (const [key, v] of Object.entries(src)) {
        const clean = cleanLink(key, v);
        if (!clean) invalid++;
        else if (!known.has(clean.productId)) unknown++;
        else incoming[key] = clean;
      }
      const keys = Object.keys(incoming);
      const same = (a, b) => a.productId === b.productId && a.kind === b.kind && a.packSize === b.packSize;
      const replaced = keys.filter((k) => rx.links[k] && !same(rx.links[k], incoming[k])).length;
      const added = keys.filter((k) => !rx.links[k]).length;
      return { incoming, added, replaced, same: keys.length - added - replaced, invalid, unknown };
    }

    function showImportResult(text, tone) {
      const out = $("#rxImportResult");
      out.textContent = text;
      out.hidden = !text;
      out.dataset.tone = tone || "";
    }

    async function onImportFile(e) {
      const input = e.target;
      const file = input.files && input.files[0];
      input.value = "";
      if (!file || !api.isManager()) return;
      if (file.size > 2 * 1024 * 1024) {
        showImportResult("That file is too big to be a barcode export.", "warn");
        return;
      }
      const res = importLinksText(await file.text());
      if (res.error) {
        showImportResult(res.error, "warn");
        return;
      }
      const skipped = res.invalid + res.unknown;
      const skippedText = skipped ? ` Skipped ${skipped}: ${res.unknown} for products not on this device, ${res.invalid} invalid.` : "";
      if (!res.added && !res.replaced) {
        showImportResult(`Nothing new to import — ${res.same} already up to date.${skippedText}`, "");
        return;
      }
      const question = `Import ${plural(res.added + res.replaced, "barcode link")}?` +
        (res.replaced ? `\n\n${plural(res.replaced, "link")} already on this device will be replaced by the file's version.` : "") +
        (skipped ? `\n\n${skipped} will be skipped (${res.unknown} for products not on this device, ${res.invalid} invalid).` : "");
      if (!confirm(question)) return;
      Object.assign(rx.links, res.incoming);
      if (!saveLinks()) return;
      showImportResult(`Imported ${res.added} new, replaced ${res.replaced}, ${res.same} unchanged.${skippedText}`, "ok");
      renderLinks();
      api.showToast("Barcode links imported");
    }

    /* ---------- best-before tracking on Stock ---------- */

    function currentLots() {
      const lots = [];
      for (const d of rx.deliveries) {
        d.items.forEach((it, i) => {
          if (!it || !validIsoDate(it.date)) return;
          const key = `${d.id}:${i}`;
          if (rx.cleared[key]) return;
          const days = daysUntil(it.date);
          if (days > 14 || days < -EXPIRED_SHOW_DAYS) return;
          lots.push({ key, productId: it.productId, name: it.name, qty: Number(it.qty) || 0, date: it.date, dateKind: it.dateKind, batch: it.batch, days });
        });
      }
      lots.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name)));
      return lots;
    }

    function renderDatesCard() {
      const box = $("#datesCard");
      if (!box) return;
      rx.deliveries = loadDeliveries();
      rx.cleared = api.loadMap(LOTS_CLEARED_KEY);
      const lots = currentLots().filter((l) => product(l.productId));
      if (!lots.length) {
        box.hidden = true;
        box.innerHTML = "";
        return;
      }
      const expired = lots.filter((l) => l.days < 0);
      const week = lots.filter((l) => l.days >= 0 && l.days <= 7);
      const fortnight = lots.filter((l) => l.days > 7);
      const manager = api.isManager();
      const pills = [
        expired.length ? `<span class="dd-pill is-expired">${expired.length} expired</span>` : "",
        week.length ? `<span class="dd-pill is-week">${week.length} within 7 days</span>` : "",
        fortnight.length ? `<span class="dd-pill is-fortnight">${fortnight.length} within 14 days</span>` : "",
      ].join("");
      const group = (title, list, cls) => list.length ? `
        <h4 class="dd-group ${cls}">${title}</h4>
        <ul class="dd-list">${list.map((l) => `<li class="dd-row" data-lot="${esc(l.key)}">
          ${thumb(l.productId, 44)}
          <div class="info">
            <div class="name">${esc(productName(l))}</div>
            <div class="cat">${dateLabel(l.dateKind)} ${esc(fmtDate(l.date))} · <strong>${esc(relDays(l.days))}</strong>${l.batch ? ` · Batch ${esc(l.batch)}` : ""}</div>
          </div>
          <span class="dd-qty">${esc(plural(l.qty, "unit"))}</span>
          ${manager ? `<button type="button" class="btn btn-ghost btn-sm" data-dd-clear="${esc(l.key)}" aria-label="Clear ${esc(productName(l))} lot">Clear</button>` : ""}
        </li>`).join("")}</ul>` : "";
      box.hidden = false;
      box.classList.toggle("has-expired", expired.length > 0);
      box.innerHTML = `
        <button type="button" class="dd-head" id="datesToggle" aria-expanded="${rx.datesOpen ? "true" : "false"}" aria-controls="datesBody">
          <span class="dd-icon">${ICON("calendar")}</span>
          <span class="dd-title">Dates to watch</span>
          <span class="dd-count" aria-label="${lots.length} lots">${lots.length}</span>
          <span class="dd-pills">${pills}</span>
          <span class="dd-chevron">${ICON(rx.datesOpen ? "chevron-up" : "chevron-down")}</span>
        </button>
        <div class="dd-body" id="datesBody"${rx.datesOpen ? "" : " hidden"}>
          ${group("Expired", expired, "is-expired")}
          ${group("Within 7 days", week, "is-week")}
          ${group("Within 14 days", fortnight, "is-fortnight")}
          <p class="dd-note">From best-before and use-by dates recorded on deliveries.${manager ? " Clear a lot once it’s sold through or thrown out." : ""}</p>
        </div>`;
    }

    function clearLot(key) {
      if (!api.isManager()) return;
      rx.cleared = api.loadMap(LOTS_CLEARED_KEY);
      rx.cleared[key] = new Date().toISOString();
      if (!api.saveJson(LOTS_CLEARED_KEY, rx.cleared)) {
        rx.cleared = api.loadMap(LOTS_CLEARED_KEY);
        return;
      }
      renderDatesCard();
      api.showToast("Lot cleared");
    }

    /* ---------- views ---------- */

    function setView(view) {
      if (view === "links" && !api.isManager()) view = "scan";
      rx.view = view;
      document.querySelectorAll("[data-rx-view]").forEach((b) => {
        const on = b.dataset.rxView === view;
        b.setAttribute("aria-selected", on ? "true" : "false");
        b.classList.toggle("active", on);
      });
      $("#rxViewScan").hidden = view !== "scan";
      $("#rxViewHistory").hidden = view !== "history";
      $("#rxViewLinks").hidden = view !== "links";
      if (view !== "scan") stopCamera();
      if (view === "history") renderHistory();
      if (view === "links") renderLinks();
      if (view === "scan") {
        renderPending();
        renderDraft();
        renderCamControls();
      }
    }

    function render() {
      $("#rxSegLinks").hidden = !api.isManager();
      setView(rx.view);
    }

    function onManual(e) {
      e.preventDefault();
      const input = $("#rxManual");
      const value = input.value.trim();
      const err = $("#rxManualError");
      if (!value) {
        api.setFieldError(input, err, "Type or paste a barcode number.");
        input.focus();
        return;
      }
      if (rx.draft.pending) {
        api.setFieldError(input, err, "Add or skip the scanned item first.");
        return;
      }
      api.setFieldError(input, err, null);
      prepareAudio();
      if (handleCode(value.slice(0, 400), { source: "manual" })) input.value = "";
    }

    /* ---------- events ---------- */

    function onPanelClick(e) {
      if (!api.roleId()) return;
      const btn = e.target.closest("[data-rx-act]");
      if (!btn || btn.disabled) return;
      const act = btn.dataset.rxAct;
      const li = btn.closest("[data-uid]");
      const linkLi = btn.closest("[data-key]");
      if (act === "confirm") confirmPending();
      else if (act === "skip") skipPending();
      else if (act === "cartons-inc" || act === "cartons-dec") {
        updatePending((it) => {
          it.cartons = Math.max(1, (clampInt($("#rxCartons").value, 1, QTY_MAX) || it.cartons) + (act === "cartons-inc" ? 1 : -1));
          it.qty = it.cartons * it.packSize;
        });
        renderPending();
      } else if (act === "qty-inc" || act === "qty-dec") {
        updatePending((it) => {
          it.qty = Math.max(1, (clampInt($("#rxQty").value, 1, QTY_MAX) || it.qty) + (act === "qty-inc" ? 1 : -1));
        });
        renderPending();
      } else if ((act === "item-inc" || act === "item-dec") && li) {
        const it = itemByUid(li.dataset.uid);
        if (!it) return;
        it.qty = Math.min(QTY_MAX, Math.max(1, it.qty + (act === "item-inc" ? 1 : -1)));
        if (!saveDraft()) return;
        renderDraft();
      } else if (act === "item-remove" && li) removeItem(li.dataset.uid);
      else if (act === "edit-item" && li) openEditItem(li.dataset.uid);
      else if (act === "open-delivery") openDelivery(btn.dataset.id);
      else if (act === "view-last" && rx.lastFinished) {
        const id = rx.lastFinished.id;
        setView("history");
        openDelivery(id);
      } else if (act === "link-edit" && linkLi) openEditLink(linkLi.dataset.key);
      else if (act === "link-delete" && linkLi) deleteLink(linkLi.dataset.key);
    }

    function onPanelChange(e) {
      const t = e.target;
      if (t.id === "rxCartons") {
        updatePending((it) => {
          it.cartons = clampInt(t.value, 1, QTY_MAX) || 1;
          it.qty = it.cartons * it.packSize;
        });
        syncPendingQuantity();
      } else if (t.id === "rxQty") {
        updatePending((it) => {
          it.qty = clampInt(t.value, 1, QTY_MAX) || 1;
        });
        syncPendingQuantity();
      } else if (t.id === "rxDate") {
        updatePending((it) => {
          it.date = validIsoDate(t.value) ? t.value : null;
        });
      } else if (t.id === "rxDateKind") {
        updatePending((it) => {
          it.dateKind = t.value === "useBy" ? "useBy" : "bestBefore";
        });
      }
    }

    // Keep the original Add button mounted while a quantity input blurs on a
    // tap. Replacing it here would discard the click that follows change.
    function syncPendingQuantity() {
      const it = rx.draft.pending;
      if (!it) return;
      const cartons = $("#rxCartons");
      const qty = $("#rxQty");
      if (cartons) cartons.value = it.cartons;
      if (qty) qty.value = it.qty;
      const add = document.querySelector('#rxConfirm [data-rx-act="confirm"] span');
      if (add) add.textContent = `Add ${plural(it.qty, "unit")}`;
      const qtyDec = document.querySelector('#rxConfirm [data-rx-act="qty-dec"]');
      const cartonsDec = document.querySelector('#rxConfirm [data-rx-act="cartons-dec"]');
      if (qtyDec) qtyDec.disabled = it.qty <= 1;
      if (cartonsDec) cartonsDec.disabled = it.cartons <= 1;
    }

    function onSheetClick(e) {
      if (!rx.sheet) return;
      const pick = e.target.closest("[data-rpick]");
      if (pick) {
        if (rx.sheet.mode === "pick") pickOnce(pick.dataset.rpick);
        else if (rx.sheet.mode === "link" || rx.sheet.mode === "edit-link") {
          rx.sheet.selected = pick.dataset.rpick;
          renderPickerResults();
          syncLinkSheet();
        }
        return;
      }
      const kind = e.target.closest("[data-rx-kind]");
      if (kind) {
        rx.sheet.kind = kind.dataset.rxKind === "carton" ? "carton" : "unit";
        rx.sheet.packSize = readPackSize() || rx.sheet.packSize;
        syncLinkSheet();
        return;
      }
      const act = e.target.closest("[data-rx-act]");
      if (!act) return;
      if (act.dataset.rxAct === "link-save") saveLinkFromSheet();
      else if (act.dataset.rxAct === "sheet-remove" && rx.sheet.mode === "edit-item") {
        const uid = rx.sheet.uid;
        rx.sheet = null;
        api.closeSheet();
        removeItem(uid);
      }
    }

    function bind() {
      $("#rxStart").addEventListener("click", startCamera);
      $("#rxStop").addEventListener("click", () => {
        stopCamera();
        setCamStatus("");
      });
      $("#rxTorch").addEventListener("click", toggleTorch);
      $("#rxManualForm").addEventListener("submit", onManual);
      $("#rxManual").addEventListener("input", (e) => api.setFieldError(e.target, $("#rxManualError"), null));
      $("#rxFinish").addEventListener("click", finishDelivery);
      $("#rxDiscard").addEventListener("click", discardDraft);
      $("#rxExport").addEventListener("click", exportLinks);
      $("#rxImport").addEventListener("change", onImportFile);
      document.querySelectorAll("[data-rx-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.rxView)));

      const panel = $("#panel-receive");
      panel.addEventListener("click", onPanelClick);
      panel.addEventListener("change", onPanelChange);

      const body = $("#sheetBody");
      body.addEventListener("click", onSheetClick);
      body.addEventListener("input", (e) => {
        if (!rx.sheet) return;
        if (e.target.id === "rxPickerSearch") {
          rx.linkSearch = e.target.value;
          renderPickerResults();
        } else if (e.target.id === "rxPackSize") {
          rx.sheet.packSize = readPackSize() || rx.sheet.packSize;
          syncLinkSheet();
        }
      });
      body.addEventListener("submit", (e) => {
        if (!rx.sheet || !e.target.matches('[data-rx-form="edit-item"]')) return;
        e.preventDefault();
        saveEditItem();
      });

      $("#datesCard").addEventListener("click", (e) => {
        const clear = e.target.closest("[data-dd-clear]");
        if (clear) {
          clearLot(clear.dataset.ddClear);
          return;
        }
        if (e.target.closest("#datesToggle")) {
          rx.datesOpen = !rx.datesOpen;
          renderDatesCard();
          $("#datesToggle").focus();
        }
      });

      // Never leave the camera running in the background.
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && rx.stream) {
          stopCamera();
          setCamStatus("Camera stopped while the app was in the background. Tap Start camera to carry on.");
        }
      });
      window.addEventListener("pagehide", stopCamera);
      // Keep in sync when another tab changes links, the draft or deliveries.
      window.addEventListener("storage", (e) => {
        if (localStorage.getItem(api.transactionKey)) return;
        if (e.key === api.transactionKey || e.key === null) {
          rx.links = loadLinks();
          rx.draft = loadDraft();
          if (api.currentTab() === "receive") render();
          renderDatesCard();
          return;
        }
        if (e.key === LINKS_KEY) rx.links = loadLinks();
        if (e.key === DRAFT_KEY) {
          rx.draft = loadDraft();
          if (api.currentTab() === "receive") render();
        }
        if (e.key === DELIVERIES_KEY || e.key === LOTS_CLEARED_KEY) renderDatesCard();
      });
    }

    bind();

    return {
      onTabChange(tab) {
        if (tab !== "receive") stopCamera();
        else render();
      },
      onSheetClosed() {
        rx.sheet = null;
        renderCamControls();
      },
      onRoleChange() {
        stopCamera();
        setCamStatus("");
        rx.sheet = null;
        rx.lastFinished = null;
        showImportResult("", "");
        $("#rxSegLinks").hidden = !api.isManager();
        if (rx.view === "links" && !api.isManager()) rx.view = "scan";
        if (api.currentTab() === "receive") render();
        renderDatesCard();
      },
      onCatalogLoaded() {
        if (api.currentTab() === "receive") render();
        renderDatesCard();
      },
      renderDatesCard,
      stopCamera,
    };
  };
})();
