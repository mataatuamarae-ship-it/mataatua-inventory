// Mataatua Inventory — offline-first stock + condition tracker.
//
// Data model: one flat table `inventory_items` (category, name, quantity,
// condition, notes). Local copy lives in localStorage so the app works with
// no connection; writes go to Supabase when reachable, otherwise they queue
// and flush once back online. Realtime keeps other devices in sync.

const LOCAL_KEY = "mataatua-inventory:items";
const QUEUE_KEY = "mataatua-inventory:pending-ops";
const CATEGORIES_KEY = "mataatua-inventory:categories";

const CONDITION_LABEL = {
  good: "Good",
  needs_repair: "Needs repair",
  damaged: "Damaged",
  missing: "Missing",
};

let supabaseClient = null;
let items = [];
let filters = { search: "", category: "", subcategory: "", condition: "", attentionOnly: false };

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

// Categories added via "Manage categories" with no items yet (so they still
// show up in dropdowns). This list lives only on this device — it's just a
// convenience for offering the name before anything uses it; as soon as an
// item is saved with that category, the category itself is synced as part
// of that item like everything else.
function loadExtraCategories() {
  try {
    return JSON.parse(localStorage.getItem(CATEGORIES_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveExtraCategories(list) {
  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(list));
}

function getAllCategoryNames() {
  const fromItems = items.map((i) => i.category).filter(Boolean);
  const fromExtra = loadExtraCategories();
  return [...new Set([...fromItems, ...fromExtra])].sort((a, b) => a.localeCompare(b));
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
    subcategory: "",
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
    subcategory: "",
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
  if (filters.subcategory && (item.subcategory || "") !== filters.subcategory) return false;
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
  const categories = getAllCategoryNames();
  const sel = document.getElementById("category-filter");
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = categories.includes(current) ? current : "";

  // Sub-category filter: only the sub-categories that exist within the
  // currently selected category (or all of them, if no category is picked).
  const relevant = items.filter((i) => !filters.category || i.category === filters.category);
  const subcats = [...new Set(relevant.map((i) => i.subcategory).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const subSel = document.getElementById("subcategory-filter");
  const currentSub = subSel.value;
  subSel.innerHTML = '<option value="">All sub-categories</option>' +
    subcats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  subSel.value = subcats.includes(currentSub) ? currentSub : "";
  if (!subcats.includes(currentSub)) filters.subcategory = "";
  subSel.closest(".toolbar") && (subSel.hidden = subcats.length === 0);
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
    const rows = byCategory[cat];
    const hasSubcats = rows.some((r) => r.subcategory);

    let itemsHtml;
    if (hasSubcats) {
      const bySub = {};
      for (const row of rows) {
        (bySub[row.subcategory || "Uncategorised"] ||= []).push(row);
      }
      const subNames = Object.keys(bySub).sort((a, b) => {
        if (a === "Uncategorised") return 1;
        if (b === "Uncategorised") return -1;
        return a.localeCompare(b);
      });
      itemsHtml = subNames.map((sub) => `
        <h3 class="subcategory-header">${esc(sub)}</h3>
        <div class="item-list">
          ${bySub[sub].sort((a, b) => a.name.localeCompare(b.name)).map(renderRow).join("")}
        </div>
      `).join("");
    } else {
      itemsHtml = `
        <div class="item-list">
          ${rows.slice().sort((a, b) => a.name.localeCompare(b.name)).map(renderRow).join("")}
        </div>
      `;
    }

    return `
      <section class="category-block">
        <div class="category-header">
          <h2>${esc(cat)}</h2>
          <span class="count">${rows.length} items · ${rows.reduce((s, r) => s + (r.quantity || 0), 0)} units</span>
        </div>
        ${itemsHtml}
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

const NEW_OPTION_VALUE = "__new__";

function populateCategorySelect(selectedCategory) {
  const sel = document.getElementById("item-category");
  const categories = getAllCategoryNames();
  sel.innerHTML = categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("") +
    `<option value="${NEW_OPTION_VALUE}">+ Add new category…</option>`;

  if (selectedCategory && !categories.includes(selectedCategory)) {
    sel.insertAdjacentHTML("afterbegin", `<option value="${esc(selectedCategory)}">${esc(selectedCategory)}</option>`);
  }
  sel.value = selectedCategory || categories[0] || NEW_OPTION_VALUE;
}

function toggleCategoryNewInput() {
  const sel = document.getElementById("item-category");
  const newInput = document.getElementById("item-category-new");
  const show = sel.value === NEW_OPTION_VALUE;
  newInput.hidden = !show;
  if (show) {
    newInput.value = "";
    newInput.focus();
  }
}

function currentCategoryValue() {
  const sel = document.getElementById("item-category");
  return sel.value === NEW_OPTION_VALUE
    ? document.getElementById("item-category-new").value.trim()
    : sel.value;
}

function populateSubcategorySelect(category, selectedSubcategory) {
  const sel = document.getElementById("item-subcategory");
  const subs = [...new Set(
    items.filter((i) => i.category === category && i.subcategory).map((i) => i.subcategory)
  )].sort((a, b) => a.localeCompare(b));

  sel.innerHTML = `<option value="">(none)</option>` +
    subs.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("") +
    `<option value="${NEW_OPTION_VALUE}">+ Add new sub-category…</option>`;

  if (selectedSubcategory && !subs.includes(selectedSubcategory)) {
    sel.insertAdjacentHTML("afterbegin", `<option value="${esc(selectedSubcategory)}">${esc(selectedSubcategory)}</option>`);
  }
  sel.value = selectedSubcategory || "";
}

function toggleSubcategoryNewInput() {
  const sel = document.getElementById("item-subcategory");
  const newInput = document.getElementById("item-subcategory-new");
  const show = sel.value === NEW_OPTION_VALUE;
  newInput.hidden = !show;
  if (show) {
    newInput.value = "";
    newInput.focus();
  }
}

function currentSubcategoryValue() {
  const sel = document.getElementById("item-subcategory");
  return sel.value === NEW_OPTION_VALUE
    ? document.getElementById("item-subcategory-new").value.trim()
    : sel.value;
}

function openDialog(id) {
  const dialog = document.getElementById("item-dialog");
  const item = id ? items.find((i) => i.id === id) : null;

  document.getElementById("dialog-title").textContent = item ? "Edit item" : "Add item";
  document.getElementById("item-id").value = item ? item.id : "";

  const category = item ? item.category : (filters.category || "");
  populateCategorySelect(category);
  toggleCategoryNewInput();

  populateSubcategorySelect(currentCategoryValue(), item ? item.subcategory || "" : "");
  toggleSubcategoryNewInput();

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

  document.getElementById("item-category").addEventListener("change", () => {
    toggleCategoryNewInput();
    populateSubcategorySelect(currentCategoryValue(), "");
    toggleSubcategoryNewInput();
  });
  document.getElementById("item-subcategory").addEventListener("change", () => {
    toggleSubcategoryNewInput();
  });

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
    const category = currentCategoryValue();
    if (!category) {
      e.preventDefault();
      alert("Please choose or type a category.");
      return;
    }
    const subcategory = currentSubcategoryValue();
    const photo_url = pendingPhotoDataUrl === undefined ? dialogExistingPhotoUrl : pendingPhotoDataUrl;
    const row = {
      id: document.getElementById("item-id").value || null,
      category,
      subcategory,
      name: document.getElementById("item-name").value.trim(),
      quantity: Number(document.getElementById("item-quantity").value) || 0,
      condition: document.getElementById("item-condition").value,
      notes: document.getElementById("item-notes").value.trim(),
      photo_url,
    };
    saveItem(row);
  });

  document.getElementById("delete-item-btn").addEventListener("click", () => {
    const id = document.getElementById("item-id").value;
    if (id && confirm("Delete this item?")) {
      deleteItem(id);
      dialog.close();
    }
  });
}

// ---------- backup / restore ----------

function backupData() {
  const payload = {
    app: "mataatua-inventory",
    exported_at: new Date().toISOString(),
    items,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `mataatua-inventory-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseBackupFile(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(list)) throw new Error("This doesn't look like a backup file (no item list found).");
  return list.filter((row) => row && typeof row === "object" && row.name && row.category);
}

async function restoreFromBackup(file) {
  let list;
  try {
    const text = await file.text();
    list = parseBackupFile(text);
  } catch (e) {
    alert("Couldn't read that backup file: " + e.message);
    return;
  }
  if (list.length === 0) {
    alert("That backup file has no items in it.");
    return;
  }
  const ok = confirm(
    `Restore ${list.length} item(s) from this backup?\n\n` +
    `Items with a matching ID will be overwritten with the backup's values. ` +
    `Anything already here that isn't in the backup will be left alone.`
  );
  if (!ok) return;

  for (const row of list) {
    await saveItem({
      id: row.id || null,
      category: String(row.category),
      subcategory: row.subcategory ? String(row.subcategory) : "",
      name: String(row.name),
      quantity: Number(row.quantity) || 0,
      condition: ["good", "needs_repair", "damaged", "missing"].includes(row.condition) ? row.condition : "good",
      notes: row.notes ? String(row.notes) : "",
      photo_url: row.photo_url || null,
    });
  }
  alert(`Restored ${list.length} item(s).`);
}

function setupBackupRestore() {
  document.getElementById("backup-btn").addEventListener("click", backupData);
  const restoreInput = document.getElementById("restore-input");
  document.getElementById("restore-btn").addEventListener("click", () => restoreInput.click());
  restoreInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await restoreFromBackup(file);
  });
}

// ---------- category manager ----------

function categoryItemCount(name) {
  return items.filter((i) => i.category === name).length;
}

function renderCategoryManager() {
  const names = getAllCategoryNames();
  const container = document.getElementById("category-list-manager");
  if (names.length === 0) {
    container.innerHTML = `<p class="category-manager-note">No categories yet — add one below.</p>`;
    return;
  }
  container.innerHTML = names.map((name) => `
    <div class="category-row" data-category="${esc(name)}">
      <input type="text" value="${esc(name)}" data-rename-input>
      <span class="category-count">${categoryItemCount(name)} item(s)</span>
      <button type="button" class="btn-outline" data-rename-btn>Rename</button>
      <button type="button" class="btn-danger" data-delete-btn>Delete</button>
    </div>
  `).join("");

  container.querySelectorAll("[data-rename-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".category-row");
      const oldName = row.dataset.category;
      const newName = row.querySelector("[data-rename-input]").value.trim();
      renameCategory(oldName, newName);
    });
  });
  container.querySelectorAll("[data-delete-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".category-row");
      deleteCategory(row.dataset.category);
    });
  });
}

