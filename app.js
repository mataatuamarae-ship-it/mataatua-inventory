// Mataatua Inventory — offline-first stock + condition tracker.
//
// Data model: one flat table `inventory_items` (category, name, quantity,
// condition, notes). Local copy lives in localStorage so the app works with
// no connection; writes go to Supabase when reachable, otherwise they queue
// and flush once back online. Realtime keeps other devices in sync.

// View-only mode: same app, same live Supabase data, reached with
// ?view=readonly on the URL — no separate app/repo/deploy needed. When
// this is set, every control that changes data is hidden (see the
// "readonly-mode" CSS rules in style.css and the guards below), leaving
// only search/filter/print/history-viewing/photo-viewing. This is a
// UI-level lock, not real security — anyone who edits the URL by hand
// could still reach the full app — so it's meant for texting/emailing a
// look-up-only link to whānau, not for anything sensitive.
const READONLY_MODE = new URLSearchParams(location.search).get("view") === "readonly";

// Which categories a view-only link is allowed to show, read straight off
// its own URL (?categories=Kitchen,Bedding) — baked in by whoever built the
// link (see buildShareLink). No param at all means "show everything".
const READONLY_CATEGORY_FILTER = READONLY_MODE
  ? (new URLSearchParams(location.search).get("categories") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

function applyReadonlyCategoryFilter(list) {
  if (!READONLY_MODE || READONLY_CATEGORY_FILTER.length === 0) return list;
  return list.filter((item) => READONLY_CATEGORY_FILTER.includes(item.category));
}

// Bakes the categories chosen in Manage categories ("Show in view-only
// link") directly into the URL, so the link shows the right thing on
// whatever device it's opened on — not just this one. Returns null when
// every category is currently hidden, so the caller can stop and say so
// instead of handing out a link to an empty app.
function buildShareLink() {
  const allCats = getAllCategoryNames();
  const hidden = loadHiddenViewOnlyCategories();
  const visible = allCats.filter((c) => !hidden.includes(c));
  if (allCats.length > 0 && visible.length === 0) return null;

  let url = location.origin + location.pathname + "?view=readonly";
  if (visible.length > 0 && visible.length < allCats.length) {
    url += "&categories=" + encodeURIComponent(visible.join(","));
  }
  return url;
}

const LOCAL_KEY = "mataatua-inventory:items";
const QUEUE_KEY = "mataatua-inventory:pending-ops";
const CATEGORIES_KEY = "mataatua-inventory:categories";
const VIEW_ONLY_HIDDEN_CATEGORIES_KEY = "mataatua-inventory:view-only-hidden-categories";
const HISTORY_KEY = "mataatua-inventory:history";
const HISTORY_TOMBSTONE_KEY = "mataatua-inventory:history-tombstones";
const DEVICE_NAME_KEY = "mataatua-inventory:device-name";

// A name for this device/browser, shown against each history entry so you
// can tell which phone/tablet/computer made a change. Asked for once, the
// first time it's needed, then remembered — changeable any time from the
// History view. This is per-device only (not synced) — it just labels
// entries this device creates.
function getDeviceName() {
  const stored = localStorage.getItem(DEVICE_NAME_KEY);
  if (stored) return stored;
  return setDeviceName();
}

function setDeviceName() {
  const current = localStorage.getItem(DEVICE_NAME_KEY) || "";
  const name = prompt(
    "What should we call this device? (e.g. \"Jim's phone\", \"Kitchen tablet\")\n\n" +
    "This is shown next to changes in the History view.",
    current
  );
  const trimmed = (name || "").trim();
  const finalName = trimmed || current || "Unknown device";
  localStorage.setItem(DEVICE_NAME_KEY, finalName);
  return finalName;
}

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

// Best-effort localStorage write: never throws. Returns true on success.
// A failed write here should never abort a save — Supabase is the real
// source of truth for the synced app; the local copy is just a fast/
// offline mirror of it.
function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn("localStorage write failed for", key, e);
    return false;
  }
}

