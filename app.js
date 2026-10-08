(() => {
  const STORAGE_KEY = "bar-restock-selection-v1";
  const STOCK_KEY = "bar-restock-stock-v1";
  const CUSTOM_KEY = "bar-restock-custom-v1";
  const HIDDEN_KEY = "bar-restock-hidden-v1";
  const PAR_KEY = "bar-restock-par-v1";
  const REMINDED_KEY = "bar-restock-reminded-v1";
  const EMAIL_TO = "arthurfaria@guarasolutions.com";
  const CATEGORIES = ["Fridge", "Bar Shelves", "Other"]; // built-ins, never renamed or deleted
  const CATEGORIES_KEY = "bar-restock-categories-v1"; // admin-created categories, in creation order
  const CATEGORY_MAX = 40;
  const SHELVES_KEY = "bar-restock-shelves-v1"; // shelf layout: levels top→bottom, slots left→right
  const SHELF_NAME_MAX = 40;
  const FACINGS_MAX = 24;
  // Default layout from the 2026-10-08 bar-shelf photos. Ids that aren't in the catalog are skipped.
  const SHELF_SEED = [
    {
      id: "top",
      name: "Top shelf · Spirits",
      slots: ["jack-daniels-old-no7", "jagermeister", "fireball", "greenside-vodka", "yella-dry-gin",
        "el-jimador-blanco", "benchmark-bourbon", "bundaberg-up-rum", "johnnie-walker-red"],
    },
    {
      id: "bottom",
      name: "Bottom shelf · Mixers",
      slots: ["glades-orange", "jameson", "kraken-black-spiced", "bartenders-best-lime", "bartenders-best-lemon",
        "angostura-bitters", "barmans-choice-sugar-syrup", "little-drippa", "cascade-raspberry-cordial",
        "cascade-lime-cordial"],
    },
  ];
  const state = {
    catalog: [],
    catalogError: null, // message when catalog.json failed to load
    loading: true, // catalog.json not loaded yet (UI shows skeletons)
    pendingPhoto: null, // resized data URL chosen in the Add product form
    custom: [], // user-added products
    categories: [], // user-created category names (after the built-ins)
    renamingCategory: null, // custom category being renamed inline on the Products tab
    shelves: null, // saved shelf layout { levels: [...] }, or null to show the default
    shelfEdit: false, // admin is editing the shelf layout
    shelfRenaming: null, // level id being renamed inline
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
    state.categories = loadCategories();
    state.shelves = loadShelves();
  }

  // Older saved state has no categories key: that simply means "no custom categories".
  function loadCategories() {
    const raw = loadJson(CATEGORIES_KEY, []);
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const v of raw) {
      const name = cleanCategoryName(v);
      if (name && !categoryExists(name, out)) out.push(name);
    }
    return out;
  }

  const saveSelection = () => saveJson(STORAGE_KEY, state.selection);
  const saveStock = () => saveJson(STOCK_KEY, state.stock);
  const saveCustom = () => saveJson(CUSTOM_KEY, state.custom);
  const saveHidden = () => saveJson(HIDDEN_KEY, state.hidden);
  const savePar = () => saveJson(PAR_KEY, state.par);
  const saveReminded = () => saveJson(REMINDED_KEY, state.reminded);
  const saveCategories = () => saveJson(CATEGORIES_KEY, state.categories);

  // Built-ins first in their fixed order, then custom categories in creation order.
  function allCategories() {
    return CATEGORIES.concat(state.categories);
  }

  function cleanCategoryName(name) {
    return typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, CATEGORY_MAX) : "";
  }

  // Case-insensitive match against the built-ins plus `custom` (defaults to the saved list).
  function categoryExists(name, custom) {
    const lower = name.toLowerCase();
    return CATEGORIES.concat(custom || state.categories).some((c) => c.toLowerCase() === lower);
  }

  function isCustomCategory(name) {
    return state.categories.includes(name);
  }

  // Every product that uses the category: static catalog (including locally removed ones) and hand-added.
  function productsInCategory(name) {
    return state.catalog.concat(state.custom).filter((p) => p.category === name);
  }

  function categoryNameError(name, ignore) {
    if (!name) return "Enter a category name.";
    const others = ignore ? state.categories.filter((c) => c !== ignore) : state.categories;
    if (categoryExists(name, others)) return "That category already exists.";
    return null;
  }

  // Returns an error message, or null when the category was created.
  function createCategory(rawName) {
    if (!canEditCatalog()) return "Only an admin can add categories.";
    const name = cleanCategoryName(rawName);
    const error = categoryNameError(name);
    if (error) return error;
    state.categories.push(name);
    if (!saveCategories()) {
      state.categories.pop();
      return "Couldn’t save the category.";
    }
    fillCategorySelect(name);
    renderCategoryManager();
    showToast(`Category “${name}” added`);
    return null;
  }

  function renameCategory(oldName, rawName) {
    if (!canEditCatalog() || !isCustomCategory(oldName)) return "Built-in categories can’t be renamed.";
    const name = cleanCategoryName(rawName);
    if (name === oldName) return null;
    const error = categoryNameError(name, oldName);
    if (error) return error;
    if (state.catalog.some((p) => p.category === oldName)) {
      return "Built-in catalog products use this category, so it can’t be renamed here.";
    }
    const prevCategories = state.categories.slice();
    const prevCustom = state.custom.map((p) => p.category);
    state.categories = state.categories.map((c) => (c === oldName ? name : c));
    state.custom.forEach((p) => {
      if (p.category === oldName) p.category = name;
    });
    if (!saveCategories() || !saveCustom()) {
      state.categories = prevCategories;
      state.custom.forEach((p, i) => (p.category = prevCustom[i]));
      saveCategories();
      saveCustom();
      return "Couldn’t save the new name.";
    }
    const select = $("#newProductCategory");
    fillCategorySelect(select.value === oldName ? name : select.value);
    refreshCategoryViews();
    showToast(`Renamed to “${name}”`);
    return null;
  }

  function deleteCategory(name) {
    if (!canEditCatalog() || !isCustomCategory(name)) return;
    const n = productsInCategory(name).length;
    if (n) {
      showToast(`“${name}” still has ${n} product${n === 1 ? "" : "s"}`);
      return;
    }
    if (!confirm(`Delete the category “${name}”?`)) return;
    state.categories = state.categories.filter((c) => c !== name);
    saveCategories();
    fillCategorySelect();
    refreshCategoryViews();
    showToast("Category deleted");
  }

  function refreshCategoryViews() {
    renderProducts();
    renderStock();
    if (state.tab === "par") renderPar();
    if (state.tab === "restock") renderRestock();
  }

  // Category dropdown on the Add product form. The trailing "New category…" option
  // (empty value, so it can't clash with a name) is only offered to roles that edit the catalog.
  function fillCategorySelect(selected) {
    const select = $("#newProductCategory");
    const keep = selected !== undefined ? selected : select.value;
    const opts = allCategories().map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
    if (canEditCatalog()) opts.push('<option value="">New category…</option>');
    select.innerHTML = opts.join("");
    const valid = allCategories().includes(keep) || (keep === "" && canEditCatalog());
    select.value = valid ? keep : CATEGORIES[0];
    select.dataset.last = select.value || select.dataset.last || CATEGORIES[0];
    showNewCategoryRow(select.value === "");
  }

  function showNewCategoryRow(show) {
    const row = $("#newCategoryRow");
    const input = $("#newCategoryName");
    const wasHidden = row.hidden;
    row.hidden = !show;
    if (!show) {
      input.value = "";
      setFieldError(input, $("#newCategoryError"), null);
    } else if (wasHidden) {
      input.focus();
    }
  }

  function onCategoryChange() {
    const select = $("#newProductCategory");
    if (select.value === "") {
      if (!canEditCatalog()) {
        select.value = select.dataset.last || CATEGORIES[0];
        return;
      }
      showNewCategoryRow(true);
    } else {
      select.dataset.last = select.value;
      showNewCategoryRow(false);
    }
  }

  // Returns true when the category was created (and is now selected).
  function submitNewCategory() {
    const input = $("#newCategoryName");
    const error = createCategory(input.value);
    setFieldError(input, $("#newCategoryError"), error);
    if (error) {
      input.focus();
      return false;
    }
    return true;
  }

  function cancelNewCategory() {
    const select = $("#newProductCategory");
    select.value = select.dataset.last || CATEGORIES[0];
    showNewCategoryRow(false);
    select.focus();
  }

  // Products tab: rename / delete custom categories (admin only).
  function renderCategoryManager() {
    const box = $("#categoryManager");
    const list = $("#categoryList");
    const show = canEditCatalog() && !state.loading && state.categories.length > 0;
    box.hidden = !show;
    if (!show) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = "";
    for (const name of state.categories) {
      const n = productsInCategory(name).length;
      const li = document.createElement("li");
      li.className = "category-item";
      li.dataset.category = name;
      if (state.renamingCategory === name) {
        li.innerHTML = `
          <input class="input" type="text" maxlength="${CATEGORY_MAX}" value="${escapeHtml(name)}" aria-label="New name for ${escapeHtml(name)}" enterkeyhint="done" autocomplete="off" />
          <div class="actions">
            <button type="button" class="btn btn-primary btn-sm" data-act="save">Save</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>
          </div>
          <p class="field-error" role="alert" hidden></p>`;
      } else {
        li.innerHTML = `
          <div class="info">
            <div class="name">${escapeHtml(name)}</div>
            <div class="cat">${n} product${n === 1 ? "" : "s"}</div>
          </div>
          <div class="actions">
            <button type="button" class="btn btn-secondary btn-sm" data-act="rename">Rename</button>
            <button type="button" class="btn btn-danger btn-sm" data-act="delete"${n ? ` disabled title="Move or delete its products first"` : ""}>${ICON("trash")}Delete</button>
          </div>`;
      }
      list.appendChild(li);
    }
    const editing = list.querySelector("input");
    if (editing) {
      editing.focus();
      editing.select();
    }
  }

  function onCategoryListClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const li = btn.closest(".category-item");
    const name = li.dataset.category;
    const act = btn.dataset.act;
    if (act === "rename") {
      state.renamingCategory = name;
      renderCategoryManager();
    } else if (act === "cancel") {
      state.renamingCategory = null;
      renderCategoryManager();
    } else if (act === "save") {
      saveRename(li, name);
    } else if (act === "delete") {
      deleteCategory(name);
    }
  }

  function saveRename(li, name) {
    const input = li.querySelector("input");
    const error = renameCategory(name, input.value);
    if (error) {
      setFieldError(input, li.querySelector(".field-error"), error);
      input.focus();
      return;
    }
    state.renamingCategory = null;
    renderCategoryManager();
  }

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
    const cats = allCategories();
    return cats.map((title) => ({
      title,
      items: items.filter((p) => (cats.includes(p.category) ? p.category : "Other") === title),
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
    renderCategoryManager();
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

    restockRoot.innerHTML = "";
    const products = ids.map(productById).filter(Boolean);
    for (const g of groupByCategory(products)) {
      const title = document.createElement("h3");
      title.className = "section-title";
      title.textContent = `${g.title} (${g.items.length})`;
      restockRoot.appendChild(title);
      const ul = document.createElement("ul");
      ul.className = "restock-list";
      for (const p of g.items) {
        const id = p.id;
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
      restockRoot.appendChild(ul);
    }
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
    if (tab === "shelves") renderShelves();
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
    const cat = allCategories().includes(category) ? category : "Other";
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
    fillCategorySelect();
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

  /*
   * Shelves tab: a picture of the bar cabinet. Levels run top → bottom, slots left → right.
   * Layout is stored in localStorage (SHELVES_KEY) as { levels: [{ id, name, slots: [{ id, facings }] }] }.
   * Slots key on product id, so renaming a category never matters; a slot whose product no
   * longer exists is simply not shown (and is dropped the next time an admin edits).
   * Everyone signed in can view; only roles that edit the catalog (admin) can change it.
   */
  function seedShelves() {
    return {
      levels: SHELF_SEED.map((l) => ({ id: l.id, name: l.name, slots: l.slots.map((id) => ({ id, facings: 1 })) })),
    };
  }

  function cleanShelfName(name) {
    return typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, SHELF_NAME_MAX) : "";
  }

  function cleanFacings(n) {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) ? Math.min(FACINGS_MAX, Math.max(1, v)) : 1;
  }

  // Anything unreadable falls back to the default layout; nothing else is touched.
  function sanitizeShelves(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.levels)) return null;
    const ids = new Set();
    const levels = [];
    for (const l of raw.levels) {
      if (!l || typeof l !== "object") continue;
      let id = typeof l.id === "string" && l.id ? l.id : "";
      if (!id || ids.has(id)) id = newLevelId(ids);
      ids.add(id);
      const seen = new Set();
      const slots = [];
      for (const sl of Array.isArray(l.slots) ? l.slots : []) {
        const pid = sl && typeof sl.id === "string" ? sl.id : typeof sl === "string" ? sl : "";
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        slots.push({ id: pid, facings: cleanFacings(sl && sl.facings) });
      }
      levels.push({ id, name: cleanShelfName(l.name) || "Shelf", slots });
    }
    return { levels };
  }

  function loadShelves() {
    return sanitizeShelves(loadJson(SHELVES_KEY, null));
  }

  function newLevelId(taken) {
    let id;
    do id = "lvl-" + Math.random().toString(36).slice(2, 8);
    while (taken.has(id));
    return id;
  }

  function currentShelves() {
    return state.shelves || seedShelves();
  }

  function canEditShelves() {
    return canEditCatalog();
  }

  function productMap() {
    return new Map(effectiveCatalog().map((p) => [p.id, p]));
  }

  // Slots that point at a product that exists right now, in order.
  function visibleSlots(level, map) {
    return level.slots.filter((sl) => map.has(sl.id));
  }

  // Apply an admin edit: copy the layout, drop slots for products that are gone, change, save.
  function editShelves(change) {
    if (!canEditShelves() || state.loading || state.catalogError) return false;
    const layout = JSON.parse(JSON.stringify(currentShelves()));
    const map = productMap();
    layout.levels.forEach((l) => (l.slots = visibleSlots(l, map)));
    if (change(layout) === false) return false;
    if (!saveJson(SHELVES_KEY, layout)) return false;
    state.shelves = layout;
    renderShelves();
    return true;
  }

  function levelById(layout, id) {
    return layout.levels.find((l) => l.id === id);
  }

  function shelfNameError(name, layout, ignoreId) {
    if (!name) return "Enter a shelf name.";
    const lower = name.toLowerCase();
    if (layout.levels.some((l) => l.id !== ignoreId && l.name.toLowerCase() === lower)) {
      return "There’s already a shelf with that name.";
    }
    return null;
  }

  function renderShelves() {
    const root = $("#shelvesRoot");
    if (!root) return;
    const editable = canEditShelves();
    if (!editable) state.shelfEdit = false;
    const editing = state.shelfEdit;
    $("#shelvesActions").hidden = !editable;
    const editBtn = $("#btnShelvesEdit");
    editBtn.querySelector("span").textContent = editing ? "Done" : "Edit layout";
    editBtn.querySelector("svg").style.display = editing ? "none" : "";
    editBtn.setAttribute("aria-pressed", editing ? "true" : "false");
    $("#btnShelvesReset").hidden = !editing;
    $("#shelvesSub").textContent = editing
      ? "Add, rename and reorder shelves. Tap + to put a product on a shelf, use the arrows to move it, and − / + to set how many face the front."
      : "Each shelf top to bottom, bottles left to right — just like the cabinet. Tap a bottle to see its stock and par.";

    if (state.loading) {
      root.innerHTML = SKELETON_ROWS;
      return;
    }
    if (state.catalogError) {
      root.innerHTML = catalogErrorMarkup();
      return;
    }
    const layout = currentShelves();
    const map = productMap();
    const total = layout.levels.reduce((n, l) => n + visibleSlots(l, map).length, 0);
    const parts = [];
    parts.push(`<div class="cabinet">
      <div class="cabinet-label"><strong>Bar Shelves</strong><span>${layout.levels.length} shelf level${
        layout.levels.length === 1 ? "" : "s"} · ${total} product${total === 1 ? "" : "s"}</span></div>`);
    if (!layout.levels.length) {
      parts.push(`<div class="shelf-bay"><div class="shelf-row"><p class="shelf-empty">${
        editable ? "No shelves yet. Add one below." : "No shelves set up yet. Ask an admin to lay them out."
      }</p></div></div><div class="shelf-lip"></div>`);
    }
    layout.levels.forEach((level, li) => {
      const slots = visibleSlots(level, map);
      parts.push(`<section class="shelf-level" data-level="${escapeHtml(level.id)}" aria-label="${escapeHtml(level.name)}">`);
      if (editing && state.shelfRenaming === level.id) {
        parts.push(`<div class="shelf-head"><div class="shelf-rename">
            <input class="input" type="text" maxlength="${SHELF_NAME_MAX}" value="${escapeHtml(level.name)}" aria-label="Shelf name" enterkeyhint="done" autocomplete="off" data-rename-input />
            <button type="button" class="btn btn-primary btn-sm" data-act="rename-save">Save</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="rename-cancel">Cancel</button>
            <p class="field-error" role="alert" hidden></p>
          </div></div>`);
      } else {
        parts.push(`<div class="shelf-head">
          <h3 class="shelf-name">${escapeHtml(level.name)}<span class="shelf-count">${slots.length}</span></h3>`);
        if (editing) {
          const nm = escapeHtml(level.name);
          parts.push(`<div class="shelf-tools">
            <button type="button" class="icon-btn" data-act="level-up" aria-label="Move ${nm} up"${li === 0 ? " disabled" : ""}>${ICON("chevron-up")}</button>
            <button type="button" class="icon-btn" data-act="level-down" aria-label="Move ${nm} down"${li === layout.levels.length - 1 ? " disabled" : ""}>${ICON("chevron-down")}</button>
            <button type="button" class="icon-btn" data-act="rename" aria-label="Rename ${nm}">${ICON("pencil")}</button>
            <button type="button" class="icon-btn is-danger" data-act="level-delete" aria-label="Delete ${nm}">${ICON("trash")}</button>
          </div>`);
        }
        parts.push(`</div>`);
      }
      parts.push(`<div class="shelf-bay"><div class="shelf-row">`);
      slots.forEach((sl, si) => {
        const p = map.get(sl.id);
        const nm = escapeHtml(p.name);
        const low = isLow(p.id);
        const badges =
          (sl.facings > 1 ? `<span class="slot-facings" aria-label="${sl.facings} facings">×${sl.facings}</span>` : "") +
          (low && !editing ? `<span class="slot-low">LOW</span>` : "");
        if (editing) {
          parts.push(`<div class="shelf-slot is-edit" data-slot="${si}" data-id="${escapeHtml(p.id)}">
            <div class="slot-thumb">${thumbMarkup(p, 112)}</div>
            <div class="slot-name">${nm}</div>
            <div class="slot-controls">
              <button type="button" class="icon-btn" data-act="slot-left" aria-label="Move ${nm} left"${si === 0 ? " disabled" : ""}>${ICON("chevron-left")}</button>
              <button type="button" class="icon-btn is-danger" data-act="slot-remove" aria-label="Remove ${nm} from this shelf">${ICON("close")}</button>
              <button type="button" class="icon-btn" data-act="slot-right" aria-label="Move ${nm} right"${si === slots.length - 1 ? " disabled" : ""}>${ICON("chevron-right")}</button>
            </div>
            <div class="qty-row slot-facings-row" aria-label="Facings">
              <button type="button" class="qty-btn" data-act="facings-dec" aria-label="Fewer facings of ${nm}"${sl.facings <= 1 ? " disabled" : ""}>${ICON("minus")}</button>
              <span class="qty-val">×${sl.facings}</span>
              <button type="button" class="qty-btn" data-act="facings-inc" aria-label="More facings of ${nm}"${sl.facings >= FACINGS_MAX ? " disabled" : ""}>${ICON("plus")}</button>
            </div>
          </div>`);
        } else {
          parts.push(`<button type="button" class="shelf-slot" data-slot="${si}" data-id="${escapeHtml(p.id)}" data-act="detail" aria-label="${nm}${sl.facings > 1 ? `, ${sl.facings} facings` : ""}${low ? ", low stock" : ""}">
            <div class="slot-thumb">${thumbMarkup(p, 104)}${badges}</div>
            <div class="slot-name">${nm}</div>
          </button>`);
        }
      });
      if (editing) {
        parts.push(`<button type="button" class="shelf-add" data-act="slot-add">${ICON("plus")}Add product</button>`);
      } else if (!slots.length) {
        parts.push(`<p class="shelf-empty">Nothing on this shelf yet.</p>`);
      }
      parts.push(`</div></div><div class="shelf-lip"></div></section>`);
    });
    parts.push(`</div>`);
    if (editing) {
      parts.push(`<form class="card add-level" data-add-level novalidate>
        <h3 class="card-title">Add a shelf level</h3>
        <div class="add-level-fields">
          <div class="field">
            <label class="field-label" for="newShelfName">Shelf name</label>
            <input id="newShelfName" class="input" type="text" maxlength="${SHELF_NAME_MAX}" placeholder="e.g. Middle shelf · Liqueurs" autocomplete="off" enterkeyhint="done" aria-describedby="newShelfError" />
          </div>
          <button type="submit" class="btn btn-primary">${ICON("plus")}Add shelf</button>
        </div>
        <p id="newShelfError" class="field-error" role="alert" hidden></p>
        <p class="summary">New shelves go at the bottom. Use the arrows to move them up.</p>
      </form>`);
    } else if (!state.shelves && editable) {
      parts.push(`<p class="shelves-note">This is the default layout from the shelf photos. Tap Edit layout to change it.</p>`);
    }
    root.innerHTML = parts.join("");
    const renameInput = root.querySelector("[data-rename-input]");
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
    }
  }

  function onShelvesClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const levelEl = btn.closest("[data-level]");
    const levelId = levelEl ? levelEl.dataset.level : null;
    const slotEl = btn.closest("[data-slot]");
    const si = slotEl ? Number(slotEl.dataset.slot) : -1;

    if (act === "detail") {
      showProductDetail(slotEl.dataset.id, levelId, si);
      return;
    }
    if (!state.shelfEdit || !canEditShelves()) return;
    switch (act) {
      case "slot-left":
      case "slot-right": {
        const d = act === "slot-left" ? -1 : 1;
        editShelves((layout) => {
          const s = levelById(layout, levelId).slots;
          const j = si + d;
          if (j < 0 || j >= s.length) return false;
          [s[si], s[j]] = [s[j], s[si]];
        });
        focusAfterRender(`[data-level="${cssEscape(levelId)}"] [data-slot="${si + d}"] [data-act="${act}"]`);
        break;
      }
      case "slot-remove": {
        let name = "";
        editShelves((layout) => {
          const s = levelById(layout, levelId).slots;
          const p = productById(s[si] && s[si].id);
          name = p ? p.name : "";
          s.splice(si, 1);
        });
        showToast(name ? `Removed ${name}` : "Removed");
        break;
      }
      case "facings-inc":
      case "facings-dec":
        editShelves((layout) => {
          const sl = levelById(layout, levelId).slots[si];
          sl.facings = cleanFacings(sl.facings + (act === "facings-inc" ? 1 : -1));
        });
        focusAfterRender(`[data-level="${cssEscape(levelId)}"] [data-slot="${si}"] [data-act="${act}"]`);
        break;
      case "slot-add":
        openPicker(levelId);
        break;
      case "level-up":
      case "level-down": {
        const d = act === "level-up" ? -1 : 1;
        editShelves((layout) => {
          const i = layout.levels.findIndex((l) => l.id === levelId);
          const j = i + d;
          if (i < 0 || j < 0 || j >= layout.levels.length) return false;
          [layout.levels[i], layout.levels[j]] = [layout.levels[j], layout.levels[i]];
        });
        focusAfterRender(`[data-level="${cssEscape(levelId)}"] [data-act="${act}"]`);
        break;
      }
      case "rename":
        state.shelfRenaming = levelId;
        renderShelves();
        break;
      case "rename-cancel":
        state.shelfRenaming = null;
        renderShelves();
        break;
      case "rename-save":
        saveShelfRename(levelEl);
        break;
      case "level-delete": {
        const level = levelById(currentShelves(), levelId);
        if (!level) return;
        const n = visibleSlots(level, productMap()).length;
        const msg = n
          ? `Delete the shelf “${level.name}” and its ${n} product slot${n === 1 ? "" : "s"}? The products stay in the catalog.`
          : `Delete the shelf “${level.name}”?`;
        if (!confirm(msg)) return;
        if (editShelves((layout) => {
          layout.levels = layout.levels.filter((l) => l.id !== levelId);
        })) showToast("Shelf deleted");
        break;
      }
    }
  }

  function saveShelfRename(levelEl) {
    const input = levelEl.querySelector("[data-rename-input]");
    const err = levelEl.querySelector(".field-error");
    const name = cleanShelfName(input.value);
    const error = shelfNameError(name, currentShelves(), levelEl.dataset.level);
    if (error) {
      setFieldError(input, err, error);
      input.focus();
      return;
    }
    const id = levelEl.dataset.level;
    state.shelfRenaming = null;
    editShelves((layout) => {
      levelById(layout, id).name = name;
    });
  }

  function onAddLevel(e) {
    const form = e.target.closest("[data-add-level]");
    if (!form) return;
    e.preventDefault();
    const input = $("#newShelfName");
    const name = cleanShelfName(input.value);
    const error = shelfNameError(name, currentShelves());
    setFieldError(input, $("#newShelfError"), error);
    if (error) {
      input.focus();
      return;
    }
    editShelves((layout) => {
      layout.levels.push({ id: newLevelId(new Set(layout.levels.map((l) => l.id))), name, slots: [] });
    });
    showToast(`Added “${name}”`);
  }

  function cssEscape(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&");
  }

  // Keep keyboard / VoiceOver focus on the control that was pressed after a re-render.
  function focusAfterRender(selector) {
    const el = $("#shelvesRoot").querySelector(selector);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  /* Sheet: one dialog reused for product details and the product picker. */
  let sheetReturnFocus = null;
  let sheetPickerLevel = null;

  function openSheet(title, html) {
    const backdrop = $("#sheetBackdrop");
    $("#sheetTitle").textContent = title;
    $("#sheetBody").innerHTML = html;
    if (backdrop.hidden) sheetReturnFocus = document.activeElement;
    backdrop.hidden = false;
    document.documentElement.style.overflow = "hidden";
  }

  function closeSheet() {
    const backdrop = $("#sheetBackdrop");
    if (!backdrop || backdrop.hidden) return;
    backdrop.hidden = true;
    $("#sheetBody").innerHTML = "";
    sheetPickerLevel = null;
    document.documentElement.style.overflow = "";
    if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus({ preventScroll: true });
    sheetReturnFocus = null;
  }

  function showProductDetail(id, levelId, si) {
    const p = productById(id);
    if (!p) return;
    const layout = currentShelves();
    const level = levelById(layout, levelId);
    const slot = level ? visibleSlots(level, productMap())[si] : null;
    const onHand = stockQty(id);
    const par = parQty(id);
    const low = isLow(id);
    const where = level
      ? `<strong>${escapeHtml(level.name)}</strong>Position ${si + 1} from the left${
          slot && slot.facings > 1 ? ` · ×${slot.facings} facings` : ""}<br />`
      : "";
    openSheet(p.name, `
      <div class="detail-top">
        <div class="slot-thumb">${thumbMarkup(p, 120)}</div>
        <div class="detail-meta">
          ${where}Category: ${escapeHtml(p.category || "Other")}
        </div>
      </div>
      <div class="detail-stats">
        <div class="stat"><div class="stat-label">On hand</div><div class="stat-value">${onHand}</div></div>
        <div class="stat"><div class="stat-label">Par (min)</div>${
          par > 0 ? `<div class="stat-value">${par}</div>` : `<div class="stat-value is-muted">No par set</div>`
        }</div>
      </div>
      ${low ? `<div class="detail-low">${ICON("alert")}Low stock — at or below par.</div>` : ""}
    `);
    $("#btnSheetClose").focus();
  }

  function openPicker(levelId) {
    const level = levelById(currentShelves(), levelId);
    if (!level || !canEditShelves()) return;
    sheetPickerLevel = levelId;
    openSheet(`Add to ${level.name}`, `
      <div class="picker-search">
        ${ICON("search")}
        <input id="pickerSearch" class="input" type="search" placeholder="Search products" autocomplete="off" enterkeyhint="search" aria-label="Search products" />
      </div>
      <div id="pickerResults"></div>
    `);
    renderPickerResults();
    // On iPad the keyboard would cover half the list, so only focus search on wide screens with a pointer.
    if (matchMedia("(hover: hover)").matches) $("#pickerSearch").focus();
    else $("#btnSheetClose").focus();
  }

  function renderPickerResults() {
    const box = $("#pickerResults");
    if (!box || !sheetPickerLevel) return;
    const level = levelById(currentShelves(), sheetPickerLevel);
    if (!level) return closeSheet();
    const map = productMap();
    const onShelf = new Set(visibleSlots(level, map).map((sl) => sl.id));
    const q = ($("#pickerSearch").value || "").trim().toLowerCase();
    const items = effectiveCatalog().filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.category || "").toLowerCase().includes(q));
    if (!items.length) {
      box.innerHTML = `<p class="picker-empty">No products match “${escapeHtml(q)}”.</p>`;
      return;
    }
    box.innerHTML = groupByCategory(items).map((g) => `
      <h3 class="picker-group">${escapeHtml(g.title)}</h3>
      <ul class="picker-list">${g.items.map((p) => {
        const on = onShelf.has(p.id);
        return `<li><button type="button" class="picker-item" data-pick="${escapeHtml(p.id)}"${on ? " disabled" : ""}>
          ${thumbMarkup(p, 44)}
          <span class="picker-name">${escapeHtml(p.name)}</span>
          <span class="picker-state">${on ? "On this shelf" : "Add"}</span>
        </button></li>`;
      }).join("")}</ul>`).join("");
  }

  function onPick(e) {
    const btn = e.target.closest("[data-pick]");
    if (!btn || btn.disabled || !sheetPickerLevel) return;
    const id = btn.dataset.pick;
    const levelId = sheetPickerLevel;
    const p = productById(id);
    const ok = editShelves((layout) => {
      const level = levelById(layout, levelId);
      if (!level || level.slots.some((sl) => sl.id === id)) return false;
      level.slots.push({ id, facings: 1 });
    });
    if (ok) {
      showToast(`Added ${p ? p.name : "product"}`);
      renderPickerResults();
    }
  }

  function toggleShelfEdit() {
    if (!canEditShelves()) return;
    state.shelfEdit = !state.shelfEdit;
    state.shelfRenaming = null;
    renderShelves();
  }

  function resetShelves() {
    if (!canEditShelves()) return;
    if (!confirm("Reset the shelves to the default layout from the shelf photos? Your changes to the layout will be lost.")) return;
    try {
      localStorage.removeItem(SHELVES_KEY);
    } catch (_) {}
    state.shelves = null;
    state.shelfRenaming = null;
    renderShelves();
    showToast("Shelves reset");
  }

  function bindShelves() {
    const root = $("#shelvesRoot");
    root.addEventListener("click", onShelvesClick);
    root.addEventListener("submit", onAddLevel);
    root.addEventListener("keydown", (e) => {
      if (!e.target.matches("[data-rename-input]")) return;
      const levelEl = e.target.closest("[data-level]");
      if (e.key === "Enter") {
        e.preventDefault();
        saveShelfRename(levelEl);
      } else if (e.key === "Escape") {
        state.shelfRenaming = null;
        renderShelves();
      }
    });
    root.addEventListener("input", (e) => {
      if (e.target.id === "newShelfName") setFieldError(e.target, $("#newShelfError"), null);
      if (e.target.matches("[data-rename-input]")) {
        setFieldError(e.target, e.target.closest("[data-level]").querySelector(".field-error"), null);
      }
    });
    $("#btnShelvesEdit").addEventListener("click", toggleShelfEdit);
    $("#btnShelvesReset").addEventListener("click", resetShelves);
    $("#btnSheetClose").addEventListener("click", closeSheet);
    $("#sheetBackdrop").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeSheet();
    });
    $("#sheetBody").addEventListener("click", onPick);
    $("#sheetBody").addEventListener("input", (e) => {
      if (e.target.id === "pickerSearch") renderPickerResults();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#sheetBackdrop").hidden) {
        e.stopPropagation();
        closeSheet();
      }
    });
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
      tabs: ["products", "stock", "par", "restock", "shelves"],
      editCatalog: true,
    },
    bartender: {
      label: "Bartender",
      pin: null, // no PIN: one-tap sign-in
      tabs: ["stock", "restock", "shelves"],
      editCatalog: false, // count stock only; cannot add or remove products
    },
  };
  const ALL_TABS = ["products", "stock", "par", "restock", "shelves"];

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
    renderCategoryManager();
    state.shelfEdit = false;
    state.shelfRenaming = null;
    closeSheet();
    if (state.tab === "shelves") renderShelves();
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
    if (state.tab === "shelves") renderShelves();
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
    fillCategorySelect(CATEGORIES[0]);
    $("#newProductCategory").addEventListener("change", onCategoryChange);
    $("#btnCreateCategory").addEventListener("click", submitNewCategory);
    $("#btnCancelCategory").addEventListener("click", cancelNewCategory);
    $("#newCategoryName").addEventListener("keydown", (e) => {
      // Enter here creates the category instead of submitting the product form.
      if (e.key === "Enter") {
        e.preventDefault();
        submitNewCategory();
      } else if (e.key === "Escape") {
        cancelNewCategory();
      }
    });
    $("#newCategoryName").addEventListener("input", (e) => setFieldError(e.target, $("#newCategoryError"), null));
    $("#categoryList").addEventListener("click", onCategoryListClick);
    $("#categoryList").addEventListener("keydown", (e) => {
      if (e.target.tagName !== "INPUT") return;
      const li = e.target.closest(".category-item");
      if (e.key === "Enter") {
        e.preventDefault();
        saveRename(li, li.dataset.category);
      } else if (e.key === "Escape") {
        state.renamingCategory = null;
        renderCategoryManager();
      }
    });
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    $("#btnCopy").addEventListener("click", copyList);
    $("#btnShare").addEventListener("click", shareList);
    $("#addProductForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#newProductName");
      if ($("#newProductCategory").value === "") {
        // "New category…" is still open: create it first, then add the product to it.
        if (!input.value.trim()) {
          setFieldError(input, $("#addProductError"), "Enter a product name.");
          input.focus();
          return;
        }
        if (!submitNewCategory()) return;
      }
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
    bindShelves();
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
