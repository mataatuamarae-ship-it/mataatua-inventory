// Mataatua Inventory — offline-first stock + condition tracker.
//
// Data model: one flat table `inventory_items` (category, name, quantity,
// condition, notes). Local copy lives in localStorage so the app works with
// no connection; writes go to Supabase when reachable, otherwise they queue
// and flush once back online. Realtime keeps other devices in sync.

const LOCAL_KEY = "mataatua-inventory:items";
const QUEUE_KEY = "mataatua-inventory:pending-ops";

const CONDITION_LABEL = {
  good: "Good",
  needs_repair: "Needs repair",
  damaged: "Damaged",
  missing: "Missing",
};

let supabaseClient = null;
let items = [];
let filters = { search: "", category: "", condition: "", attentionOnly: false };

// ---------- storage helpers ----------

function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveLocal(list) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
}

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

function queueOp(op) {
  const q = loadQueue();
  q.push(op);
  saveQueue(q);
}

// ---------- supabase setup ----------

function isConfigured() {
  const c = window.SUPABASE_CONFIG;
  return c && c.url && c.anonKey && !c.url.includes("YOUR-PROJECT-REF");
}

// Loads the Supabase client library from a file shipped with the app
// itself (vendor-supabase.js) — not a third-party CDN. This is what
// actually talks to your Supabase project, so this being local means the
// only network dependency for syncing is reaching Supabase itself, nothing
// else in between that a firewall or ad-blocker could interfere with.
// Still loaded in the background with a timeout so a slow device never
// holds up the app itself — search, add/edit, +/-, print work instantly
// whether or not this ever succeeds.
function loadSupabaseScript(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve();
    const script = document.createElement("script");
    script.src = "vendor-supabase.js";
    const timer = setTimeout(() => reject(new Error("timed out loading Supabase library")), timeoutMs);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error("failed to load Supabase library")); };
    document.head.appendChild(script);
  });
}

async function initSupabase() {
  if (!isConfigured()) return null;
  try {
    await loadSupabaseScript();
    return window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
  } catch (e) {
    console.warn("Supabase unavailable, running offline-only:", e.message);
    return null;
  }
}

async function fetchRemote() {
  const { data, error } = await supabaseClient.from("inventory_items").select("*").order("category").order("name");
  if (error) throw error;
  return data;
}

async function seedIfEmpty() {
  const remote = await fetchRemote();
  if (remote.length > 0) return remote;
  const seed = (window.SEED_DATA || []).map((s) => ({
    category: s.category,
    name: s.name,
    quantity: s.quantity,
    condition: "good",
    notes: "",
  }));
  if (seed.length === 0) return [];
  const { data, error } = await supabaseClient.from("inventory_items").insert(seed).select("*");
  if (error) throw error;
  return data;
}

async function flushQueue() {
  const q = loadQueue();
  if (q.length === 0) return;
  const remaining = [];
  for (const op of q) {
    try {
      if (op.type === "upsert") {
        const { error } = await supabaseClient.from("inventory_items").upsert(op.row);
        if (error) throw error;
      } else if (op.type === "delete") {
        const { error } = await supabaseClient.from("inventory_items").delete().eq("id", op.id);
        if (error) throw error;
      }
    } catch (e) {
      remaining.push(op);
    }
  }
  saveQueue(remaining);
}

// ---------- sync orchestration ----------

function seedLocalIfEmpty() {
  const local = loadLocal();
  if (local.length > 0) return local;
  const seed = (window.SEED_DATA || []).map((s) => ({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
    category: s.category,
    name: s.name,
    quantity: s.quantity,
    condition: "good",
    notes: "",
    updated_at: new Date().toISOString(),
  }));
  saveLocal(seed);
  return seed;
}

async function syncAll() {
  if (!supabaseClient) {
    setStatus("working locally — not synced", "offline");
    items = seedLocalIfEmpty();
    render();
    return;
  }
  setStatus("syncing…", "syncing");
  try {
    await flushQueue();
    const remote = items.length === 0 && loadLocal().length === 0
      ? await seedIfEmpty()
      : await fetchRemote();
    items = remote;
    saveLocal(items);
    setStatus("online", "online");
  } catch (e) {
    console.warn("Sync failed, using local cache", e);
    items = loadLocal();
    setStatus("offline", "offline");
  }
  render();
}

function setStatus(text, cls) {
  const pill = document.getElementById("status-pill");
  pill.textContent = text;
  pill.className = "status-pill " + cls;
}

function subscribeRealtime() {
  if (!supabaseClient) return;
  supabaseClient
    .channel("inventory-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items" }, () => {
      syncAll();
    })
    .subscribe();
}

// ---------- CRUD ----------

function localUpsert(row) {
  const idx = items.findIndex((i) => i.id === row.id);
  if (idx >= 0) items[idx] = row;
  else items.push(row);
  saveLocal(items);
}

function localDelete(id) {
  items = items.filter((i) => i.id !== id);
  saveLocal(items);
}