// The local mirror of `items` is what makes the app open instantly and
// work offline — but on a device with many items, embedded photos can
// push it over the browser's localStorage quota (typically 5-10MB).
// Supabase has no such limit, so a photo is never actually lost — if
// the full list won't fit locally, we keep photos on only the most
// recently updated items in the local copy (older ones just show their
// placeholder until they're re-fetched from Supabase) rather than let
// the whole save fail.
function saveLocal(list) {
  if (safeSetItem(LOCAL_KEY, JSON.stringify(list))) return;

  console.warn("Local item cache is full — trimming older cached photos to fit.");
  const byRecency = [...list].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const keepPhotoIds = new Set(byRecency.slice(0, 25).map((i) => i.id));
  const trimmed = list.map((item) =>
    item.photo_url && !keepPhotoIds.has(item.id) ? { ...item, photo_url: null } : item
  );
  if (safeSetItem(LOCAL_KEY, JSON.stringify(trimmed))) return;

  console.warn("Still over quota with recent photos only — dropping all cached photos locally.");
  const noPhotos = list.map((item) => (item.photo_url ? { ...item, photo_url: null } : item));
  safeSetItem(LOCAL_KEY, JSON.stringify(noPhotos));
}

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveQueue(q) {
  safeSetItem(QUEUE_KEY, JSON.stringify(q));
}

function queueOp(op) {
  const q = loadQueue();
  q.push(op);
  saveQueue(q);
}

// ---------- quantity history ----------
//
// Append-only log of quantity changes. Kept in Supabase (inventory_history
// table) so every device sees the same history, with the same offline
// queue-and-flush pattern as items — plus a local cache so the History view
// still works instantly and while offline.

function loadHistoryLocal() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistoryLocal(list) {
  safeSetItem(HISTORY_KEY, JSON.stringify(list));
}

async function recordHistory(entry) {
  const row = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
    ...entry,
  };
  saveHistoryLocal([...loadHistoryLocal(), row]);

  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("inventory_history").insert(row);
      if (error) throw error;
      return;
    } catch (e) {
      // fall through to queue
    }
  }
  queueOp({ type: "history", row });
}

// Ids we've deleted locally but haven't confirmed deleted on Supabase yet
// (e.g. deleted while offline). Kept out of the History view until the
// delete actually goes through, so a deleted row doesn't reappear just
// because it's still sitting in the remote table.
function loadHistoryTombstones() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_TOMBSTONE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistoryTombstones(list) {
  safeSetItem(HISTORY_TOMBSTONE_KEY, JSON.stringify(list));
}

function addHistoryTombstone(id) {
  const t = loadHistoryTombstones();
  if (!t.includes(id)) {
    t.push(id);
    saveHistoryTombstones(t);
  }
}

function clearHistoryTombstone(id) {
  saveHistoryTombstones(loadHistoryTombstones().filter((x) => x !== id));
}

