(() => {
  const STORAGE_KEY = "bar-restock-selection-v1";
  const STOCK_KEY = "bar-restock-stock-v1";
  const CUSTOM_KEY = "bar-restock-custom-v1";
  const HIDDEN_KEY = "bar-restock-hidden-v1";
  const PAR_KEY = "bar-restock-par-v1";
  const REMINDED_KEY = "bar-restock-reminded-v1";
  const EMAIL_TO = "arthurfaria@guarasolutions.com";
  const CATEGORIES = ["Fridge", "Bar Shelves", "Other"];
  const state = {
    catalog: [],
    catalogError: null, // message when catalog.json failed to load
    loading: true, // catalog.json not loaded yet (UI shows skeletons)
    pendingPhoto: null, // resized data URL chosen in the Add product form
    custom: [], // user-added products
    hidden: [], // static catalog ids removed locally
    selection: {}, // id -> restock qty
    stock: {}, // id -> on-hand qty
    par: {}, // id -> minimum on-hand (par)
    reminded: {}, // id -> true once low-stock email prepared
    tab: "products",
    bannerDismissed: false,
    role: null, // session role id, or null when signed out
  };

  const $ = (sel) => document.querySelector(sel);
  const ICON = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const SKELETON_ROWS = `<div aria-hidden="true">${'<div class="skeleton-row"></div>'.repeat(5)}</div>`;
  const productsRoot = $("#productsRoot");
  const stockRoot = $("#stockRoot");
  const stockSummary = $("#stockSummary");
  const parRoot = $("#parRoot");
  const parSummary = $("#parSummary");
  const restockRoot = $("#restockRoot");
  const headerBadge = $("#headerBadge");
  const tabBadge = $("#tabBadge");
  const parBadge = $("#parBadge");
  const toastEl = $("#toast");
  const btnShare = $("#btnShare");
  const lowBanner = $("#lowBanner");
  const lowBannerDetail = $("#lowBannerDetail");
  const lowBannerTitle = $("#lowBannerTitle");

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return fallback;
  }

  function loadMap(key) {
    const v = loadJson(key, {});
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }

  // Writes never throw: a full or blocked storage must not leave the UI half-updated.
  function saveJson(key, value, quiet) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      if (!quiet) showToast("Couldn’t save — storage is full or blocked");
      return false;
    }
  }

  function loadSelection() {
    state.selection = loadMap(STORAGE_KEY);
  }

  function loadStockState() {
    state.stock = loadMap(STOCK_KEY);
    const custom = loadJson(CUSTOM_KEY, []);
    state.custom = Array.isArray(custom) ? custom.filter((p) => p && p.id && p.name) : [];
    const hidden = loadJson(HIDDEN_KEY, []);
    state.hidden = Array.isArray(hidden) ? hidden : [];
    state.par = loadMap(PAR_KEY);
    state.reminded = loadMap(REMINDED_KEY);
  }

  const saveSelection = () => saveJson(STORAGE_KEY, state.selection);
  const saveStock = () => saveJson(STOCK_KEY, state.stock);
  const saveCustom = () => saveJson(CUSTOM_KEY, state.custom);
  const saveHidden = () => saveJson(HIDDEN_KEY, state.hidden);
  const savePar = () => saveJson(PAR_KEY, state.par);
  const saveReminded = () => saveJson(REMINDED_KEY, state.reminded);

  // Drop restock entries whose product no longer exists (e.g. removed from catalog.json),
  // so badges and totals match the visible list.
  function pruneSelection() {
    const ids = new Set(effectiveCatalog().map((p) => p.id));
    let changed = false;
    for (const id of Object.keys(state.selection)) {
      const q = Number(state.selection[id]);
      if (!ids.has(id) || !Number.isFinite(q) || q <= 0) {
        delete state.selection[id];
        changed = true;
      }
    }
    if (changed) saveSelection();
  }

  function groupByCategory(items) {
    return CATEGORIES.map((title) => ({
      title,
      items: items.filter((p) => (CATEGORIES.includes(p.category) ? p.category : "Other") === title),
    })).filter((g) => g.items.length);
  }

  function canEditCatalog() {
    return !state.role || ROLES[state.role].editCatalog;
  }

  function effectiveCatalog() {
    const hidden = new Set(state.hidden);
    return state.catalog.filter((p) => !hidden.has(p.id)).concat(state.custom);
  }

  function selectedCount() {
    return Object.keys(state.selection).length;
  }

  function totalUnits() {
    return Object.values(state.selection).reduce((a, b) => a + b, 0);
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  function setQty(id, qty) {
    if (qty <= 0) {
      delete state.selection[id];
    } else {
      state.selection[id] = qty;
    }
    saveSelection();
    updateBadges();
    // Refresh only the affected card if on products, else full restock
    const card = productsRoot.querySelector(`[data-id="${id}"]`);
    if (card) syncCard(card, id);
    if (state.tab === "restock") renderRestock();
  }

  function toggleSelect(id) {
    if (state.selection[id]) {
      setQty(id, 0);
    } else {
      setQty(id, 1);
    }
  }

  function syncCard(card, id) {
    const qty = state.selection[id] || 0;
    card.classList.toggle("selected", qty > 0);
    const dot = card.querySelector(".selected-dot");
    const val = card.querySelector(".qty-val");
    if (dot) dot.textContent = qty > 0 ? String(qty) : "";
    if (val) val.textContent = String(qty || 1);
  }

  function updateBadges() {
    const n = selectedCount();
    const units = totalUnits();
    headerBadge.textContent = String(units);
    headerBadge.classList.toggle("empty", units === 0);
    tabBadge.textContent = String(n);
    tabBadge.classList.toggle("show", n > 0);
    const lowN = getLowProducts().length;
    parBadge.textContent = String(lowN);
    parBadge.classList.toggle("show", lowN > 0);
    $("#btnCopy").disabled = n === 0;
    $("#btnClear").disabled = n === 0;
    if (btnShare.hidden === false) btnShare.disabled = n === 0;
  }

  function productById(id) {
    return effectiveCatalog().find((p) => p.id === id);
  }

  function countOf(map, id) {
    const n = Number(map[id] || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  const stockQty = (id) => countOf(state.stock, id);
  const parQty = (id) => countOf(state.par, id);

  function isLow(id) {
    const par = parQty(id);
    return par > 0 && stockQty(id) <= par;
  }

  function getLowProducts() {
    return effectiveCatalog().filter((p) => isLow(p.id));
  }

  function thumbMarkup(p, size) {
    if (p.custom && typeof p.image === "string" && p.image.startsWith("data:image/")) {
      const wh = size ? ` width="${size}" height="${size}"` : ` width="400" height="400"`;
      return `<img src="${escapeHtml(p.image)}" alt=""${wh} />`;
    }
    if (p.custom) {
      const letter = escapeHtml((p.name || "?").trim().charAt(0).toUpperCase() || "?");
      return `<div class="thumb-fallback" aria-hidden="true">${letter}</div>`;
    }
    const wh = size ? ` width="${size}" height="${size}"` : ` width="400" height="400"`;
    return `<img src="thumbs/${p.id}.jpg" alt="" loading="lazy"${wh} />`;
  }

  function buildLowEmail(products) {
    const lines = [
      "Low stock alert — Bar Restock",
      "────────────────────────────",
      "",
    ];
    for (const p of products) {
      lines.push(`• ${p.name}`);
      lines.push(`  On hand: ${stockQty(p.id)}  |  Par (min): ${parQty(p.id)}`);
      lines.push(`  Category: ${p.category || "Other"}`);
      lines.push("");
    }
    lines.push(`Total low: ${products.length} product${products.length === 1 ? "" : "s"}`);
    lines.push("");
    lines.push("Sent from Bar Restock app");
    const subject =
      products.length === 1
        ? `Low stock: ${products[0].name} (${stockQty(products[0].id)}/${parQty(products[0].id)})`
        : `Low stock: ${products.length} products need restocking`;
    return { subject, body: lines.join("\n") };
  }

  function openMailto(products) {
    if (!products.length) return;
    const { subject, body } = buildLowEmail(products);
    const url =
      `mailto:${encodeURIComponent(EMAIL_TO)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    // Navigate to the mailto: URL so iPad Mail opens reliably
    window.location.href = url;
  }

  function markReminded(ids) {
    let changed = false;
    for (const id of ids) {
      if (!state.reminded[id]) {
        state.reminded[id] = true;
        changed = true;
      }
    }
    if (changed) saveReminded();
  }

  function clearReminded(id) {
    if (state.reminded[id]) {
      delete state.reminded[id];
      saveReminded();
    }
  }

  function updateLowBanner() {
    const low = getLowProducts();
    updateBadges();
    if (!low.length || state.bannerDismissed) {
      lowBanner.hidden = true;
      return;
    }
    lowBanner.hidden = false;
    lowBannerTitle.textContent =
      low.length === 1 ? "Low stock" : `${low.length} products low`;
    lowBannerDetail.textContent = low
      .slice(0, 3)
      .map((p) => `${p.name} (${stockQty(p.id)}/${parQty(p.id)})`)
      .join(" · ") + (low.length > 3 ? ` · +${low.length - 3} more` : "");
    const btn = $("#btnSendReminder");
    btn.textContent = low.length === 1 ? "Send reminder" : `Send reminder (${low.length})`;
    btn.disabled = false;
  }

  function afterStockChange(id, prev, next) {
    const par = parQty(id);
    if (par > 0 && next > par) {
      clearReminded(id);
      state.bannerDismissed = false;
    }
    // Crossing downward: was above par, now at or below
    if (par > 0 && prev > par && next <= par) {
      state.bannerDismissed = false;
      const p = productById(id);
      if (p && !state.reminded[id]) {
        markReminded([id]);
        openMailto([p]);
        showToast("Email reminder ready");
      }
    }
    updateLowBanner();
    if (state.tab === "par") renderPar();
  }

  function setStock(id, qty) {
    const prev = stockQty(id);
    const next = Math.max(0, Math.floor(qty));
    if (next <= 0) delete state.stock[id];
    else state.stock[id] = next;
    saveStock();
    afterStockChange(id, prev, next);
    if (state.tab === "stock") renderStock();
  }

  function setPar(id, qty) {
    const next = Math.max(0, Math.floor(qty));
    if (next <= 0) delete state.par[id];
    else state.par[id] = next;
    savePar();
    // If raised above current stock threshold (stock now above par), clear reminded
    if (parQty(id) === 0 || stockQty(id) > parQty(id)) {
      clearReminded(id);
    }
    state.bannerDismissed = false;
    updateLowBanner();
    if (state.tab === "par") renderPar();
    if (state.tab === "stock") renderStock();
  }

  function renderProducts() {
    const groups = groupByCategory(effectiveCatalog());
    productsRoot.innerHTML = "";
    for (const g of groups) {
      const title = document.createElement("h3");
      title.className = "section-title";
      title.textContent = `${g.title} (${g.items.length})`;
      productsRoot.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "grid";
      for (const p of g.items) {
        const card = document.createElement("article");
        card.className = "product-card";
        card.dataset.id = p.id;
        card.innerHTML = `
          <span class="selected-dot"></span>
          ${thumbMarkup(p)}
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="qty-row">
            <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease">${ICON("minus")}</button>
            <span class="qty-val">1</span>
            <button type="button" class="qty-btn" data-act="inc" aria-label="Increase">${ICON("plus")}</button>
          </div>
        `;
        card.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-act]");
          if (btn) {
            e.stopPropagation();
            const act = btn.dataset.act;
            const cur = state.selection[p.id] || 0;
            if (act === "inc") setQty(p.id, Math.max(1, cur) + 1);
            else setQty(p.id, cur - 1);
            return;
          }
          toggleSelect(p.id);
        });
        syncCard(card, p.id);
        grid.appendChild(card);
      }
      productsRoot.appendChild(grid);
    }
  }

  function renderRestock() {
    const ids = Object.keys(state.selection);
    if (ids.length === 0) {
      const canPick = !state.role || ROLES[state.role].tabs.includes("products");
      const hint = canPick
        ? "Tap products on the Products tab to build your restock list."
        : "Nothing has been added to the restock list yet.";
      restockRoot.innerHTML = `
        <div class="empty-state">
          <strong>Nothing selected yet</strong>
          ${hint}
          ${canPick ? '<button type="button" class="btn btn-primary" data-goto="products">Browse products</button>' : ""}
        </div>`;
      return;
    }
    // Group by category, preserve catalog order
    const order = effectiveCatalog().map((p) => p.id);
    ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));

    const ul = document.createElement("ul");
    ul.className = "restock-list";
    for (const id of ids) {
      const p = productById(id);
      if (!p) continue;
      const qty = state.selection[id];
      const li = document.createElement("li");
      li.className = "restock-item";
      li.innerHTML = `
        ${thumbMarkup(p, 64)}
        <div class="info">
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="cat">${escapeHtml(p.category)}</div>
        </div>
        <div class="qty-row">
          <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease">${ICON("minus")}</button>
          <span class="qty-val">${qty}</span>
          <button type="button" class="qty-btn" data-act="inc" aria-label="Increase">${ICON("plus")}</button>
        </div>
      `;
      li.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cur = state.selection[id] || 0;
          if (btn.dataset.act === "inc") setQty(id, cur + 1);
          else setQty(id, cur - 1);
        });
      });
      ul.appendChild(li);
    }
    restockRoot.innerHTML = "";
    restockRoot.appendChild(ul);
  }

  function buildListText() {
    const order = effectiveCatalog().map((p) => p.id);
    const ids = Object.keys(state.selection).sort(
      (a, b) => order.indexOf(a) - order.indexOf(b)
    );
    const lines = ["Restock list", "────────────"];
    const products = ids.map(productById).filter(Boolean);
    for (const g of groupByCategory(products)) {
      lines.push(`${g.title}:`);
      lines.push(...g.items.map((p) => `  ${state.selection[p.id]}× ${p.name}`));
    }
    lines.push("");
    lines.push(`Total: ${totalUnits()} items (${selectedCount()} products)`);
    return lines.join("\n");
  }

  async function copyList() {
    const text = buildListText();
    try {
      await navigator.clipboard.writeText(text);
      showToast("List copied");
    } catch (_) {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast("List copied");
      } catch (e) {
        showToast("Copy failed — select text manually");
        alert(text);
      }
      ta.remove();
    }
  }

  async function shareList() {
    const text = buildListText();
    if (!navigator.share) return;
    try {
      await navigator.share({ title: "Bar Restock", text });
    } catch (e) {
      // AbortError means the user closed the share sheet; anything else is a real failure.
      if (e && e.name !== "AbortError") showToast("Share failed — try Copy list");
    }
  }

  function switchTab(tab) {
    const allowed = state.role ? ROLES[state.role].tabs : null;
    if (allowed && !allowed.includes(tab)) {
      // Bartenders (and any future limited role) cannot open Products or Par.
      tab = allowed.includes("stock") ? "stock" : allowed[0];
    }
    state.tab = tab;
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    $(`#panel-${tab}`).classList.add("active");
    if (tab === "restock") renderRestock();
    if (tab === "stock") renderStock();
    if (tab === "par") renderPar();
  }

  function slugify(name) {
    const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product";
    const taken = new Set(effectiveCatalog().map((p) => p.id));
    let id = "custom-" + base;
    let n = 2;
    while (taken.has(id)) id = `custom-${base}-${n++}`;
    return id;
  }

  // Returns an error message for the form, or null when the product was added.
  function addCustomProduct(name, category) {
    const clean = String(name || "").trim().replace(/\s+/g, " ");
    if (!canEditCatalog()) return null;
    if (!clean) return "Enter a product name.";
    const lower = clean.toLowerCase();
    if (effectiveCatalog().some((p) => p.name.toLowerCase() === lower)) {
      return "That product already exists.";
    }
    const cat = CATEGORIES.includes(category) ? category : "Other";
    const product = { id: slugify(clean), name: clean, category: cat, custom: true };
    if (state.pendingPhoto) product.image = state.pendingPhoto;
    state.custom.push(product);
    if (!saveJson(CUSTOM_KEY, state.custom, true)) {
      // Photos are the bulky part; fall back to saving the product without one.
      delete product.image;
      if (saveCustom()) showToast("Storage is full — saved without the photo");
    }
    clearPendingPhoto();
    renderProducts();
    renderStock();
    if (state.tab === "par") renderPar();
    showToast("Product added");
    return null;
  }

  function deleteProduct(id) {
    const p = productById(id);
    if (!p || !canEditCatalog()) return;
    if (!confirm(`Remove “${p.name}” from the catalog?`)) return;
    if (p.custom) {
      state.custom = state.custom.filter((c) => c.id !== id);
      saveCustom();
    } else if (!state.hidden.includes(id)) {
      state.hidden.push(id);
      saveHidden();
    }
    delete state.stock[id];
    saveStock();
    delete state.par[id];
    savePar();
    clearReminded(id);
    if (state.selection[id]) {
      delete state.selection[id];
      saveSelection();
    }
    renderProducts();
    if (state.tab === "restock") renderRestock();
    renderStock();
    if (state.tab === "par") renderPar();
    updateLowBanner();
    showToast("Product removed");
  }

  function restoreHidden() {
    if (!state.hidden.length || !canEditCatalog()) return;
    const n = state.hidden.length;
    if (!confirm(`Bring back ${n} removed catalog product${n === 1 ? "" : "s"}?`)) return;
    state.hidden = [];
    saveHidden();
    renderProducts();
    renderStock();
    updateLowBanner();
    showToast("Products restored");
  }

  function renderStock() {
    const items = effectiveCatalog();
    const units = items.reduce((sum, p) => sum + stockQty(p.id), 0);
    const inStock = items.filter((p) => stockQty(p.id) > 0).length;
    const lowN = items.filter((p) => isLow(p.id)).length;
    stockSummary.textContent =
      `${items.length} products · ${inStock} in stock · ${units} units` +
      (lowN ? ` · ${lowN} low` : "");
    const editable = canEditCatalog();
    $("#addProductForm").hidden = !editable;
    $("#heroAddProduct").hidden = !editable;
    const restoreBtn = $("#btnRestoreHidden");
    restoreBtn.hidden = !editable || !state.hidden.length;
    restoreBtn.textContent = `Restore removed (${state.hidden.length})`;

    stockRoot.innerHTML = "";
    if (state.loading) {
      stockRoot.innerHTML = SKELETON_ROWS;
      return;
    }
    if (state.catalogError) {
      stockRoot.innerHTML = catalogErrorMarkup();
      return;
    }
    if (!items.length) {
      stockRoot.innerHTML = `<div class="empty-state"><strong>No products</strong>${
        editable ? "Add one with the form above." : "Ask an admin to add products."
      }</div>`;
      return;
    }
    const groups = groupByCategory(items);

    for (const g of groups) {
      const title = document.createElement("h3");
      title.className = "section-title";
      title.textContent = `${g.title} (${g.items.length})`;
      stockRoot.appendChild(title);

      const ul = document.createElement("ul");
      ul.className = "restock-list";
      for (const p of g.items) {
        const qty = stockQty(p.id);
        const par = parQty(p.id);
        const low = isLow(p.id);
        const li = document.createElement("li");
        li.className = "restock-item stock-item" + (low ? " is-low" : "");
        li.dataset.id = p.id;
        const parHint = par > 0 ? ` · par ${par}` : "";
        li.innerHTML = `
          ${thumbMarkup(p, 64)}
          <div class="info">
            <div class="name">${escapeHtml(p.name)}${low ? ' <span class="low-tag">LOW</span>' : ""}</div>
            <div class="cat">${escapeHtml(p.category || "Other")}${p.custom ? " · custom" : ""}${parHint}</div>
          </div>
          <div class="stock-actions">
            <div class="qty-row">
              <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease stock"${qty <= 0 ? " disabled" : ""}>${ICON("minus")}</button>
              <span class="qty-val">${qty}</span>
              <button type="button" class="qty-btn" data-act="inc" aria-label="Increase stock">${ICON("plus")}</button>
            </div>
            ${editable ? `<button type="button" class="btn btn-danger" data-act="del" aria-label="Delete ${escapeHtml(p.name)}">${ICON("trash")}Delete</button>` : ""}
          </div>
        `;
        li.querySelectorAll("[data-act]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const act = btn.dataset.act;
            if (act === "inc") setStock(p.id, stockQty(p.id) + 1);
            else if (act === "dec") setStock(p.id, stockQty(p.id) - 1);
            else deleteProduct(p.id);
          });
        });
        ul.appendChild(li);
      }
      stockRoot.appendChild(ul);
    }
  }

  function renderPar() {
    const items = effectiveCatalog();
    const withPar = items.filter((p) => parQty(p.id) > 0).length;
    const lowN = items.filter((p) => isLow(p.id)).length;
    parSummary.textContent =
      `${withPar} of ${items.length} have a par set` +
      (lowN ? ` · ${lowN} currently low` : "");

    parRoot.innerHTML = "";
    if (state.loading) {
      parRoot.innerHTML = SKELETON_ROWS;
      return;
    }
    if (!items.length) {
      parRoot.innerHTML = `<div class="empty-state"><strong>No products</strong>Add products on the Stock tab first.</div>`;
      return;
    }
    for (const g of groupByCategory(items)) {
      const title = document.createElement("h3");
      title.className = "section-title";
      title.textContent = `${g.title} (${g.items.length})`;
      parRoot.appendChild(title);

      const ul = document.createElement("ul");
      ul.className = "restock-list";
      for (const p of g.items) {
        const par = parQty(p.id);
        const onHand = stockQty(p.id);
        const low = isLow(p.id);
        const li = document.createElement("li");
        li.className = "restock-item stock-item" + (low ? " is-low" : "");
        li.dataset.id = p.id;
        li.innerHTML = `
          ${thumbMarkup(p, 64)}
          <div class="info">
            <div class="name">${escapeHtml(p.name)}${low ? ' <span class="low-tag">LOW</span>' : ""}</div>
            <div class="cat">On hand: ${onHand}${par > 0 ? ` · min ${par}` : " · no par"}</div>
          </div>
          <div class="stock-actions">
            <div class="qty-row">
              <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease par"${par <= 0 ? " disabled" : ""}>${ICON("minus")}</button>
              <span class="qty-val">${par}</span>
              <button type="button" class="qty-btn" data-act="inc" aria-label="Increase par">${ICON("plus")}</button>
            </div>
          </div>
        `;
        li.querySelectorAll("[data-act]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const act = btn.dataset.act;
            if (act === "inc") setPar(p.id, parQty(p.id) + 1);
            else if (act === "dec") setPar(p.id, parQty(p.id) - 1);
          });
        });
        ul.appendChild(li);
      }
      parRoot.appendChild(ul);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function catalogErrorMarkup() {
    return `<div class="empty-state is-error"><strong>Couldn’t load the product list</strong>
      Check the connection and try again.
      <button type="button" class="btn btn-primary" data-retry>Retry</button></div>`;
  }


  /*
   * Login (static PWA — the PIN is in the client, not a real security boundary).
   *   Bartender: no PIN, signs in with one tap (Stock + Restock only).
   *   Admin:     PIN 1001, full app.
   * Session only: role id is kept in sessionStorage so a refresh stays signed in
   * for this tab. A new tab or browser session must sign in again.
   */
  const SESSION_KEY = "bar-restock-role-v1";
  const ROLES = {
    admin: {
      label: "Admin",
      pin: "1001",
      tabs: ["products", "stock", "par", "restock"],
      editCatalog: true,
    },
    bartender: {
      label: "Bartender",
      pin: null, // no PIN: one-tap sign-in
      tabs: ["stock", "restock"],
      editCatalog: false, // count stock only; cannot add or remove products
    },
  };
  const ALL_TABS = ["products", "stock", "par", "restock"];

  function readSessionRole() {
    try {
      const id = sessionStorage.getItem(SESSION_KEY);
      if (id && ROLES[id]) return id;
    } catch (_) {}
    return null;
  }

  function applyRole(roleId) {
    state.role = roleId && ROLES[roleId] ? roleId : null;
    Object.keys(ROLES).forEach((id) => document.body.classList.remove("role-" + id));
    // Show only the tabs this role may open (driven by ROLES, not per-role CSS).
    const allowedTabs = state.role ? ROLES[state.role].tabs : ALL_TABS;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.hidden = !allowedTabs.includes(b.dataset.tab);
    });
    $(".tab-bar").style.gridTemplateColumns = `repeat(${allowedTabs.length}, 1fr)`;
    const loginScreen = $("#loginScreen");
    const roleLabel = $("#roleLabel");
    const btnLogout = $("#btnLogout");
    if (!state.role) {
      loginScreen.hidden = false;
      roleLabel.hidden = true;
      roleLabel.textContent = "";
      btnLogout.hidden = true;
      return;
    }
    document.body.classList.add("role-" + state.role);
    loginScreen.hidden = true;
    roleLabel.hidden = false;
    roleLabel.textContent = ROLES[state.role].label;
    btnLogout.hidden = false;
    const allowed = ROLES[state.role].tabs;
    if (!allowed.includes(state.tab)) {
      switchTab(allowed.includes("stock") ? "stock" : allowed[0]);
    } else if (state.tab === "stock") {
      renderStock(); // refresh edit controls for the new role
    }
  }

  function signIn(roleId, pin) {
    const role = ROLES[roleId];
    if (!role || (role.pin !== null && String(pin || "").trim() !== role.pin)) return false;
    try {
      sessionStorage.setItem(SESSION_KEY, roleId);
    } catch (_) {}
    applyRole(roleId);
    return true;
  }

  function signOut() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {}
    applyRole(null);
    showLoginStep("choice");
  }

  // Sign-in screen has two steps: the Bartender/Admin choice, then the Admin PIN form.
  function showLoginStep(step) {
    const pin = $("#loginPin");
    $("#loginChoice").hidden = step !== "choice";
    $("#loginForm").hidden = step !== "pin";
    $("#btnLoginAdmin").setAttribute("aria-expanded", step === "pin" ? "true" : "false");
    pin.value = "";
    setFieldError(pin, $("#loginError"), null);
    if (step === "pin") pin.focus();
  }

  // Fetch the catalog. Listeners are already bound, so a failure here never
  // blocks sign-in; the error shows in the visible panel with a Retry button.
  async function loadCatalog() {
    try {
      const res = await fetch("catalog.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("catalog is not a list");
      state.catalog = data.filter((p) => p && typeof p.id === "string" && p.name);
      state.catalogError = null;
    } catch (err) {
      state.catalogError = String(err);
    }
    state.loading = false;
    pruneSelection();
    renderProducts();
    if (state.catalogError) productsRoot.innerHTML = catalogErrorMarkup();
    if (state.tab === "stock") renderStock();
    if (state.tab === "par") renderPar();
    if (state.tab === "restock") renderRestock();
    updateLowBanner();
  }

  // Product photo: downscale to a 320px square JPEG so it fits in localStorage.
  const PHOTO_SIZE = 320;
  async function onPhotoChosen(e) {
    const file = e.target.files && e.target.files[0];
    const err = $("#addProductError");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setFieldError(null, err, "That file isn’t an image.");
      e.target.value = "";
      return;
    }
    try {
      state.pendingPhoto = await resizePhoto(file);
      setFieldError(null, err, null);
      const preview = $("#newProductPreview");
      preview.src = state.pendingPhoto;
      preview.hidden = false;
      $("#btnRemovePhoto").hidden = false;
      $("#photoBtnText").textContent = "Change image";
    } catch (_) {
      clearPendingPhoto();
      setFieldError(null, err, "Couldn’t read that image. Try a JPG or PNG.");
    }
  }

  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = PHOTO_SIZE;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
        // Centre-crop to a square, like the catalog thumbnails.
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode failed"));
      };
      img.src = url;
    });
  }

  function clearPendingPhoto() {
    state.pendingPhoto = null;
    $("#newProductPhoto").value = "";
    const preview = $("#newProductPreview");
    preview.hidden = true;
    preview.removeAttribute("src");
    $("#btnRemovePhoto").hidden = true;
    $("#photoBtnText").textContent = "Upload image";
  }

  // Inline form validation: message under the field, field outlined, cleared on input.
  function setFieldError(input, msgEl, message) {
    msgEl.textContent = message || "";
    msgEl.hidden = !message;
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  // Presentation-only wiring: mobile menu, hero shortcuts, scroll reveal.
  function bindChrome() {
    const header = $("#appHeader");
    const toggle = $("#menuToggle");
    const setMenu = (open) => {
      header.classList.toggle("menu-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    toggle.addEventListener("click", () => setMenu(!header.classList.contains("menu-open")));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && header.classList.contains("menu-open")) {
        setMenu(false);
        toggle.focus();
      }
    });
    header.addEventListener("click", (e) => {
      if (e.target.closest(".tab-btn, #btnLogout")) setMenu(false);
    });
    document.addEventListener("click", (e) => {
      const go = e.target.closest("[data-goto]");
      if (!go) return;
      switchTab(go.dataset.goto);
      window.scrollTo(0, 0);
    });
    $("#heroAddProduct").addEventListener("click", () => {
      const form = $("#addProductForm");
      form.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      $("#newProductName").focus({ preventScroll: true });
    });
    const reveals = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      reveals.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    }, { rootMargin: "0px 0px -10% 0px" });
    reveals.forEach((el) => io.observe(el));
  }

  function bindEvents() {
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-retry]")) loadCatalog();
    });
    $("#btnRestoreHidden").addEventListener("click", restoreHidden);
    const catSelect = $("#newProductCategory");
    catSelect.innerHTML = CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    $("#btnCopy").addEventListener("click", copyList);
    $("#btnShare").addEventListener("click", shareList);
    $("#addProductForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#newProductName");
      const error = addCustomProduct(input.value, $("#newProductCategory").value);
      setFieldError(input, $("#addProductError"), error);
      if (!error) input.value = "";
      input.focus();
    });
    $("#newProductName").addEventListener("input", (e) => setFieldError(e.target, $("#addProductError"), null));
    $("#btnClear").addEventListener("click", () => {
      if (!selectedCount()) return;
      if (!confirm("Clear the restock list?")) return;
      state.selection = {};
      saveSelection();
      renderProducts();
      renderRestock();
      updateBadges();
      showToast("Cleared");
    });
    $("#btnSendReminder").addEventListener("click", () => {
      const targets = getLowProducts();
      if (!targets.length) return;
      markReminded(targets.map((p) => p.id));
      openMailto(targets);
      showToast("Email reminder ready");
      updateLowBanner();
    });
    $("#btnDismissBanner").addEventListener("click", () => {
      state.bannerDismissed = true;
      lowBanner.hidden = true;
    });
    $("#btnLogout").addEventListener("click", signOut);
    $("#btnLoginBartender").addEventListener("click", () => signIn("bartender"));
    $("#btnLoginAdmin").addEventListener("click", () => showLoginStep("pin"));
    $("#btnLoginBack").addEventListener("click", () => {
      showLoginStep("choice");
      $("#btnLoginAdmin").focus();
    });
    $("#loginForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const pinEl = $("#loginPin");
      const err = $("#loginError");
      const pin = pinEl.value;
      if (!pin.trim()) {
        setFieldError(pinEl, err, "Enter your PIN.");
        pinEl.focus();
        return;
      }
      if (!signIn("admin", pin)) {
        setFieldError(pinEl, err, "Wrong PIN.");
        pinEl.select();
        return;
      }
      showLoginStep("choice");
    });
    $("#newProductPhoto").addEventListener("change", onPhotoChosen);
    $("#btnRemovePhoto").addEventListener("click", clearPendingPhoto);
    $("#loginPin").addEventListener("input", (e) => setFieldError(e.target, $("#loginError"), null));
    bindChrome();

  }

  async function init() {
    loadSelection();
    loadStockState();
    if (navigator.share) btnShare.hidden = false;
    bindEvents();
    // Apply the session role before any await so restricted tabs never flash.
    applyRole(readSessionRole());
    await loadCatalog();
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (_) {}
    }
  }

  init();
})();
