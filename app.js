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

  function loadSelection() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state.selection = JSON.parse(raw) || {};
    } catch (_) {
      state.selection = {};
    }
  }

  function saveSelection() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.selection));
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return fallback;
  }

  function loadStockState() {
    const stock = loadJson(STOCK_KEY, {});
    state.stock = stock && typeof stock === "object" && !Array.isArray(stock) ? stock : {};
    const custom = loadJson(CUSTOM_KEY, []);
    state.custom = Array.isArray(custom) ? custom.filter((p) => p && p.id && p.name) : [];
    const hidden = loadJson(HIDDEN_KEY, []);
    state.hidden = Array.isArray(hidden) ? hidden : [];
    const par = loadJson(PAR_KEY, {});
    state.par = par && typeof par === "object" && !Array.isArray(par) ? par : {};
    const reminded = loadJson(REMINDED_KEY, {});
    state.reminded = reminded && typeof reminded === "object" && !Array.isArray(reminded) ? reminded : {};
  }

  function saveStock() {
    localStorage.setItem(STOCK_KEY, JSON.stringify(state.stock));
  }

  function saveCustom() {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(state.custom));
  }

  function saveHidden() {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(state.hidden));
  }

  function savePar() {
    localStorage.setItem(PAR_KEY, JSON.stringify(state.par));
  }

  function saveReminded() {
    localStorage.setItem(REMINDED_KEY, JSON.stringify(state.reminded));
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

  function stockQty(id) {
    const n = Number(state.stock[id] || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function parQty(id) {
    const n = Number(state.par[id] || 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function isLow(id) {
    const par = parQty(id);
    return par > 0 && stockQty(id) <= par;
  }

  function getLowProducts() {
    return effectiveCatalog().filter((p) => isLow(p.id));
  }

  function thumbMarkup(p, size) {
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
    // Use location.assign so iPad Mail opens reliably
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
    const items = effectiveCatalog();
    const groups = CATEGORIES.map((title) => ({
      title,
      items: items.filter((p) => (p.category || "Other") === title),
    })).filter((g) => g.items.length);
    productsRoot.innerHTML = "";
    for (const g of groups) {
      const title = document.createElement("div");
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
            <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease">−</button>
            <span class="qty-val">1</span>
            <button type="button" class="qty-btn" data-act="inc" aria-label="Increase">+</button>
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
          <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease">−</button>
          <span class="qty-val">${qty}</span>
          <button type="button" class="qty-btn" data-act="inc" aria-label="Increase">+</button>
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
    let fridge = [], bar = [], other = [];
    for (const id of ids) {
      const p = productById(id);
      if (!p) continue;
      const line = `${state.selection[id]}× ${p.name}`;
      if (p.category === "Fridge") fridge.push(line);
      else if (p.category === "Bar Shelves") bar.push(line);
      else other.push(line);
    }
    if (fridge.length) {
      lines.push("Fridge:");
      lines.push(...fridge.map((l) => "  " + l));
    }
    if (bar.length) {
      lines.push("Bar Shelves:");
      lines.push(...bar.map((l) => "  " + l));
    }
    if (other.length) {
      lines.push("Other:");
      lines.push(...other.map((l) => "  " + l));
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
      if (e && e.name !== "AbortError") showToast("Share cancelled");
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

  function addCustomProduct(name, category) {
    const clean = String(name || "").trim().replace(/\s+/g, " ");
    if (!clean) return;
    const cat = CATEGORIES.includes(category) ? category : "Other";
    const product = { id: slugify(clean), name: clean, category: cat, custom: true };
    state.custom.push(product);
    saveCustom();
    renderProducts();
    renderStock();
    if (state.tab === "par") renderPar();
    showToast("Product added");
  }

  function deleteProduct(id) {
    const p = productById(id);
    if (!p) return;
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
    updateBadges();
    showToast("Product removed");
  }

  function renderStock() {
    const items = effectiveCatalog();
    const units = items.reduce((sum, p) => sum + stockQty(p.id), 0);
    const inStock = items.filter((p) => stockQty(p.id) > 0).length;
    const lowN = items.filter((p) => isLow(p.id)).length;
    stockSummary.textContent =
      `${items.length} products · ${inStock} in stock · ${units} units` +
      (lowN ? ` · ${lowN} low` : "");

    stockRoot.innerHTML = "";
    if (!items.length) {
      stockRoot.innerHTML = `<div class="empty-state"><strong>No products</strong>Add one with the form above.</div>`;
      return;
    }
    const groups = CATEGORIES.map((title) => ({
      title,
      items: items.filter((p) => (p.category || "Other") === title),
    })).filter((g) => g.items.length);

    for (const g of groups) {
      const title = document.createElement("div");
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
              <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease stock"${qty <= 0 ? " disabled" : ""}>−</button>
              <span class="qty-val">${qty}</span>
              <button type="button" class="qty-btn" data-act="inc" aria-label="Increase stock">+</button>
            </div>
            <button type="button" class="btn btn-danger" data-act="del">Delete</button>
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
    if (!items.length) {
      parRoot.innerHTML = `<div class="empty-state"><strong>No products</strong>Add products on the Stock tab first.</div>`;
      return;
    }
    const groups = CATEGORIES.map((title) => ({
      title,
      items: items.filter((p) => (p.category || "Other") === title),
    })).filter((g) => g.items.length);

    for (const g of groups) {
      const title = document.createElement("div");
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
              <button type="button" class="qty-btn" data-act="dec" aria-label="Decrease par"${par <= 0 ? " disabled" : ""}>−</button>
              <span class="qty-val">${par}</span>
              <button type="button" class="qty-btn" data-act="inc" aria-label="Increase par">+</button>
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
      .replace(/"/g, "&quot;");
  }


  /*
   * Login (static PWA — PINs are in the client, not a real security boundary).
   * Default PINs:
   *   Venue manager:            1001
   *   Venue assistant manager:  2002
   *   Shift supervisor:         3003
   *   Bartenders:               4004
   * Session only: role id is kept in sessionStorage so a refresh stays signed in
   * for this tab. A new tab or browser session must sign in again.
   */
  const SESSION_KEY = "bar-restock-role-v1";
  const ROLES = {
    manager: {
      label: "Venue manager",
      pin: "1001",
      tabs: ["products", "stock", "par", "restock"],
    },
    assistant: {
      label: "Venue assistant manager",
      pin: "2002",
      tabs: ["products", "stock", "par", "restock"],
    },
    supervisor: {
      label: "Shift supervisor",
      pin: "3003",
      tabs: ["products", "stock", "par", "restock"],
    },
    bartender: {
      label: "Bartenders",
      pin: "4004",
      tabs: ["stock", "restock"],
    },
  };

  function readSessionRole() {
    try {
      const id = sessionStorage.getItem(SESSION_KEY);
      if (id && ROLES[id]) return id;
    } catch (_) {}
    return null;
  }

  function applyRole(roleId) {
    state.role = roleId && ROLES[roleId] ? roleId : null;
    document.body.classList.remove(
      "role-manager",
      "role-assistant",
      "role-supervisor",
      "role-bartender"
    );
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
    }
  }

  function signIn(roleId, pin) {
    const role = ROLES[roleId];
    if (!role || String(pin).trim() !== role.pin) return false;
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
    const pin = $("#loginPin");
    if (pin) pin.value = "";
    const err = $("#loginError");
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
  }

  async function init() {
    loadSelection();
    loadStockState();
    if (navigator.share) btnShare.hidden = false;
    // Apply the session role before any await so restricted tabs never flash.
    applyRole(readSessionRole());

    const res = await fetch("catalog.json");
    state.catalog = await res.json();
    renderProducts();
    if (state.tab === "stock") renderStock();
    if (state.tab === "par") renderPar();
    if (state.tab === "restock") renderRestock();
    updateLowBanner();
    updateBadges();

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    $("#btnCopy").addEventListener("click", copyList);
    $("#btnShare").addEventListener("click", shareList);
    $("#addProductForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#newProductName");
      addCustomProduct(input.value, $("#newProductCategory").value);
      input.value = "";
      input.focus();
    });
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
    document.querySelectorAll(".role-option input").forEach((input) => {
      input.addEventListener("change", () => {
        document.querySelectorAll(".role-option").forEach((el) => {
          el.classList.toggle("selected", el.contains(input) && input.checked);
        });
      });
    });
    $("#loginForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const picked = document.querySelector('input[name="role"]:checked');
      const pinEl = $("#loginPin");
      const err = $("#loginError");
      const roleId = picked ? picked.value : "";
      const pin = pinEl.value;
      if (!roleId) {
        err.textContent = "Choose a role.";
        err.hidden = false;
        return;
      }
      if (!signIn(roleId, pin)) {
        err.textContent = "Wrong PIN for that role.";
        err.hidden = false;
        pinEl.select();
        return;
      }
      err.hidden = true;
      err.textContent = "";
      pinEl.value = "";
    });

    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (_) {}
    }
  }

  init().catch((err) => {
    productsRoot.innerHTML = `<div class="empty-state"><strong>Failed to load catalog</strong>${escapeHtml(String(err))}</div>`;
  });
})();