async function fetchHistoryRemote() {
  const { data, error } = await supabaseClient
    .from("inventory_history")
    .select("*")
    .order("changed_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return data;
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
  safeSetItem(CATEGORIES_KEY, JSON.stringify(list));
}

function getAllCategoryNames() {
  const fromItems = items.map((i) => i.category).filter(Boolean);
  const fromExtra = loadExtraCategories();
  return [...new Set([...fromItems, ...fromExtra])].sort((a, b) => a.localeCompare(b));
}

// Which categories are left out of the view-only link — set once here (in
// Manage categories), used by every view-only link generated after that
// until changed again. Lives only on this device, same as extra categories
// do — but that's fine, because the chosen set gets baked directly into
// each link's URL when it's created (see buildShareLink), so the link
// itself carries the restriction to whoever opens it, on any device.
function loadHiddenViewOnlyCategories() {
  try {
    return JSON.parse(localStorage.getItem(VIEW_ONLY_HIDDEN_CATEGORIES_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHiddenViewOnlyCategories(list) {
  safeSetItem(VIEW_ONLY_HIDDEN_CATEGORIES_KEY, JSON.stringify(list));
}

function isCategoryHiddenFromViewOnly(name) {
  return loadHiddenViewOnlyCategories().includes(name);
}

function setCategoryHiddenFromViewOnly(name, hidden) {
  const list = loadHiddenViewOnlyCategories();
  const idx = list.indexOf(name);
  if (hidden && idx < 0) list.push(name);
  if (!hidden && idx >= 0) list.splice(idx, 1);
  saveHiddenViewOnlyCategories(list);
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
        const { error } = await supabaseClient.from("inventory_items").upsert(withoutLocalUpdatedAt(op.row));
        if (error) throw error;
      } else if (op.type === "delete") {
        const { error } = await supabaseClient.from("inventory_items").delete().eq("id", op.id);
        if (error) throw error;
      } else if (op.type === "history") {
        const { error } = await supabaseClient.from("inventory_history").upsert(op.row);
        if (error) throw error;
      } else if (op.type === "history-delete") {
        const { error } = await supabaseClient.from("inventory_history").delete().eq("id", op.id);
        if (error) throw error;
        clearHistoryTombstone(op.id);
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
  // Read-only mode never writes anything — not a queued edit, not the
  // first-run seed — so it takes its own simpler, read-only path: fetch
  // and show, nothing else.
  if (READONLY_MODE) {
    if (!supabaseClient) {
      setStatus("viewing local copy — not connected", "offline");
      items = applyReadonlyCategoryFilter(loadLocal());
      render();
      return;
    }
    setStatus("loading…", "syncing");
    try {
      const fetched = await fetchRemote();
      saveLocal(fetched); // cache the full list, unfiltered
      items = applyReadonlyCategoryFilter(fetched);
      setStatus("live", "online");
    } catch (e) {
      console.warn("Fetch failed, using local cache", e);
      items = applyReadonlyCategoryFilter(loadLocal());
      setStatus("offline — showing last loaded copy", "offline");
    }
    render();
    return;
  }

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
    .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items" }, (payload) => {
      applyRealtimeChange(payload);
    })
    .subscribe();
}

// Applies just the one row a realtime event is about, instead of
// re-fetching the whole item list (photos included) on every single
// change from anywhere — that full-refetch-per-edit pattern is what was
// driving egress usage up. A periodic full syncAll() (see the
// visibilitychange listener in the boot sequence) still runs as a
// safety net, so a missed or out-of-order event self-heals.
function applyRealtimeChange(payload) {
  const type = payload.eventType || payload.event;

  if (type === "DELETE") {
    const id = payload.old && payload.old.id;
    if (!id) return;
    if (READONLY_MODE) {
      items = items.filter((i) => i.id !== id);
    } else {
      localDelete(id);
    }
    render();
    return;
  }

  const row = payload.new;
  if (!row || !row.id) return;

  if (READONLY_MODE) {
    const allowed = READONLY_CATEGORY_FILTER.length === 0 || READONLY_CATEGORY_FILTER.includes(row.category);
    const idx = items.findIndex((i) => i.id === row.id);
    if (allowed) {
      if (idx >= 0) items[idx] = row;
      else items.push(row);
    } else if (idx >= 0) {
      items.splice(idx, 1);
    }
    render();
    return;
  }

  localUpsert(row);
  render();
}

// ---------- CRUD ----------

// The database sets updated_at itself, on both insert and update (see the
// set_updated_at trigger in supabase-schema.sql) — it's the single source
// of truth for that column. The client still stamps a local updated_at on
// `row` for its own immediate/optimistic use (sorting which items keep
// their cached photo locally, see saveLocal), but that value is stripped
// out before anything is actually sent to Supabase, so it never fights
// with what the trigger sets.
function withoutLocalUpdatedAt(row) {
  const { updated_at, ...rest } = row;
  return rest;
}

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
  const previous = isNew ? null : items.find((i) => i.id === row.id);
  if (isNew) {
    row.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  }
  row.updated_at = new Date().toISOString();

  const oldQty = previous ? (previous.quantity || 0) : 0;
  const newQty = row.quantity || 0;
  if (oldQty !== newQty && (previous || newQty > 0)) {
    recordHistory({
      item_id: row.id,
      item_name: row.name,
      category: row.category,
      subcategory: row.subcategory || "",
      old_quantity: oldQty,
      new_quantity: newQty,
      changed_at: row.updated_at,
      device_name: getDeviceName(),
    }).catch(() => {});
  }

  localUpsert(row);
  render();

  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("inventory_items").upsert(withoutLocalUpdatedAt(row));
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
  // Any real render pass means we have something to show one way or
  // another (items, or a genuine empty state) — so the "first ever load,
  // nothing cached yet" placeholder is done regardless of which of those
  // this particular pass turns out to be.
  const loadingEl = document.getElementById("loading-state");
  if (loadingEl) loadingEl.hidden = true;

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
      if (READONLY_MODE) return;
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
  container.querySelectorAll("[data-view-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPhotoView(btn.dataset.viewId);
    });
  });
}