async function renameCategory(oldName, newName) {
  if (!newName || newName === oldName) return;
  const affected = items.filter((i) => i.category === oldName);
  const ok = affected.length === 0
    ? true
    : confirm(`Rename "${oldName}" to "${newName}"? This updates ${affected.length} item(s).`);
  if (!ok) return;

  for (const item of affected) {
    await saveItem({ ...item, category: newName });
  }

  const extra = loadExtraCategories();
  const idx = extra.indexOf(oldName);
  if (idx >= 0) extra[idx] = newName;
  else if (affected.length === 0) extra.push(newName);
  saveExtraCategories([...new Set(extra)]);

  render();
  renderCategoryManager();
}

async function deleteCategory(name) {
  const affected = items.filter((i) => i.category === name);
  if (affected.length > 0) {
    const others = getAllCategoryNames().filter((c) => c !== name);
    const destination = prompt(
      `"${name}" has ${affected.length} item(s) in it. Type another category to move them into ` +
      `(or leave blank to cancel):\n\nExisting categories: ${others.join(", ") || "(none yet)"}`
    );
    if (!destination || !destination.trim()) return;
    for (const item of affected) {
      await saveItem({ ...item, category: destination.trim() });
    }
  } else {
    if (!confirm(`Delete the empty category "${name}"?`)) return;
  }

  saveExtraCategories(loadExtraCategories().filter((c) => c !== name));
  render();
  renderCategoryManager();
}

function addCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (getAllCategoryNames().includes(trimmed)) {
    alert(`"${trimmed}" already exists.`);
    return;
  }
  const extra = loadExtraCategories();
  extra.push(trimmed);
  saveExtraCategories(extra);
  render();
  renderCategoryManager();
}

function setupCategoryManager() {
  const dialog = document.getElementById("category-dialog");
  document.getElementById("manage-categories-btn").addEventListener("click", () => {
    renderCategoryManager();
    dialog.showModal();
  });
  document.getElementById("close-category-dialog-btn").addEventListener("click", () => dialog.close());
  document.getElementById("add-category-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("new-category-input");
    addCategory(input.value);
    input.value = "";
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
    filters.subcategory = "";
    render();
  });
  document.getElementById("subcategory-filter").addEventListener("change", (e) => {
    filters.subcategory = e.target.value;
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
    setupBackupRestore();
    setupDialog();
    setupQuickCamera();
    setupCategoryManager();
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

    setupAutoUpdate();
  } catch (e) {
    console.error("App failed to start", e);
    setStatus("error — see console", "offline");
  }
});

// ---------- auto-update ----------
//
// Whenever a newer version of the app is deployed, this makes the page
// reload itself to pick it up — nobody has to manually clear their
// browser's cache or reinstall the app on each device.

function setupAutoUpdate() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
    // Check for a newer sw.js right away, then again whenever the tab
    // regains focus (covers the common case of reopening an installed app).
    reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
  }).catch(() => {});

  // Once a new service worker takes over, reload so the fresh files
  // (index.html, app.js, etc.) actually get used instead of sitting
  // installed-but-unused until the next manual refresh.
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}
