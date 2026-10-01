(() => {
  const STORAGE_KEY = "bar-restock-selection-v1";
  const state = {
    catalog: [],
    selection: {}, // id -> qty
    tab: "products",
  };

  const $ = (sel) => document.querySelector(sel);
  const productsRoot = $("#productsRoot");
  const restockRoot = $("#restockRoot");
  const headerBadge = $("#headerBadge");
  const tabBadge = $("#tabBadge");
  const toastEl = $("#toast");
  const btnShare = $("#btnShare");

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
    $("#btnCopy").disabled = n === 0;
    $("#btnClear").disabled = n === 0;
    if (btnShare.hidden === false) btnShare.disabled = n === 0;
  }

  function productById(id) {
    return state.catalog.find((p) => p.id === id);
  }

  function renderProducts() {
    const groups = [
      { title: "Fridge", items: state.catalog.filter((p) => p.category === "Fridge") },
      { title: "Bar Shelves", items: state.catalog.filter((p) => p.category === "Bar Shelves") },
    ];
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
          <img src="thumbs/${p.id}.jpg" alt="" loading="lazy" width="400" height="400" />
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
      restockRoot.innerHTML = `
        <div class="empty-state">
          <strong>Nothing selected yet</strong>
          Tap products on the Products tab to build your restock list.
        </div>`;
      return;
    }
    // Group by category, preserve catalog order
    const order = state.catalog.map((p) => p.id);
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
        <img src="thumbs/${p.id}.jpg" alt="" width="64" height="64" />
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
    const order = state.catalog.map((p) => p.id);
    const ids = Object.keys(state.selection).sort(
      (a, b) => order.indexOf(a) - order.indexOf(b)
    );
    const lines = ["Restock list", "────────────"];
    let fridge = [], bar = [];
    for (const id of ids) {
      const p = productById(id);
      if (!p) continue;
      const line = `${state.selection[id]}× ${p.name}`;
      if (p.category === "Fridge") fridge.push(line);
      else bar.push(line);
    }
    if (fridge.length) {
      lines.push("Fridge:");
      lines.push(...fridge.map((l) => "  " + l));
    }
    if (bar.length) {
      lines.push("Bar Shelves:");
      lines.push(...bar.map((l) => "  " + l));
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
    state.tab = tab;
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    document.querySelectorAll(".tab-btn").forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    $(`#panel-${tab}`).classList.add("active");
    if (tab === "restock") renderRestock();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function init() {
    loadSelection();
    if (navigator.share) btnShare.hidden = false;

    const res = await fetch("catalog.json");
    state.catalog = await res.json();
    renderProducts();
    updateBadges();

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    $("#btnCopy").addEventListener("click", copyList);
    $("#btnShare").addEventListener("click", shareList);
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