function renderRow(item) {
  const notes = item.notes ? `<span class="item-notes">${esc(item.notes)}</span>` : "";
  const thumb = item.photo_url
    ? `<img class="item-thumb" src="${item.photo_url}" alt="">`
    : `<span class="item-thumb-placeholder">📷</span>`;
  const viewBtn = item.photo_url
    ? `<button type="button" class="view-photo-btn" data-view-id="${item.id}" title="Open photo">🔍</button>`
    : "";
  return `
    <div class="item-row" data-id="${item.id}">
      <div class="thumb-wrap">
        <button type="button" class="thumb-btn" data-camera-id="${item.id}" title="Take/change photo">${thumb}</button>
        ${viewBtn}
      </div>
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
function loadImageViaObjectUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("object-url decode failed"));
    };
    img.src = url;
    img.dataset.objectUrl = url;
  });
}

function loadImageViaDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("data-url decode failed"));
      img.onload = () => resolve(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Try up to three ways to decode the photo, from cheapest-on-memory to
// most compatible, so a phone/browser quirk in one method doesn't sink
// the whole thing. If all three fail, the error message says which
// methods were tried and why, so a report from the field is actually
// diagnosable instead of a generic "couldn't read it".
function loadImageSource(file) {
  const attempts = [];
  let chain = Promise.reject(null);
  if (window.createImageBitmap) {
    chain = chain.catch(() =>
      createImageBitmap(file).catch((err) => {
        attempts.push("createImageBitmap: " + describeErr(err));
        throw err;
      })
    );
  }
  chain = chain.catch(() =>
    loadImageViaObjectUrl(file).catch((err) => {
      attempts.push("object-url: " + describeErr(err));
      throw err;
    })
  );
  chain = chain.catch(() =>
    loadImageViaDataUrl(file).catch((err) => {
      attempts.push("data-url: " + describeErr(err));
      throw err;
    })
  );
  return chain.catch(() => {
    throw new Error(attempts.join(" | ") || "no decode method available");
  });
}

function describeErr(err) {
  if (!err) return "unknown";
  return err.message || err.name || String(err);
}

function resizeImageFile(file, maxDim = 900, quality = 0.6) {
  return loadImageSource(file).then((img) => {
    let width = img.width;
    let height = img.height;
    if (!width || !height) {
      throw new Error(`image had no size (${width}x${height}, type ${file.type || "unknown"}, ${file.size} bytes)`);
    }
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
    if (typeof img.close === "function") img.close();
    if (img.dataset && img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
    try {
      return canvas.toDataURL("image/jpeg", quality);
    } catch (err) {
      throw new Error("canvas export failed: " + describeErr(err));
    }
  });
}

// ---------- photo viewer (open the magnifier icon on a row) ----------

function openPhotoView(itemId) {
  const item = items.find((i) => i.id === itemId);
  if (!item || !item.photo_url) return;
  document.getElementById("photo-view-img").src = item.photo_url;
  document.getElementById("photo-view-dialog").showModal();
}

function setupPhotoView() {
  document.getElementById("close-photo-view-btn").addEventListener("click", () => {
    document.getElementById("photo-view-dialog").close();
  });
  document.getElementById("photo-view-dialog").addEventListener("close", () => {
    document.getElementById("photo-view-img").src = "";
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
      alert("Sorry, couldn't read that photo — try another one.\n\n(" + (err && err.message ? err.message : "unknown error") + ")");
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
      alert("Sorry, couldn't read that photo — try another one.\n\n(" + (err && err.message ? err.message : "unknown error") + ")");
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

async function backupData() {
  const history = await loadHistoryForView();
  const payload = {
    app: "mataatua-inventory",
    exported_at: new Date().toISOString(),
    items,
    history,
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
  const items = list.filter((row) => row && typeof row === "object" && row.name && row.category);
  // Older backups (from before history was included) simply won't have
  // this key — that's fine, it just means nothing to restore there.
  const historyRaw = Array.isArray(data.history) ? data.history : [];
  const history = historyRaw.filter((row) => row && typeof row === "object" && row.item_name);
  return { items, history };
}

// Writes one history entry back exactly as it was in the backup — same id
// and changed_at, not a freshly-generated one — so restoring is an upsert
// (overwrite-if-matching) rather than creating duplicate log entries.
async function restoreHistoryEntry(entry) {
  const row = {
    id: entry.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    item_id: entry.item_id || null,
    item_name: String(entry.item_name || ""),
    category: entry.category ? String(entry.category) : "",
    subcategory: entry.subcategory ? String(entry.subcategory) : "",
    old_quantity: Number(entry.old_quantity) || 0,
    new_quantity: Number(entry.new_quantity) || 0,
    changed_at: entry.changed_at || new Date().toISOString(),
    device_name: entry.device_name ? String(entry.device_name) : "",
  };
  saveHistoryLocal([...loadHistoryLocal().filter((h) => h.id !== row.id), row]);

  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("inventory_history").upsert(row);
      if (error) throw error;
      return;
    } catch (e) {
      // fall through to queue
    }
  }
  queueOp({ type: "history", row });
}

async function restoreFromBackup(file) {
  let parsed;
  try {
    const text = await file.text();
    parsed = parseBackupFile(text);
  } catch (e) {
    alert("Couldn't read that backup file: " + e.message);
    return;
  }
  const { items: list, history: historyList } = parsed;
  if (list.length === 0 && historyList.length === 0) {
    alert("That backup file has no items or history in it.");
    return;
  }

  const parts = [];
  if (list.length > 0) parts.push(`${list.length} item(s)`);
  if (historyList.length > 0) parts.push(`${historyList.length} history entr${historyList.length === 1 ? "y" : "ies"}`);
  const ok = confirm(
    `Restore ${parts.join(" and ")} from this backup?\n\n` +
    `Anything with a matching ID will be overwritten with the backup's values. ` +
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

  // A history entry that was deliberately deleted on this device (its id
  // is tombstoned) stays deleted — an old backup shouldn't resurrect it.
  const tombstones = new Set(loadHistoryTombstones());
  let restoredHistoryCount = 0;
  for (const entry of historyList) {
    if (entry.id && tombstones.has(entry.id)) continue;
    await restoreHistoryEntry(entry);
    restoredHistoryCount++;
  }

  const summary = [];
  if (list.length > 0) summary.push(`${list.length} item(s)`);
  if (restoredHistoryCount > 0) summary.push(`${restoredHistoryCount} history entr${restoredHistoryCount === 1 ? "y" : "ies"}`);
  alert(`Restored ${summary.join(" and ") || "nothing (everything was skipped)"}.`);
}