async function saveItem(row) {
  const isNew = !row.id;
  if (isNew) {
    row.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  }
  row.updated_at = new Date().toISOString();
  localUpsert(row);
  render();

  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("inventory_items").upsert(row);
      if (error) throw error;
      setStatus("online", "online");
      return;
    } catch (e) {
      // fall through to queue
    }
  }
  queueOp({ type: "upsert", row });
  setStatus(supabaseClient ? "offline — will sync" : "offline (not configured)", "offline");
}

async function deleteItem(id) {
  localDelete(id);
  render();
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("inventory_items").delete().eq("id", id);
      if (error) throw error;
      setStatus("online", "online");
      return;
    } catch (e) {
      // fall through
    }
  }
  queueOp({ type: "delete", id });
  setStatus(supabaseClient ? "offline — will sync" : "offline (not configured)", "offline");
}

async function adjustQuantity(id, delta) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const next = Math.max(0, (item.quantity || 0) + delta);
  await saveItem({ ...item, quantity: next });
}

// ---------- rendering ----------

function matchesFilters(item) {
  const s = filters.search.trim().toLowerCase();
  if (s && !item.name.toLowerCase().includes(s) && !item.category.toLowerCase().includes(s)) return false;
  if (filters.category && item.category !== filters.category) return false;
  if (filters.condition && item.condition !== filters.condition) return false;
  if (filters.attentionOnly && item.condition === "good") return false;
  return true;
}

function render() {
  renderSummary();
  renderFilterOptions();
  renderCategories();
}

function renderSummary() {
  const total = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const attention = items.filter((i) => i.condition !== "good").length;
  const categories = new Set(items.map((i) => i.category)).size;
  document.getElementById("summary-row").innerHTML = `
    <span>${items.length} items across ${categories} categories</span>
    <span>${total} total units</span>
    <span>${attention} need attention</span>
  `;
}

function renderFilterOptions() {
  const categories = [...new Set(items.map((i) => i.category))].sort();
  const sel = document.getElementById("category-filter");
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = categories.includes(current) ? current : "";

  document.getElementById("category-list").innerHTML =
    categories.map((c) => `<option value="${esc(c)}">`).join("");
}

function renderCategories() {
  const container = document.getElementById("categories");
  const filtered = items.filter(matchesFilters);
  const byCategory = {};
  for (const item of filtered) {
    (byCategory[item.category] ||= []).push(item);
  }
  const categoryNames = Object.keys(byCategory).sort();

  document.getElementById("empty-state").hidden = filtered.length > 0;

  container.innerHTML = categoryNames.map((cat) => {
    const rows = byCategory[cat].sort((a, b) => a.name.localeCompare(b.name));
    return `
      <section class="category-block">
        <div class="category-header">
          <h2>${esc(cat)}</h2>
          <span class="count">${rows.length} items · ${rows.reduce((s, r) => s + (r.quantity || 0), 0)} units</span>
        </div>
        <div class="item-list">
          ${rows.map(renderRow).join("")}
        </div>
      </section>
    `;
  }).join("");

  container.querySelectorAll(".item-row").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".qty-controls")) return;
      openDialog(el.dataset.id);
    });
  });
  container.querySelectorAll("[data-adjust]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      adjustQuantity(btn.dataset.id, Number(btn.dataset.adjust));
    });
  });
  container.querySelectorAll("[data-camera-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openQuickCamera(btn.dataset.cameraId);
    });
  });
}