// Wipes every item and history entry for EVERYONE — this is the shared
// Supabase database, not just this device, so a deletion here removes it
// for every phone/tablet/computer using this app. Deliberately hard to
// trigger by accident: a confirm dialog explaining exactly that, then a
// typed "DELETE" before anything happens. Requires being online, since
// this has to actually reach Supabase rather than being queued.
async function clearAllData() {
  if (!supabaseClient) {
    alert("This device needs to be online to clear the shared data — try again once connected.");
    return;
  }
  const ok = confirm(
    "This permanently deletes EVERY item, photo and history entry — for everyone, on every device that uses this app. " +
    "This cannot be undone.\n\n" +
    "If you want a copy first, cancel this and use the Backup button instead.\n\n" +
    "Continue?"
  );
  if (!ok) return;
  const typed = prompt('Type DELETE (in capitals) to confirm you want to erase everything for everyone:');
  if (typed !== "DELETE") {
    alert("Cancelled — nothing was deleted.");
    return;
  }

  setStatus("clearing…", "syncing");
  try {
    // A delete with no matching real row ever equals this all-zero id,
    // so this removes every row in the table.
    const NIL = "00000000-0000-0000-0000-000000000000";
    const { error: e1 } = await supabaseClient.from("inventory_history").delete().neq("id", NIL);
    if (e1) throw e1;
    const { error: e2 } = await supabaseClient.from("inventory_items").delete().neq("id", NIL);
    if (e2) throw e2;
  } catch (e) {
    alert("Couldn't clear the shared data: " + (e && e.message ? e.message : e));
    setStatus("online", "online");
    return;
  }

  // Clear every local trace too, including anything still queued from
  // before this — it would only try to recreate what we just deleted.
  items = [];
  saveLocal(items);
  saveHistoryLocal([]);
  saveHistoryTombstones([]);
  saveQueue([]);
  saveExtraCategories([]);
  filters = { search: "", category: "", subcategory: "", condition: "", attentionOnly: false };
  render();
  setStatus("online", "online");
  alert("All data has been cleared for everyone.");
}

function setupBackupRestore() {
  document.getElementById("backup-btn").addEventListener("click", () => {
    backupData().catch((e) => {
      console.warn("Backup failed", e);
      alert("Something went wrong creating the backup: " + (e && e.message ? e.message : e));
    });
  });
  document.getElementById("clear-all-btn").addEventListener("click", () => {
    clearAllData().catch((e) => {
      console.warn("Could not clear data", e);
      alert("Something went wrong: " + (e && e.message ? e.message : e));
    });
  });
  const restoreInput = document.getElementById("restore-input");
  document.getElementById("restore-btn").addEventListener("click", () => restoreInput.click());
  restoreInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await restoreFromBackup(file);
  });
}

// ---------- share view-only link ----------
//
// Builds a link back to this same app with ?view=readonly on it, so
// there's nothing separate to deploy or keep in sync — for texting/
// emailing to whānau who just need to look something up, not touch it.

async function copyShareLink() {
  const link = buildShareLink();
  if (!link) {
    alert("Every category is hidden from view-only links right now — turn at least one back on in Manage categories first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    alert("View-only link copied — paste it into a text, WhatsApp, email, wherever.");
  } catch (e) {
    // Clipboard access blocked (permissions, non-secure context, etc.) —
    // fall back to just showing the link so it can be copied by hand.
    prompt("Copy this view-only link:", link);
  }
}

function emailShareLink() {
  const link = buildShareLink();
  if (!link) {
    alert("Every category is hidden from view-only links right now — turn at least one back on in Manage categories first.");
    return;
  }
  const subject = "Mataatua Inventory (view only)";
  const body =
    "Here's a view-only link to the Mataatua Inventory — you can look things up, " +
    "search and filter, but nothing can be changed from it:\n\n" + link;
  window.location.href =
    "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}

function setupShareLink() {
  document.getElementById("copy-share-link-btn").addEventListener("click", () => {
    copyShareLink().catch((e) => {
      console.warn("Could not copy share link", e);
      const link = buildShareLink();
      if (link) prompt("Copy this view-only link:", link);
    });
  });
  document.getElementById("email-share-link-btn").addEventListener("click", emailShareLink);
}

// ---------- history view ----------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function loadHistoryForView() {
  const local = loadHistoryLocal();
  let combined;
  if (!supabaseClient) {
    combined = local;
  } else {
    try {
      const remote = await fetchHistoryRemote();
      // Merge: remote is the source of truth, but keep any locally-recorded
      // entries that haven't made it to Supabase yet (still queued/offline).
      const remoteIds = new Set(remote.map((h) => h.id));
      const stillLocalOnly = local.filter((h) => !remoteIds.has(h.id));
      combined = [...remote, ...stillLocalOnly];
    } catch (e) {
      console.warn("Couldn't fetch history from Supabase, showing local copy", e);
      combined = local;
    }
  }
  const tombstones = new Set(loadHistoryTombstones());
  return combined.filter((h) => !tombstones.has(h.id));
}

async function renderHistoryView() {
  const container = document.getElementById("history-list");
  container.innerHTML = `<p class="category-manager-note">Loading…</p>`;
  const history = (await loadHistoryForView()).slice().sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));

  if (history.length === 0) {
    container.innerHTML = `<p class="category-manager-note">No quantity changes recorded yet — adjustments made from now on will show up here.</p>`;
    return;
  }

  const groups = {};
  for (const h of history) {
    const d = new Date(h.changed_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    (groups[key] ||= []).push(h);
  }
  const keys = Object.keys(groups).sort().reverse();

  container.innerHTML = keys.map((key) => {
    const [y, m] = key.split("-");
    return `
      <div class="history-month">
        <div class="history-month-header">
          <h3>${MONTH_NAMES[Number(m) - 1]} ${y}</h3>
          <button type="button" class="btn-outline history-delete-month" data-month-key="${key}">Delete month</button>
        </div>
        <div class="history-rows">
          ${groups[key].map(renderHistoryRow).join("")}
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-delete-history]").forEach((btn) => {
    btn.addEventListener("click", () => deleteHistoryEntry(btn.dataset.deleteHistory));
  });
  container.querySelectorAll(".history-delete-month").forEach((btn) => {
    btn.addEventListener("click", () => deleteHistoryMonth(btn.dataset.monthKey));
  });
}

function renderHistoryRow(h) {
  const d = new Date(h.changed_at);
  const dateStr = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const delta = h.new_quantity - h.old_quantity;
  const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
  const deltaClass = delta > 0 ? "history-up" : delta < 0 ? "history-down" : "history-flat";
  const catLabel = [h.category, h.subcategory].filter(Boolean).join(" · ");
  const deviceLabel = h.device_name ? ` <span class="history-device">— ${esc(h.device_name)}</span>` : "";
  return `
    <div class="history-row">
      <span class="history-date">${dateStr}</span>
      <span class="history-item">${esc(h.item_name)}${catLabel ? ` <span class="history-cat">(${esc(catLabel)})</span>` : ""}${deviceLabel}</span>
      <span class="history-change">${h.old_quantity} → ${h.new_quantity} <span class="${deltaClass}">(${deltaStr})</span></span>
      <button type="button" class="history-delete-row" data-delete-history="${h.id}" title="Delete this entry">✕</button>
    </div>
  `;
}

async function deleteHistoryEntry(id) {
  if (!confirm("Delete this history entry?")) return;
  addHistoryTombstone(id);
  saveHistoryLocal(loadHistoryLocal().filter((h) => h.id !== id));
  renderHistoryView();

  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("inventory_history").delete().eq("id", id);
      if (error) throw error;
      clearHistoryTombstone(id);
      return;
    } catch (e) {
      // fall through to queue
    }
  }
  queueOp({ type: "history-delete", id });
}

async function deleteHistoryMonth(key) {
  const [y, m] = key.split("-");
  const label = `${MONTH_NAMES[Number(m) - 1]} ${y}`;
  const current = await loadHistoryForView();
  const matching = current.filter((h) => {
    const d = new Date(h.changed_at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === key;
  });
  if (matching.length === 0) return;
  if (!confirm(`Delete all ${matching.length} history entries from ${label}? This can't be undone.`)) return;

  const matchingIds = new Set(matching.map((h) => h.id));
  matchingIds.forEach(addHistoryTombstone);
  saveHistoryLocal(loadHistoryLocal().filter((h) => !matchingIds.has(h.id)));
  renderHistoryView();

  for (const h of matching) {
    if (supabaseClient) {
      try {
        const { error } = await supabaseClient.from("inventory_history").delete().eq("id", h.id);
        if (error) throw error;
        clearHistoryTombstone(h.id);
        continue;
      } catch (e) {
        // fall through to queue
      }
    }
    queueOp({ type: "history-delete", id: h.id });
  }
}

function refreshDeviceNameLabel() {
  document.getElementById("device-name-label").textContent =
    localStorage.getItem(DEVICE_NAME_KEY) || "(not set yet)";
}

function setupHistory() {
  const dialog = document.getElementById("history-dialog");
  document.getElementById("view-history-btn").addEventListener("click", () => {
    dialog.showModal();
    renderHistoryView();
    refreshDeviceNameLabel();
  });
  document.getElementById("close-history-dialog-btn").addEventListener("click", () => dialog.close());
  document.getElementById("change-device-btn").addEventListener("click", () => {
    setDeviceName();
    refreshDeviceNameLabel();
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
      <div class="category-row-top">
        <input type="text" value="${esc(name)}" data-rename-input>
        <span class="category-count">${categoryItemCount(name)} item(s)</span>
        <label class="view-only-checkbox">
          <input type="checkbox" data-visible-checkbox ${isCategoryHiddenFromViewOnly(name) ? "" : "checked"}>
          Show in view-only link
        </label>
      </div>
      <div class="category-row-actions">
        <button type="button" class="btn-outline" data-rename-btn>Rename</button>
        <button type="button" class="btn-danger" data-delete-btn>Delete</button>
      </div>
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
  container.querySelectorAll("[data-visible-checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const row = cb.closest(".category-row");
      setCategoryHiddenFromViewOnly(row.dataset.category, !cb.checked);
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

  if (isCategoryHiddenFromViewOnly(oldName)) {
    setCategoryHiddenFromViewOnly(oldName, false);
    setCategoryHiddenFromViewOnly(newName, true);
  }

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
  setCategoryHiddenFromViewOnly(name, false);
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

  setupMoreMenu();
}

// The "More" menu (Manage categories / Backup / Restore / Share links /
// Clear all data) is a native <details> element — closes it after picking
// an action inside it, or on an outside click, so it doesn't sit open
// behind whatever dialog/prompt that action opens.
function setupMoreMenu() {
  const menu = document.getElementById("more-menu");
  if (!menu) return;

  menu.querySelectorAll(".more-menu-panel button").forEach((btn) => {
    btn.addEventListener("click", () => { menu.open = false; });
  });

  document.addEventListener("click", (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}

// ---------- read-only mode ----------

function setupReadonlyMode() {
  if (!READONLY_MODE) return;
  document.body.classList.add("readonly-mode");
  document.title = "Mataatua Inventory (View Only)";
  const tag = document.getElementById("view-only-tag");
  if (tag) tag.hidden = false;
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
    setupReadonlyMode();
    setupToolbar();
    setupBackupRestore();
    setupShareLink();
    setupDialog();
    setupQuickCamera();
    setupPhotoView();
    setupCategoryManager();
    setupHistory();
    setupInstall();

    items = applyReadonlyCategoryFilter(loadLocal());
    render();
    // Genuinely nothing cached yet (first-ever open on this device) — say
    // so instead of leaving the list looking empty/broken while the first
    // syncAll() below is still in flight. Any later render (from syncAll,
    // a filter, a realtime patch, ...) clears this via renderCategories().
    if (items.length === 0) {
      document.getElementById("loading-state").hidden = false;
      document.getElementById("empty-state").hidden = true;
    }

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

    // Safety net for the realtime patching above: a full re-sync whenever
    // the tab regains focus, in case an event was missed (e.g. this
    // device was asleep/offline when it fired). Deliberately not on a
    // timer — only when someone's actually back looking at it.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncAll();
    });

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