function renderRow(item) {
  const notes = item.notes ? `<span class="item-notes">${esc(item.notes)}</span>` : "";
  const thumb = item.photo_url
    ? `<img class="item-thumb" src="${item.photo_url}" alt="">`
    : `<span class="item-thumb-placeholder">📷</span>`;
  return `
    <div class="item-row" data-id="${item.id}">
      <button type="button" class="thumb-btn" data-camera-id="${item.id}" title="Take/change photo">${thumb}</button>
      <div>
        <span class="item-name">${esc(item.name)}</span>
        ${notes}
      </div>
      <span class="badge ${item.condition}">${CONDITION_LABEL[item.condition] || item.condition}</span>
      <div class="qty-controls">
        <button data-adjust="-1" data-id="${item.id}">−</button>
        <span class="qty-value">${item.quantity ?? 0}</span>
        <button data-adjust="1" data-id="${item.id}">+</button>
      </div>
      <span></span>
    </div>
  `;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- photos ----------

// Photos are stored as compressed JPEG data URLs directly on the item —
// no separate storage bucket to set up, and they sync/work offline exactly
// like every other field.
function resizeImageFile(file, maxDim = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- quick camera (tap the thumbnail on a row) ----------

let quickCameraTargetId = null;

function openQuickCamera(itemId) {
  quickCameraTargetId = itemId;
  document.getElementById("quick-photo-input").click();
}

function setupQuickCamera() {
  document.getElementById("quick-photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !quickCameraTargetId) return;
    const item = items.find((i) => i.id === quickCameraTargetId);
    if (!item) return;
    try {
      const dataUrl = await resizeImageFile(file);
      await saveItem({ ...item, photo_url: dataUrl });
    } catch (err) {
      console.warn("Could not process photo", err);
      alert("Sorry, couldn't read that photo — try another one.");
    }
  });
}

// ---------- dialog ----------

// undefined = no change made this session, null = photo removed, string = new photo
let pendingPhotoDataUrl;
let dialogExistingPhotoUrl = null;

function showPhotoPreview(url) {
  const wrap = document.getElementById("photo-preview-wrap");
  const img = document.getElementById("photo-preview");
  if (url) {
    img.src = url;
    wrap.hidden = false;
  } else {
    img.src = "";
    wrap.hidden = true;
  }
}

function openDialog(id) {
  const dialog = document.getElementById("item-dialog");
  const item = id ? items.find((i) => i.id === id) : null;

  document.getElementById("dialog-title").textContent = item ? "Edit item" : "Add item";
  document.getElementById("item-id").value = item ? item.id : "";
  document.getElementById("item-category").value = item ? item.category : (filters.category || "");
  document.getElementById("item-name").value = item ? item.name : "";
  document.getElementById("item-quantity").value = item ? item.quantity : 0;
  document.getElementById("item-condition").value = item ? item.condition : "good";
  document.getElementById("item-notes").value = item ? item.notes || "" : "";
  document.getElementById("delete-item-btn").hidden = !item;

  document.getElementById("item-photo-input").value = "";
  pendingPhotoDataUrl = undefined;
  dialogExistingPhotoUrl = item ? item.photo_url || null : null;
  showPhotoPreview(dialogExistingPhotoUrl);

  dialog.showModal();
}

function setupDialog() {
  const dialog = document.getElementById("item-dialog");
  document.getElementById("add-item-btn").addEventListener("click", () => openDialog(null));
  document.getElementById("cancel-dialog-btn").addEventListener("click", () => dialog.close());

  document.getElementById("item-photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageFile(file);
      pendingPhotoDataUrl = dataUrl;
      showPhotoPreview(dataUrl);
    } catch (err) {
      console.warn("Could not process photo", err);
      alert("Sorry, couldn't read that photo — try another one.");
    }
  });

  document.getElementById("remove-photo-btn").addEventListener("click", () => {
    pendingPhotoDataUrl = null;
    document.getElementById("item-photo-input").value = "";
    showPhotoPreview(null);
  });

  document.getElementById("item-form").addEventListener("submit", (e) => {
    const photo_url = pendingPhotoDataUrl === undefined ? dialogExistingPhotoUrl : pendingPhotoDataUrl;
    const row = {
      id: document.getElementById("item-id").value || null,
      category: document.getElementById("item-category").value.trim(),
      name: document.getElementById("item-name").value.trim(),
      quantity: Number(document.getElementById("item-quantity").value) || 0,
      condition: document.getElementById("item-condition").value,
      notes: document.getElementById("item-notes").value.trim(),
      photo_url,
    };
    saveItem(row);
    dialog.close();
  });

  document.getElementById("delete-item-btn").addEventListener("click", () => {
    const id = document.getElementById("item-id").value;
    if (id && confirm("Delete this item?")) {
      deleteItem(id);
      dialog.close();
    }
  });
}

// ---------- toolbar ----------

function setupToolbar() {
  document.getElementById("search").addEventListener("input", (e) => {
    filters.search = e.target.value;
    renderCategories();
  });
  document.getElementById("category-filter").addEventListener("change", (e) => {
    filters.category = e.target.value;
    renderCategories();
  });
  document.getElementById("condition-filter").addEventListener("change", (e) => {
    filters.condition = e.target.value;
    renderCategories();
  });
  const attentionBtn = document.getElementById("attention-toggle");
  attentionBtn.addEventListener("click", () => {
    filters.attentionOnly = !filters.attentionOnly;
    attentionBtn.classList.toggle("active", filters.attentionOnly);
    renderCategories();
  });
  document.getElementById("print-btn").addEventListener("click", () => window.print());
}

// ---------- install prompt ----------

let deferredInstallPrompt = null;

function setupInstall() {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (isStandalone) return; // already installed/running as an app

  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);

  if (isIos) {
    // iOS Safari has no install prompt API — show the manual steps instead.
    document.getElementById("ios-install-hint").hidden = false;
    return;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById("install-btn").hidden = false;
  });

  document.getElementById("install-btn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById("install-btn").hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    document.getElementById("install-btn").hidden = true;
  });
}

// ---------- boot ----------

window.addEventListener("online", syncAll);
window.addEventListener("offline", () => setStatus("offline", "offline"));

document.addEventListener("DOMContentLoaded", async () => {
  try {
    setupToolbar();
    setupDialog();
    setupQuickCamera();
    setupInstall();

    items = loadLocal();
    render();

    try {
      supabaseClient = await initSupabase();
    } catch (e) {
      console.warn("Supabase client failed to initialise", e);
      supabaseClient = null;
    }

    await syncAll();

    if (supabaseClient) {
      try {
        subscribeRealtime();
      } catch (e) {
        console.warn("Realtime subscription failed", e);
      }
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  } catch (e) {
    console.error("App failed to start", e);
    setStatus("error — see console", "offline");
  }
});
