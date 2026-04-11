/* Klaar – front-end logic */
const KLAAR_VERSION = "0.9.10";
console.log(`Klaar v${KLAAR_VERSION}`);

(function initTheme() {
  const saved = localStorage.getItem("klaar-theme");
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  }
  const btn = document.getElementById("btn-theme-toggle");
  function updateIcon() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
      (!document.documentElement.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    btn.textContent = dark ? "\u2600" : "\u263E";
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }
  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const isDark = current === "dark" ||
      (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("klaar-theme", next);
    updateIcon();
  });
  updateIcon();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateIcon);
})();

// On-screen debug log (mobile only — long-press title to toggle)
const _dbgEl = document.getElementById("debug-log");
const _isMobile = window.matchMedia("(max-width: 768px)").matches;
function dbg(msg) {
  console.log(msg);
  if (!_isMobile || !_dbgEl) return;
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  _dbgEl.appendChild(line);
  _dbgEl.scrollTop = _dbgEl.scrollHeight;
}

dbg(`UA: ${navigator.userAgent}`);
dbg(`Standalone: ${window.navigator.standalone ?? "N/A"}`);

const API = "/api";

// DOM refs
const listIndex = document.getElementById("list-index");
const listView = document.getElementById("list-view");
const emptyState = document.getElementById("empty-state");
const listTitle = document.getElementById("list-title");
const itemsEl = document.getElementById("items");
const btnNewList = document.getElementById("btn-new-list");
const collapseBar = document.getElementById("collapse-bar");
const foldGutter = document.getElementById("fold-gutter");
const tagPane = document.getElementById("tag-pane");
const tagListEl = document.getElementById("tag-list");
const btnNewTag = document.getElementById("btn-new-tag");
const searchInput = document.getElementById("search-input");
const filterBar = document.getElementById("filter-bar");

const mobileQuery = window.matchMedia("(max-width: 768px)");
let currentListId = null;
let currentItems = [];          // latest items from server
let currentTags = [];           // tag definitions for current list
const collapsedIds = new Set();  // client-side collapse state
const selectedIds = new Set();   // client-side selection state
let lastSelectedId = null;       // anchor for shift-click range selection
const hiddenTagIds = new Set();  // client-side tag visibility state
const textFilters = [];          // [{pattern: string, regex: RegExp}]
const tagFilters = [];           // [{tagId, condition}] — multiple per tag allowed
let currentSort = null;          // {tagId, direction: "asc"|"desc"} or null
let completionFilter = "all";    // "all" | "active" | "done"
let currentViews = [];           // [{id, name, ...state}]
let activeViewId = null;         // currently applied view

// -------------------------------------------------------------------
// API helpers
// -------------------------------------------------------------------

// -------------------------------------------------------------------
// Item tag helpers (tags are [{id, value}, ...])
// -------------------------------------------------------------------

function itemHasTag(item, tagId) {
  return item.tags.some((t) => t.id === tagId);
}

function itemTagValue(item, tagId) {
  const t = item.tags.find((t) => t.id === tagId);
  return t ? t.value : undefined;
}

function addTagToItem(item, tagId, value = null) {
  if (!itemHasTag(item, tagId)) {
    item.tags.push({ id: tagId, value });
  }
}

function removeTagFromItemData(item, tagId) {
  item.tags = item.tags.filter((t) => t.id !== tagId);
}

function setTagValue(item, tagId, value) {
  const t = item.tags.find((t) => t.id === tagId);
  if (t) t.value = value;
}

// Format ISO date strings as friendly relative labels
function friendlyDate(val) {
  if (!val || typeof val !== "string") return null;
  // Match ISO dates: 2026-04-10, 2026-04-10T14:30:00Z, etc.
  if (!/^\d{4}-\d{2}-\d{2}/.test(val)) return null;

  // Date-only strings (YYYY-MM-DD) must be parsed as local, not UTC
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(val);
  let parsed;
  if (dateOnly) {
    const [y, m, d] = val.split("-").map(Number);
    parsed = new Date(y, m - 1, d);
  } else {
    parsed = new Date(val);
  }
  if (isNaN(parsed)) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const diffDays = Math.round((target - today) / 86400000);

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let label;
  if (diffDays === 0) label = "Today";
  else if (diffDays === 1) label = "Tomorrow";
  else if (diffDays === -1) label = "Yesterday";
  else if (diffDays >= 2 && diffDays <= 6) label = `This ${dayNames[target.getDay()]}`;
  else if (diffDays === 7) label = `Next ${dayNames[target.getDay()]}`;
  else if (diffDays >= -6 && diffDays <= -2) label = `Last ${dayNames[target.getDay()]}`;
  else {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const yr = target.getFullYear() !== now.getFullYear() ? `, ${target.getFullYear()}` : "";
    label = `${months[target.getMonth()]} ${target.getDate()}${yr}`;
  }

  // Append time if non-midnight
  if (parsed.getHours() !== 0 || parsed.getMinutes() !== 0) {
    label += " " + parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return label;
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "/";
    return null;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return { error: "not json", status: res.status };
  return res.json();
}

// -------------------------------------------------------------------
// Lists
// -------------------------------------------------------------------

async function loadLists() {
  const lists = await api("/lists");
  listIndex.innerHTML = "";
  for (const l of lists) {
    const li = document.createElement("li");
    li.dataset.id = l.id;
    if (l.id === currentListId) li.classList.add("active");

    const nameSpan = document.createElement("span");
    nameSpan.className = "list-name";
    nameSpan.textContent = l.name;

    const delBtn = document.createElement("button");
    delBtn.className = "list-delete-btn";
    delBtn.textContent = "\u00d7";
    const isShared = l.owner && l.owner !== currentUserId;
    delBtn.title = isShared ? "Leave list" : "Delete list";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isShared) {
        leaveList(l.id, l.name);
      } else {
        deleteListById(l.id, l.name);
      }
    });

    if (l.owner && l.owner !== currentUserId) {
      const shared = document.createElement("span");
      shared.className = "list-shared-icon";
      shared.textContent = "\u{1F465}";
      shared.title = "Shared with you";
      nameSpan.prepend(shared);
    }
    li.append(nameSpan, delBtn);
    li.addEventListener("click", () => selectList(l.id));
    li.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startListRename(li, l.id, l.name);
    });
    li.addEventListener("mousedown", (e) => {
      if (e.target.closest(".list-delete-btn")) return;
      onListMouseDown(e, li);
    });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showListContextMenu(e, l.id, l.name, l.owner);
    });
    if (mobileQuery.matches) {
      let lpTimer = null;
      li.addEventListener("touchstart", (te) => {
        lpTimer = setTimeout(() => {
          lpTimer = null;
          showListContextMenu(
            { preventDefault() {}, clientX: te.touches[0].clientX, clientY: te.touches[0].clientY },
            l.id, l.name, l.owner
          );
        }, 500);
      }, { passive: true });
      li.addEventListener("touchmove", () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
      li.addEventListener("touchend", () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
    }
    listIndex.appendChild(li);
  }
}

function startListRename(li, listId, currentName) {
  li.innerHTML = "";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "list-rename-input";
  inp.value = currentName;
  li.appendChild(inp);
  inp.focus();
  inp.select();
  function commit() {
    const name = inp.value.trim();
    if (name && name !== currentName) {
      api(`/lists/${listId}`, { method: "PATCH", body: { name } }).then(() => loadLists());
      if (listId === currentListId) listTitle.textContent = name;
    } else {
      loadLists();
    }
  }
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { inp.value = currentName; inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener("click", (e) => e.stopPropagation());
}

async function deleteListById(listId, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  await api(`/lists/${listId}`, { method: "DELETE" });
  if (listId === currentListId) {
    currentListId = null;
    listView.classList.add("hidden");
    tagPane.classList.add("hidden");
    emptyState.classList.remove("hidden");
  }
  await loadLists();
}

// List drag-and-drop reordering
function onListMouseDown(e, dragLi) {
  const startY = e.clientY;
  let started = false;
  let ghost = null;
  const items = Array.from(listIndex.children);
  const itemHeight = dragLi.getBoundingClientRect().height;
  const listRect = listIndex.getBoundingClientRect();

  function onMove(me) {
    const dy = Math.abs(me.clientY - startY);
    if (!started && dy >= 5) {
      started = true;
      document.body.style.userSelect = "none";
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.style.width = dragLi.getBoundingClientRect().width + "px";
      ghost.textContent = dragLi.querySelector(".list-name")?.textContent || "";
      ghost.style.left = dragLi.getBoundingClientRect().left + "px";
      ghost.style.top = dragLi.getBoundingClientRect().top + "px";
      document.body.appendChild(ghost);
      dragLi.classList.add("drag-source");
    }
    if (!started) return;
    ghost.style.top = (me.clientY - (itemHeight / 2)) + "px";
    // Determine target position
    const relY = me.clientY - listRect.top + listIndex.scrollTop;
    let targetIdx = Math.round(relY / itemHeight);
    targetIdx = Math.max(0, Math.min(targetIdx, items.length - 1));
    const currentIdx = items.indexOf(dragLi);
    if (targetIdx !== currentIdx) {
      items.splice(currentIdx, 1);
      items.splice(targetIdx, 0, dragLi);
      listIndex.innerHTML = "";
      items.forEach(li => listIndex.appendChild(li));
    }
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (started) {
      document.body.style.userSelect = "";
      if (ghost) ghost.remove();
      dragLi.classList.remove("drag-source");
      // Save new order
      const order = Array.from(listIndex.children).map(li => li.dataset.id);
      api("/me", { method: "PATCH", body: { list_order: order } });
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

async function selectList(id) {
  if (mobileQuery.matches) closePanels();
  currentListId = id;
  collapsedIds.clear();
  const data = await api(`/lists/${id}`);
  if (!data || data.error) {
    currentListId = null;
    listView.classList.add("hidden");
    tagPane.classList.add("hidden");
    emptyState.classList.remove("hidden");
    await loadLists();
    return;
  }
  currentItems = data.items;
  currentTags = data.tags || [];
  currentViews = data.views || [];
  knownVersion = data.version ?? null;
  activeViewId = null;
  // Clear all filters and view state from previous list
  textFilters.length = 0;
  tagFilters.length = 0;
  currentSort = null;
  completionFilter = "all";
  selectedIds.clear();
  lastSelectedId = null;
  hiddenTagIds.clear();
  searchInput.value = "";
  // Restore last-used view if one was saved
  const savedViewId = data.active_view;
  if (savedViewId) {
    const savedView = currentViews.find((v) => v.id === savedViewId);
    if (savedView) {
      activeViewId = savedViewId;
      applyViewState(savedView);
    }
  }
  listTitle.textContent = data.name;
  emptyState.classList.add("hidden");
  listView.classList.remove("hidden");
  tagPane.classList.remove("hidden");
  renderFilterBar();
  renderItems();
  renderTagPane();
  renderViewPane();
  listIndex.querySelectorAll("li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === id);
  });
  if (currentItems.length === 0) {
    addItemAfter(null, 0);
  }
  startPolling();
}

async function refreshItems() {
  const data = await api(`/lists/${currentListId}`);
  if (!data || data.error) return;
  currentItems = data.items;
  currentTags = data.tags || [];
  currentViews = data.views || [];
  knownVersion = data.version ?? null;
  renderItems();
  renderTagPane();
  renderViewPane();
}

btnNewList.addEventListener("click", () => {
  const li = document.createElement("li");
  li.className = "new-list-entry";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "list-rename-input";
  inp.placeholder = "New list name\u2026";
  li.appendChild(inp);
  listIndex.insertBefore(li, listIndex.firstChild);
  inp.focus();
  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const name = inp.value.trim();
    if (name) {
      api("/lists", { method: "POST", body: { name } }).then((data) => {
        loadLists();
        selectList(data.id);
      });
    } else {
      li.remove();
    }
  }
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { inp.value = ""; inp.blur(); }
    e.stopPropagation();
  });
});

listTitle.addEventListener("blur", async () => {
  if (!currentListId) return;
  const name = listTitle.textContent.trim();
  if (name) {
    await api(`/lists/${currentListId}`, { method: "PATCH", body: { name } });
    await loadLists();
  }
});

listTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); listTitle.blur(); }
});

// -------------------------------------------------------------------
// Import
// -------------------------------------------------------------------

const importModal = document.getElementById("import-modal");
const importText = document.getElementById("import-text");
const importNewBtn = document.getElementById("import-new-list");
const importCurrentBtn = document.getElementById("import-to-current");
const importCancelBtn = document.getElementById("import-cancel");
const btnImportList = document.getElementById("btn-import-list");

function parseImportText(text) {
  const lines = text.split(/\r?\n/);
  const items = [];

  // Track indent levels by their whitespace amounts
  // Instead of a fixed indent unit, map observed whitespace to depth levels
  const indentStack = [0]; // stack of whitespace amounts, index = depth

  for (const line of lines) {
    if (line.trim() === "") continue;

    const leadingWs = line.match(/^(\s*)/)[1].replace(/\t/g, "    ");
    const wsLen = leadingWs.length;

    // Determine depth from whitespace
    let depth;
    if (wsLen === 0) {
      depth = 0;
      indentStack.length = 1;
    } else if (wsLen > indentStack[indentStack.length - 1]) {
      // More indented than previous — new depth level
      depth = indentStack.length;
      indentStack.push(wsLen);
    } else {
      // Find the matching or nearest depth level
      depth = indentStack.length - 1;
      for (let d = indentStack.length - 1; d >= 0; d--) {
        if (indentStack[d] <= wsLen) {
          depth = d;
          break;
        }
      }
      indentStack.length = depth + 1;
    }

    let rest = line.trim();

    // Strip bullet prefixes first (-, *, •, numbered, etc.)
    rest = rest.replace(/^[-*\u2022\u25e6\u25aa\u25b8\u25b9\u25ba>]\s+/, "");
    rest = rest.replace(/^[a-zA-Z0-9]+[.)]\s+/, "");

    // Then detect checkboxes: [x], [X], [ ], [-]
    let done = false;
    const cbMatch = rest.match(/^\[([xX])\]\s*/);
    if (cbMatch) {
      done = true;
      rest = rest.slice(cbMatch[0].length);
    } else {
      const cbEmpty = rest.match(/^\[[\s\-]\]\s*/);
      if (cbEmpty) rest = rest.slice(cbEmpty[0].length);
    }

    // Strip markdown strikethrough ~~text~~
    rest = rest.replace(/~~(.*?)~~/g, "$1");

    // Strip trailing markdown artifacts (e.g. double-space line breaks)
    rest = rest.trimEnd();

    if (rest === "") continue;

    items.push({ text: rest, depth, done });
  }
  return items;
}

async function doImport(targetListId, parsedItems) {
  await api(`/lists/${targetListId}/items/bulk-add`, {
    method: "POST",
    body: { items: parsedItems },
  });
}

// -------------------------------------------------------------------
// Export
// -------------------------------------------------------------------

const btnExportList = document.getElementById("btn-export-list");

function exportListAsMarkdown() {
  if (!currentListId || currentItems.length === 0) return;
  const lines = [];
  for (const item of currentItems) {
    const indent = "  ".repeat(item.depth);
    const checkbox = item.done ? "[x]" : "[ ]";
    let line = `${indent}- ${checkbox} ${item.text}`;
    // Append tag values
    const tagParts = [];
    for (const t of item.tags) {
      const def = currentTags.find((d) => d.id === t.id);
      if (!def) continue;
      tagParts.push(t.value != null ? `${def.name}: ${t.value}` : def.name);
    }
    if (tagParts.length > 0) line += `  [${tagParts.join(", ")}]`;
    lines.push(line);
  }
  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${listTitle.textContent.trim() || "list"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

btnExportList.addEventListener("click", () => {
  if (!currentListId) {
    alert("Select a list first.");
    return;
  }
  exportListAsMarkdown();
});

// -------------------------------------------------------------------
// Import
// -------------------------------------------------------------------

function showImportModal() {
  importText.value = "";
  importText.disabled = false;
  importNewBtn.disabled = false;
  importNewBtn.textContent = "Import as new list";
  importCurrentBtn.disabled = !currentListId;
  importCurrentBtn.textContent = "Add to current list";
  importCancelBtn.disabled = false;
  importModal.classList.remove("hidden");
  importText.focus();
}

function hideImportModal() {
  importModal.classList.add("hidden");
}

btnImportList.addEventListener("click", showImportModal);
importCancelBtn.addEventListener("click", hideImportModal);
importModal.addEventListener("click", (e) => {
  if (e.target === importModal && !importText.disabled) hideImportModal();
});

function setImportBusy(busy, activeBtn) {
  importNewBtn.disabled = busy;
  importCurrentBtn.disabled = busy || !currentListId;
  importCancelBtn.disabled = busy;
  importText.disabled = busy;
  if (activeBtn) activeBtn.dataset.origText = activeBtn.textContent;
  if (busy && activeBtn) activeBtn.textContent = "Importing\u2026";
  if (!busy && activeBtn) activeBtn.textContent = activeBtn.dataset.origText;
}

importNewBtn.addEventListener("click", async () => {
  const parsed = parseImportText(importText.value);
  if (parsed.length === 0) return;
  const name = prompt("List name:", "Imported list");
  if (!name) return;
  setImportBusy(true, importNewBtn);
  const list = await api("/lists", { method: "POST", body: { name } });
  await doImport(list.id, parsed);
  setImportBusy(false, importNewBtn);
  hideImportModal();
  await loadLists();
  selectList(list.id);
});

importCurrentBtn.addEventListener("click", async () => {
  if (!currentListId) return;
  const parsed = parseImportText(importText.value);
  if (parsed.length === 0) return;
  setImportBusy(true, importCurrentBtn);
  await doImport(currentListId, parsed);
  setImportBusy(false, importCurrentBtn);
  hideImportModal();
  await refreshItems();
});

// -------------------------------------------------------------------
// Collapse helpers
// -------------------------------------------------------------------

function hasChildren(index) {
  if (index >= currentItems.length - 1) return false;
  return currentItems[index + 1].depth > currentItems[index].depth;
}

function getChildRange(index) {
  // Returns [start, end) of children indices for item at index.
  const parentDepth = currentItems[index].depth;
  let end = index + 1;
  while (end < currentItems.length && currentItems[end].depth > parentDepth) {
    end++;
  }
  return [index + 1, end];
}

// Precompute collapse visibility in a single forward pass — O(n)
function computeCollapseHidden() {
  const hidden = new Set();
  let hideBelow = Infinity; // depth threshold: items deeper than this are hidden
  for (let i = 0; i < currentItems.length; i++) {
    const d = currentItems[i].depth;
    if (d <= hideBelow) {
      // This item is at or above the hide threshold, so it's visible
      hideBelow = Infinity;
    }
    if (d > hideBelow) {
      hidden.add(i);
      continue;
    }
    if (collapsedIds.has(currentItems[i].id)) {
      hideBelow = d; // hide everything deeper than this
    }
  }
  return hidden;
}

function toggleCollapse(itemId) {
  if (collapsedIds.has(itemId)) {
    collapsedIds.delete(itemId);
  } else {
    collapsedIds.add(itemId);
  }
  renderItems();
}

function collapseAllAtDepth(depth) {
  // Collapse every item at the given depth that has children
  for (let i = 0; i < currentItems.length; i++) {
    if (currentItems[i].depth === depth && hasChildren(i)) {
      collapsedIds.add(currentItems[i].id);
    }
  }
  renderItems();
}

function expandAllAtDepth(depth) {
  expandAllAtDepthNoRender(depth);
  renderItems();
}

function expandAllAtDepthNoRender(depth) {
  for (let i = 0; i < currentItems.length; i++) {
    if (currentItems[i].depth === depth) {
      collapsedIds.delete(currentItems[i].id);
    }
  }
}

function expandAll() {
  collapsedIds.clear();
  renderItems();
}

// -------------------------------------------------------------------
// Selection
// -------------------------------------------------------------------

function handleSelectionClick(itemId, shiftKey, ctrlKey) {
  if (shiftKey && lastSelectedId) {
    // Range select: from lastSelectedId to itemId among visible items
    const visibleIds = getVisibleItemIds();
    const anchorIdx = visibleIds.indexOf(lastSelectedId);
    const targetIdx = visibleIds.indexOf(itemId);
    if (anchorIdx !== -1 && targetIdx !== -1) {
      const from = Math.min(anchorIdx, targetIdx);
      const to = Math.max(anchorIdx, targetIdx);
      selectedIds.clear();
      for (let i = from; i <= to; i++) {
        selectedIds.add(visibleIds[i]);
      }
    }
  } else if (ctrlKey) {
    // Toggle individual item in/out of selection
    if (selectedIds.has(itemId)) {
      selectedIds.delete(itemId);
    } else {
      selectedIds.add(itemId);
    }
    lastSelectedId = itemId;
  } else {
    selectedIds.clear();
    selectedIds.add(itemId);
    lastSelectedId = itemId;
  }
  if (hasActiveFilters()) {
    renderItems();
  } else {
    applySelectionStyles();
  }
}

function getVisibleItemIds() {
  const hidden = computeCollapseHidden();
  const ids = [];
  for (let i = 0; i < currentItems.length; i++) {
    if (!hidden.has(i)) ids.push(currentItems[i].id);
  }
  return ids;
}

function clearSelection() {
  selectedIds.clear();
  lastSelectedId = null;
  applySelectionStyles();
}

function applySelectionStyles() {
  itemsEl.querySelectorAll(".item").forEach((el) => {
    el.classList.toggle("selected", selectedIds.has(el.dataset.id));
  });
}

function rerenderVisible() {
  if (visibleList.length > 0) renderViewport();
}

// -------------------------------------------------------------------
// Items
// -------------------------------------------------------------------

function getItemHeight() { return mobileQuery.matches ? 36 : 26; }
let ITEM_HEIGHT = getItemHeight();
const RENDER_OVERSCAN = 10; // extra items above/below viewport
let visibleList = [];        // computed list of visible items [{item, dataIdx, isParent, isCollapsed, isFilterAncestor}]

function computeVisibleList() {
  const displayItems = getSortedItems();
  const filterVis = computeFilterVisibility();
  const collapseHidden = computeCollapseHidden();
  // Build O(1) lookup from item id to currentItems index
  const idToIdx = new Map();
  for (let i = 0; i < currentItems.length; i++) {
    idToIdx.set(currentItems[i].id, i);
  }
  const result = [];
  for (let i = 0; i < displayItems.length; i++) {
    const item = displayItems[i];
    const dataIdx = idToIdx.get(item.id);
    if (collapseHidden.has(dataIdx)) continue;
    if (filterVis.size > 0 && filterVis.get(dataIdx) === "hidden") continue;
    result.push({
      item,
      dataIdx,
      displayIdx: i,
      isParent: hasChildren(dataIdx),
      isCollapsed: collapsedIds.has(item.id),
      isFilterAncestor: filterVis.get(dataIdx) === "ancestor",
    });
  }
  return result;
}

function renderItems() {
  visibleList = computeVisibleList();
  const maxDepth = currentItems.reduce((m, it) => Math.max(m, it.depth), 0);
  updateCollapseBar(maxDepth);

  const totalHeight = visibleList.length * ITEM_HEIGHT;
  itemsEl.style.height = totalHeight + "px";
  itemsEl.style.position = "relative";

  renderViewport();
}

function scrollToItem(itemId) {
  if (!itemId) return;
  const row = visibleList.findIndex((v) => v.item.id === itemId);
  if (row === -1) return;
  const container = document.getElementById("items-container");
  const targetTop = row * ITEM_HEIGHT;
  const targetBottom = targetTop + ITEM_HEIGHT;
  if (targetTop < container.scrollTop || targetBottom > container.scrollTop + container.clientHeight) {
    // Center the item in the viewport
    container.scrollTop = targetTop - container.clientHeight / 2 + ITEM_HEIGHT / 2;
  }
}

function renderViewport() {
  const container = document.getElementById("items-container");
  const scrollTop = container.scrollTop;
  const viewHeight = container.clientHeight;

  const startRow = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - RENDER_OVERSCAN);
  const endRow = Math.min(visibleList.length, Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + RENDER_OVERSCAN);

  // Clear and re-render only the visible window
  itemsEl.innerHTML = "";
  foldGutter.innerHTML = "";

  for (let row = startRow; row < endRow; row++) {
    const { item, dataIdx, displayIdx, isParent, isCollapsed, isFilterAncestor } = visibleList[row];

    // Gutter toggle
    if (isParent) {
      const btn = document.createElement("button");
      btn.className = "gutter-toggle";
      btn.style.top = (row * ITEM_HEIGHT) + "px";
      btn.textContent = isCollapsed ? "\u25b6" : "\u25bc";
      btn.title = isCollapsed ? "Expand (Ctrl+.)" : "Collapse (Ctrl+.)";
      btn.addEventListener("click", () => toggleCollapse(item.id));
      foldGutter.appendChild(btn);
    }

    const li = document.createElement("li");
    li.className = "item" + (item.done ? " done" : "") + (isFilterAncestor ? " filter-ancestor" : "")
      + (selectedIds.has(item.id) ? " selected" : "");
    li.dataset.id = item.id;
    li.dataset.depth = item.depth;
    li.dataset.index = dataIdx;
    li.style.position = "absolute";
    li.style.top = (row * ITEM_HEIGHT) + "px";
    li.style.left = "0";
    li.style.right = "0";

    li.addEventListener("mousedown", (e) => {
      if (e.target.type === "checkbox") return;
      if (e.target.closest(".tag-bubble")) return;
      if (e.target.closest(".btn-icon")) return;
      if (e.shiftKey) e.preventDefault();
      onItemMouseDown(e, item.id, !!e.target.closest(".item-text"));
    });
    li.addEventListener("contextmenu", (e) => {
      showContextMenu(e, item.id, e.ctrlKey);
    });
    // Unified touch handler: long-press → context menu, drag threshold → drag
    setupItemTouch(li, item.id);

    // checkbox
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.addEventListener("click", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        toggleDoneHierarchy(displayIdx);
      } else if (selectedIds.size > 1 && selectedIds.has(item.id)) {
        e.preventDefault();
        toggleDoneSelected();
      } else {
        toggleDone(item);
      }
    });

    // Shared keydown logic for both mobile and desktop inputs
    function handleItemEnter(inp, shiftKey) {
      const copyTags = shiftKey ? item.tags.map(t => ({ id: t.id, value: null })) : null;
      if (inp.selectionStart === 0 && inp.value !== "") {
        addItemBefore(item.id, item.depth, copyTags);
      } else {
        const val = inp.value.trim();
        if (val !== item.text) {
          updateItem(item.id, { text: val });
        }
        addItemAfter(item.id, item.depth, copyTags);
      }
    }

    // text — input on desktop, span (tap-to-edit) on mobile
    let txt;
    let deleted = false;
    let skipBlur = false;

    if (mobileQuery.matches) {
      txt = document.createElement("span");
      txt.className = "item-text";
      txt.textContent = item.text;
      txt.addEventListener("click", (e) => {
        e.stopPropagation();
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "item-text";
        inp.value = item.text;
        let mobileDeleted = false;
        inp.addEventListener("blur", () => {
          if (mobileDeleted) return;
          const val = inp.value.trim();
          if (val !== item.text) {
            updateItem(item.id, { text: val });
          } else {
            renderItems();
          }
        });
        inp.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") {
            ke.preventDefault();
            handleItemEnter(inp, ke.shiftKey);
          }
          if (ke.key === "Backspace" && inp.value === "") {
            ke.preventDefault();
            mobileDeleted = true;
            deleteItem(item.id);
          }
        });
        txt.replaceWith(inp);
        inp.focus();
      });
    } else {
      txt = document.createElement("input");
      txt.type = "text";
      txt.value = item.text;
      txt.draggable = false;
      txt.className = "item-text";
      txt.addEventListener("blur", () => {
        if (deleted || skipBlur) return;
        const val = txt.value.trim();
        if (val !== item.text) {
          updateItem(item.id, { text: val });
        }
      });
      txt.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleItemEnter(txt, e.shiftKey);
          return;
        }
        if (e.key === "Backspace" && txt.value === "") {
          e.preventDefault();
          deleted = true;
          const allItems = Array.from(itemsEl.querySelectorAll(".item"));
          const idx = allItems.findIndex((el) => el.dataset.id === item.id);
          const prevId = idx > 0 ? allItems[idx - 1].dataset.id : null;
          deleteItem(item.id);
          if (prevId) {
            const el = itemsEl.querySelector(`.item[data-id="${prevId}"] .item-text`);
            if (el) el.focus();
          }
          return;
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const val = txt.value.trim();
          if (val !== item.text) {
            skipBlur = true;
            item.text = val;
            api(`/lists/${currentListId}/items/${item.id}`, {
              method: "PATCH",
              body: { text: val },
            }).then(() => scheduleSyncFromServer())
              .catch(() => refreshItems());
          }
          const visRow = visibleList.findIndex((v) => v.item.id === item.id);
          const targetRow = visRow + (e.key === "ArrowUp" ? -1 : 1);
          if (targetRow >= 0 && targetRow < visibleList.length) {
            const targetTop = targetRow * ITEM_HEIGHT;
            const container = document.getElementById("items-container");
            if (targetTop < container.scrollTop) container.scrollTop = targetTop;
            if (targetTop + ITEM_HEIGHT > container.scrollTop + container.clientHeight) {
              container.scrollTop = targetTop + ITEM_HEIGHT - container.clientHeight;
            }
            renderViewport();
            const targetId = visibleList[targetRow].item.id;
            const el = itemsEl.querySelector(`.item[data-id="${targetId}"] .item-text`);
            if (el) el.focus();
          }
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          if (selectedIds.size > 1 && selectedIds.has(item.id)) {
            changeDepthSelected(e.shiftKey ? -1 : 1, item.id);
          } else {
            const newDepth = item.depth + (e.shiftKey ? -1 : 1);
            updateItem(item.id, { depth: Math.max(0, newDepth) }, { refocusId: item.id });
          }
        }
      });
    }

    // tag bubbles
    const tagsContainer = document.createElement("span");
    tagsContainer.className = "item-tags";
    for (const tagDef of currentTags) {
      if (!itemHasTag(item, tagDef.id)) continue;
      if (hiddenTagIds.has(tagDef.id)) continue;
      const tagId = tagDef.id;
      const tagVal = itemTagValue(item, tagId);
      const bubble = document.createElement("span");
      bubble.className = "tag-bubble";
      const friendly = friendlyDate(tagVal);
      const displayVal = friendly ?? tagVal;
      if (mobileQuery.matches) {
        bubble.textContent = tagDef.name.charAt(0).toUpperCase();
        bubble.title = tagVal != null ? `${tagDef.name}: ${tagVal}` : tagDef.name;
      } else {
        bubble.textContent = displayVal != null ? `${tagDef.name}: ${displayVal}` : tagDef.name;
        if (friendly) bubble.dataset.rawDate = tagVal;
      }
      bubble.style.background = tagDef.color;
      let clickTimer = null;
      let editing = false;
      bubble.addEventListener("click", (e) => {
        e.stopPropagation();
        if (editing) return;
        if (e.ctrlKey) {
          removeTagFromHierarchy(displayIdx, tagId);
          return;
        }
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (!editing) removeTagFromItemById(item.id, tagId);
        }, 250);
      });
      bubble.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        editing = true;
        const current = itemTagValue(item, tagId);
        bubble.textContent = tagDef.name + ": ";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "tag-value-input";
        inp.value = current ?? "";
        inp.size = Math.max(3, (current ?? "").length + 1);
        bubble.appendChild(inp);
        inp.focus();
        inp.select();
        inp.addEventListener("input", () => {
          inp.size = Math.max(3, inp.value.length + 1);
        });
        let pickerActive = false;
        function commit() {
          if (pickerActive) return;
          editing = false;
          const newVal = inp.value.trim() === "" ? null : inp.value.trim();
          setTagValue(item, tagId, newVal);
          renderItems();
          updateItem(item.id, { tags: [...item.tags] });
        }
        inp.addEventListener("blur", commit);
        inp.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { ke.preventDefault(); inp.blur(); }
          if (ke.key === "Escape") { inp.value = current ?? ""; inp.blur(); }
          if (ke.ctrlKey && ke.key === "d") {
            ke.preventDefault();
            const picker = document.createElement("input");
            picker.type = "date";
            picker.className = "tag-date-picker";
            const bubbleRect = bubble.getBoundingClientRect();
            picker.style.position = "fixed";
            picker.style.left = bubbleRect.left + "px";
            picker.style.top = (bubbleRect.bottom + 2) + "px";
            picker.style.zIndex = "2000";
            if (current) {
              try { picker.value = new Date(current).toISOString().slice(0, 10); } catch (e) {}
            }
            document.body.appendChild(picker);
            pickerActive = true;
            picker.focus();
            try { picker.showPicker(); } catch (e) {}
            let closed = false;
            function closePicker(andCommit) {
              if (closed) return;
              closed = true;
              pickerActive = false;
              if (picker.value) {
                inp.value = picker.value;  // stores as YYYY-MM-DD
                inp.size = Math.max(3, inp.value.length + 1);
              }
              if (document.body.contains(picker)) picker.remove();
              if (andCommit) {
                commit();
              } else {
                inp.focus();
              }
            }
            picker.addEventListener("change", () => closePicker(true));
            picker.addEventListener("keydown", (pke) => {
              if (pke.key === "Enter") { pke.preventDefault(); closePicker(true); }
              if (pke.key === "Escape") { closed = true; pickerActive = false; picker.remove(); inp.focus(); }
              pke.stopPropagation();
            });
            picker.addEventListener("blur", () => setTimeout(() => closePicker(false), 150));
          }
          ke.stopPropagation();
        });
      });
      tagsContainer.appendChild(bubble);
    }

    // child count badge
    const badge = document.createElement("span");
    badge.className = "child-count";
    if (isParent && isCollapsed) {
      const [start, end] = getChildRange(dataIdx);
      badge.textContent = `(${end - start})`;
    }

    // delete button
    const btnDel = document.createElement("button");
    btnDel.className = "btn-icon";
    btnDel.textContent = "\u00d7";
    btnDel.title = "Delete";
    btnDel.addEventListener("click", (e) => {
      if (e.ctrlKey) {
        const dataIdx = currentItems.indexOf(item);
        const [start, end] = getChildRange(dataIdx);
        const ids = new Set([item.id, ...currentItems.slice(start, end).map(it => it.id)]);
        currentItems = currentItems.filter(it => !ids.has(it.id));
        renderItems();
        api(`/lists/${currentListId}/items/bulk-delete`, {
          method: "POST",
          body: { item_ids: [...ids] },
        }).then(() => scheduleSyncFromServer()).catch(() => refreshItems());
      } else {
        deleteItem(item.id);
      }
    });

    const leftGroup = document.createElement("div");
    leftGroup.className = "item-left";
    if (item.depth > 0) leftGroup.style.paddingLeft = (item.depth * 1.5) + "rem";
    leftGroup.append(cb, txt);
    li.append(leftGroup, btnDel, tagsContainer, badge);
    itemsEl.appendChild(li);
  }
}

// Wire up scroll-based viewport rendering
document.getElementById("items-container").addEventListener("scroll", () => {
  if (visibleList.length > 0) renderViewport();
});

// Tooltip for truncated item text and date tag values (desktop only)
if (!_isMobile) {
  const tooltip = document.getElementById("item-tooltip");
  const itemsContainer = document.getElementById("items-container");

  itemsContainer.addEventListener("mouseover", (e) => {
    // Date tag bubble tooltip
    const bubble = e.target.closest(".tag-bubble");
    if (bubble && bubble.dataset.rawDate) {
      tooltip.textContent = bubble.dataset.rawDate;
      tooltip.classList.remove("hidden");
      const rect = bubble.getBoundingClientRect();
      tooltip.style.left = rect.left + "px";
      tooltip.style.top = (rect.bottom + 2) + "px";
      return;
    }
    // Truncated item text tooltip
    const txt = e.target.closest(".item-text");
    if (!txt || txt.scrollWidth <= txt.clientWidth) {
      tooltip.classList.add("hidden");
      return;
    }
    tooltip.textContent = txt.value ?? txt.textContent;
    tooltip.classList.remove("hidden");
    const rect = txt.getBoundingClientRect();
    tooltip.style.left = rect.left + "px";
    tooltip.style.top = (rect.bottom + 2) + "px";
  });

  itemsContainer.addEventListener("mouseout", (e) => {
    if (e.target.closest(".item-text") || e.target.closest(".tag-bubble")) {
      tooltip.classList.add("hidden");
    }
  });
}

function updateCollapseBar(maxDepth) {
  collapseBar.innerHTML = "";
  if (maxDepth === 0) {
    collapseBar.classList.add("hidden");
    return;
  }
  collapseBar.classList.remove("hidden");

  const label = document.createElement("span");
  label.className = "collapse-label";
  label.textContent = "Depth:";
  collapseBar.appendChild(label);

  for (let d = 0; d <= maxDepth; d++) {
    const btn = document.createElement("button");
    btn.className = "collapse-depth-btn";
    btn.textContent = d;
    btn.title = `Toggle collapse at depth ${d} (Ctrl+${d})`;
    btn.addEventListener("click", () => {
      // Check if all parents at this depth are already collapsed
      let allCollapsed = true;
      for (let i = 0; i < currentItems.length; i++) {
        if (currentItems[i].depth === d && hasChildren(i) && !collapsedIds.has(currentItems[i].id)) {
          allCollapsed = false;
          break;
        }
      }
      if (allCollapsed) {
        // Already collapsed at this depth — expand everything
        expandAll();
      } else {
        // Expand above, collapse at depth d
        for (let above = 0; above < d; above++) {
          expandAllAtDepthNoRender(above);
        }
        collapseAllAtDepth(d);
      }
    });
    collapseBar.appendChild(btn);
  }

  const btnAll = document.createElement("button");
  btnAll.className = "collapse-depth-btn";
  btnAll.textContent = "All";
  btnAll.title = "Expand all (Ctrl+E)";
  btnAll.addEventListener("click", expandAll);
  collapseBar.appendChild(btnAll);
}

// -------------------------------------------------------------------
// Data mutations (optimistic update + background server sync)
// -------------------------------------------------------------------

async function addItemAfter(afterId, depth, tags) {
  const body = { text: "", depth };
  if (afterId) body.after_id = afterId;
  if (tags) body.tags = tags;
  const result = await api(`/lists/${currentListId}/items`, {
    method: "POST",
    body,
  });
  if (result && result.id) {
    selectedIds.clear();
    selectedIds.add(result.id);
    lastSelectedId = result.id;
  }
  await refreshItems();
  if (result && result.id) {
    const newEl = itemsEl.querySelector(`.item[data-id="${result.id}"] .item-text`);
    if (newEl) {
      if (newEl.tagName === "INPUT") { newEl.value = ""; newEl.focus(); }
      else { newEl.click(); } // mobile: tap span to open input
    }
  }
}

async function addItemBefore(beforeId, depth, tags) {
  const body = { text: "", depth, before_id: beforeId };
  if (tags) body.tags = tags;
  const result = await api(`/lists/${currentListId}/items`, {
    method: "POST",
    body,
  });
  if (result && result.id) {
    selectedIds.clear();
    selectedIds.add(result.id);
    lastSelectedId = result.id;
  }
  await refreshItems();
  if (result && result.id) {
    const newEl = itemsEl.querySelector(`.item[data-id="${result.id}"] .item-text`);
    if (newEl) {
      if (newEl.tagName === "INPUT") { newEl.value = ""; newEl.focus(); }
      else { newEl.click(); }
    }
  }
}

function toggleDoneSelected() {
  const block = currentItems.filter((it) => selectedIds.has(it.id));
  const allDone = block.every((it) => it.done);
  const newDone = !allDone;
  for (const it of block) {
    it.done = newDone;
    it.completed = newDone ? new Date().toISOString() : null;
  }
  renderItems();
  api(`/lists/${currentListId}/items`, {
    method: "PATCH",
    body: { updates: block.map((it) => ({ id: it.id, done: newDone })) },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function changeDepthSelected(delta, refocusId) {
  const updates = [];
  for (const it of currentItems) {
    if (!selectedIds.has(it.id)) continue;
    const newDepth = Math.max(0, it.depth + delta);
    if (newDepth !== it.depth) {
      it.depth = newDepth;
      updates.push({ id: it.id, depth: newDepth });
    }
  }
  if (updates.length === 0) return;
  renderItems();
  if (refocusId) {
    const el = itemsEl.querySelector(`.item[data-id="${refocusId}"] .item-text`);
    if (el) el.focus();
  }
  api(`/lists/${currentListId}/items`, {
    method: "PATCH",
    body: { updates },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function toggleDone(item) {
  updateItem(item.id, { done: !item.done });
}

function toggleDoneHierarchy(index) {
  const [start, end] = getChildRange(index);
  const block = [currentItems[index], ...currentItems.slice(start, end)];
  const newDone = !currentItems[index].done;
  // Update all locally, re-render once
  for (const it of block) {
    it.done = newDone;
    it.completed = newDone ? new Date().toISOString() : null;
  }
  renderItems();
  // Single bulk request to server
  api(`/lists/${currentListId}/items`, {
    method: "PATCH",
    body: { updates: block.map((it) => ({ id: it.id, done: newDone })) },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

// Schedule a full server refresh after edits go idle
let syncTimer = null;

let knownVersion = null;  // version counter from server

async function syncFromServer() {
  if (!currentListId) return;
  // Lightweight version check first
  const ver = await api(`/lists/${currentListId}/version`);
  if (ver && !ver.error && ver.version === knownVersion) return;  // no changes
  // Version changed or endpoint unavailable — fetch full list
  const data = await api(`/lists/${currentListId}`);
  if (data && !data.error) {
    knownVersion = data.version ?? null;
    currentItems = data.items;
    currentTags = data.tags || [];
    const focused = document.activeElement;
    const focusedId = focused?.closest?.(".item")?.dataset?.id;
    renderItems();
    renderTagPane();
    if (focusedId) {
      const el = itemsEl.querySelector(`.item[data-id="${focusedId}"] .item-text`);
      if (el) el.focus();
    }
    // Remote change — keep polling alive and fast
    lastActivity = Date.now();
    resetPollInterval();
  }
}

function scheduleSyncFromServer() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncFromServer, 1000);
}

function updateItem(itemId, fields, {refocusId} = {}) {
  // Optimistic: update local data and re-render immediately
  const item = currentItems.find((it) => it.id === itemId);
  if (item) {
    if ("text" in fields) item.text = fields.text;
    if ("depth" in fields) item.depth = fields.depth;
    if ("done" in fields) {
      const wasDone = item.done;
      item.done = fields.done;
      if (item.done && !wasDone) item.completed = new Date().toISOString();
      else if (!item.done && wasDone) item.completed = null;
    }
    if ("tags" in fields) item.tags = fields.tags;
    renderItems();
    if (refocusId) {
      const el = itemsEl.querySelector(`.item[data-id="${refocusId}"] .item-text`);
      if (el) el.focus();
    }
  }
  // Background: send to server, reconcile later
  api(`/lists/${currentListId}/items/${itemId}`, {
    method: "PATCH",
    body: fields,
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function deleteItem(itemId) {
  // Optimistic: remove locally and re-render
  currentItems = currentItems.filter((it) => it.id !== itemId);
  renderItems();
  // Background: send to server
  api(`/lists/${currentListId}/items/${itemId}`, { method: "DELETE" })
    .then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}


// -------------------------------------------------------------------
// Search / Filtering
// -------------------------------------------------------------------

function hasActiveFilters() {
  return textFilters.length > 0 || tagFilters.length > 0 || completionFilter !== "all";
}

function smartCompare(a, b) {
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function matchesCondition(itemValue, condition) {
  if (!condition) return true; // no condition = presence only
  const m = condition.match(/^(>=|<=|!=|>|<|=)(.*)$/);
  if (m) {
    const [, op, val] = m;
    if (itemValue == null) return false;
    const cmp = smartCompare(itemValue, val);
    if (op === "=") return cmp === 0;
    if (op === "!=") return cmp !== 0;
    if (op === ">") return cmp > 0;
    if (op === "<") return cmp < 0;
    if (op === ">=") return cmp >= 0;
    if (op === "<=") return cmp <= 0;
  }
  // No operator prefix: substring/contains match
  if (itemValue == null) return false;
  return String(itemValue).toLowerCase().includes(condition.toLowerCase());
}

function itemMatchesFilters(item) {
  if (selectedIds.has(item.id)) return true;
  if (completionFilter === "active" && item.done) return false;
  if (completionFilter === "done" && !item.done) return false;
  for (const f of textFilters) {
    if (!f.regex.test(item.text)) return false;
  }
  for (const { tagId, condition, exclude } of tagFilters) {
    if (exclude) {
      // Exclude mode: hide items that HAVE this tag (with optional condition)
      if (condition) {
        if (itemHasTag(item, tagId) && matchesCondition(itemTagValue(item, tagId), condition)) return false;
      } else {
        if (itemHasTag(item, tagId)) return false;
      }
    } else {
      if (!itemHasTag(item, tagId)) return false;
      if (condition && !matchesCondition(itemTagValue(item, tagId), condition)) return false;
    }
  }
  return true;
}

function computeFilterVisibility() {
  // Returns a Map of index -> "match" | "ancestor" | "hidden"
  const vis = new Map();
  if (!hasActiveFilters()) return vis;

  // First pass: mark matches
  for (let i = 0; i < currentItems.length; i++) {
    vis.set(i, itemMatchesFilters(currentItems[i]) ? "match" : "hidden");
  }
  // Second pass: mark ancestors of matches as visible
  for (let i = 0; i < currentItems.length; i++) {
    if (vis.get(i) !== "match") continue;
    // Walk backwards to find ancestors
    let targetDepth = currentItems[i].depth;
    for (let j = i - 1; j >= 0 && targetDepth > 0; j--) {
      if (currentItems[j].depth < targetDepth) {
        if (vis.get(j) === "hidden") vis.set(j, "ancestor");
        targetDepth = currentItems[j].depth;
      }
    }
  }
  return vis;
}

function getSortedItems() {
  if (!currentSort) return currentItems;
  const { tagId, direction } = currentSort;

  // Group items into blocks: each item at a given depth with all deeper items following it
  const blocks = [];
  let i = 0;
  while (i < currentItems.length) {
    const blockDepth = currentItems[i].depth;
    const block = [currentItems[i]];
    i++;
    while (i < currentItems.length && currentItems[i].depth > blockDepth) {
      block.push(currentItems[i]);
      i++;
    }
    blocks.push(block);
  }

  // Sort blocks by the lead item's tag value
  blocks.sort((a, b) => {
    const aVal = itemTagValue(a[0], tagId);
    const bVal = itemTagValue(b[0], tagId);
    // Items without the tag sort to end
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    const cmp = smartCompare(aVal, bVal);
    return direction === "desc" ? -cmp : cmp;
  });

  return blocks.flat();
}

function toggleSort(tagId) {
  if (!currentSort || currentSort.tagId !== tagId) {
    currentSort = { tagId, direction: "asc" };
  } else if (currentSort.direction === "asc") {
    currentSort = { tagId, direction: "desc" };
  } else {
    currentSort = null;
  }
  renderItems();
  renderTagPane();
  scrollToItem(lastSelectedId);
}

function renderFilterBar() {
  filterBar.innerHTML = "";
  if (!hasActiveFilters()) {
    filterBar.classList.add("hidden");
    return;
  }
  filterBar.classList.remove("hidden");

  for (let i = 0; i < textFilters.length; i++) {
    const f = textFilters[i];
    const bubble = document.createElement("span");
    bubble.className = "filter-bubble filter-bubble-text";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = f.pattern;
    const xSpan = document.createElement("span");
    xSpan.className = "filter-x";
    xSpan.textContent = "\u00d7";
    bubble.append(labelSpan, xSpan);
    bubble.title = "Click to remove filter";
    bubble.addEventListener("click", () => {
      textFilters.splice(i, 1);
      renderFilterBar();
      renderItems();
      scrollToItem(lastSelectedId);
    });
    filterBar.appendChild(bubble);
  }

  for (let fi = 0; fi < tagFilters.length; fi++) {
    const { tagId, condition, exclude } = tagFilters[fi];
    const tagDef = currentTags.find((t) => t.id === tagId);
    if (!tagDef) continue;
    const bubble = document.createElement("span");
    bubble.className = "filter-bubble filter-bubble-tag";
    if (exclude) {
      bubble.style.background = "transparent";
      bubble.style.border = `2px solid ${tagDef.color}`;
      bubble.style.color = tagDef.color;
    } else {
      bubble.style.background = tagDef.color;
    }
    const label = condition ? `${tagDef.name} ${condition}` : tagDef.name;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    const xSpan = document.createElement("span");
    xSpan.className = "filter-x";
    xSpan.textContent = "\u00d7";
    bubble.append(labelSpan, xSpan);
    bubble.title = "Click: toggle include/exclude / Double-click: set condition";
    let clickTimer = null;
    const filterIdx = fi;
    xSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      tagFilters.splice(filterIdx, 1);
      renderFilterBar();
      renderItems();
      renderTagPane();
      scrollToItem(lastSelectedId);
    });
    bubble.addEventListener("click", () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        tagFilters[filterIdx] = { tagId, condition, exclude: !exclude };
        renderFilterBar();
        renderItems();
        scrollToItem(lastSelectedId);
      }, 250);
    });
    bubble.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      bubble.textContent = tagDef.name + " ";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "tag-value-input";
      inp.value = condition || "";
      inp.size = Math.max(3, inp.value.length + 1);
      inp.placeholder = "e.g. >5, =Alice";
      bubble.appendChild(inp);
      inp.focus();
      inp.select();
      inp.addEventListener("input", () => {
        inp.size = Math.max(3, inp.value.length + 1);
      });
      function commitFilter() {
        const val = inp.value.trim() || null;
        tagFilters[filterIdx] = { tagId, condition: val };
        renderFilterBar();
        renderItems();
        scrollToItem(lastSelectedId);
      }
      inp.addEventListener("blur", commitFilter);
      inp.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") { ke.preventDefault(); inp.blur(); }
        if (ke.key === "Escape") { inp.value = condition || ""; inp.blur(); }
        ke.stopPropagation();
      });
    });
    filterBar.appendChild(bubble);
  }
}

searchInput.addEventListener("input", () => {
  const val = searchInput.value.trim();
  if (!val) {
    selectedIds.clear();
    applySelectionStyles();
    return;
  }
  try {
    const re = new RegExp(val, "i");
    selectedIds.clear();
    for (const item of currentItems) {
      if (re.test(item.text)) selectedIds.add(item.id);
    }
    applySelectionStyles();
  } catch (e) {
    // Invalid regex in progress, ignore
  }
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const val = searchInput.value.trim();
    if (!val) return;
    try {
      const re = new RegExp(val, "i");
      textFilters.push({ pattern: val, regex: re });
      searchInput.value = "";
      selectedIds.clear();
      renderFilterBar();
      renderItems();
      scrollToItem(lastSelectedId);
    } catch (err) {
      // Invalid regex, don't create filter
    }
    return;
  }
  if (e.key === "Escape") {
    searchInput.value = "";
    selectedIds.clear();
    applySelectionStyles();
    searchInput.blur();
  }
});

document.querySelectorAll(".comp-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    completionFilter = btn.dataset.mode;
    document.querySelectorAll(".comp-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === completionFilter)
    );
    renderItems();
    scrollToItem(lastSelectedId);
  });
});

function toggleTagFilter(tagId) {
  tagFilters.push({ tagId, condition: null, exclude: false });
  renderFilterBar();
  renderItems();
  renderTagPane();
  scrollToItem(lastSelectedId);
}

// -------------------------------------------------------------------
// Tags
// -------------------------------------------------------------------

function renderTagPane() {
  tagListEl.innerHTML = "";
  for (const tag of currentTags) {
    const li = document.createElement("li");
    li.className = "tag-entry" + (hiddenTagIds.has(tag.id) ? " tag-hidden" : "");

    // Color dot (click to change color)
    const dot = document.createElement("span");
    dot.className = "tag-color-dot";
    dot.style.background = tag.color;
    dot.title = "Change color";
    dot.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "color";
      input.value = tag.color;
      input.style.position = "absolute";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.addEventListener("input", () => {
        updateTag(tag.id, { color: input.value });
      });
      input.addEventListener("change", () => input.remove());
      input.click();
    });

    // Tag name (double-click to rename)
    const name = document.createElement("span");
    name.className = "tag-name";
    name.textContent = tag.name;
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "list-rename-input";
      inp.value = tag.name;
      name.replaceWith(inp);
      inp.focus();
      inp.select();
      function commit() {
        const val = inp.value.trim();
        if (val && val !== tag.name) {
          updateTag(tag.id, { name: val });
        } else {
          renderTagPane();
        }
      }
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") { ke.preventDefault(); inp.blur(); }
        if (ke.key === "Escape") { inp.value = tag.name; inp.blur(); }
        ke.stopPropagation();
      });
      inp.addEventListener("click", (ce) => ce.stopPropagation());
      inp.addEventListener("mousedown", (me) => me.stopPropagation());
    });

    // Visibility toggle
    const visBtn = document.createElement("button");
    visBtn.className = "tag-visibility-btn";
    visBtn.textContent = hiddenTagIds.has(tag.id) ? "\u25cb" : "\u25cf";
    visBtn.title = hiddenTagIds.has(tag.id) ? "Show" : "Hide";
    visBtn.addEventListener("click", () => {
      if (hiddenTagIds.has(tag.id)) hiddenTagIds.delete(tag.id);
      else hiddenTagIds.add(tag.id);
      renderTagPane();
      renderItems();
    });

    // Sort toggle
    const sortBtn = document.createElement("button");
    const isSorted = currentSort && currentSort.tagId === tag.id;
    const sortDir = isSorted ? currentSort.direction : null;
    sortBtn.className = "tag-sort-btn" + (isSorted ? " active" : "");
    sortBtn.textContent = sortDir === "asc" ? "\u25b2" : sortDir === "desc" ? "\u25bc" : "\u2195";
    sortBtn.title = isSorted ? `Sorted ${sortDir} (click to cycle)` : "Sort by this tag";
    sortBtn.addEventListener("click", () => toggleSort(tag.id));

    // Filter toggle
    const filterBtn = document.createElement("button");
    const hasFilter = tagFilters.some((f) => f.tagId === tag.id);
    filterBtn.className = "tag-filter-btn" + (hasFilter ? " active" : "");
    filterBtn.textContent = "\u25e2";
    filterBtn.title = hasFilter ? "Click: add another / remove via bubble" : "Filter by this tag";
    filterBtn.addEventListener("click", () => toggleTagFilter(tag.id));

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "tag-delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Delete tag";
    delBtn.addEventListener("click", () => deleteTag(tag.id));

    li.append(dot, name, sortBtn, filterBtn, visBtn, delBtn);

    // Drag to reorder / click to toggle tag on items
    li.addEventListener("mousedown", (e) => {
      if (e.target === dot || e.target === visBtn || e.target === delBtn || e.target === filterBtn || e.target === sortBtn) return;
      onTagMouseDown(e, tag.id);
    });

    tagListEl.appendChild(li);
  }
}

let tagDragState = null;

function onTagMouseDown(e, tagId) {
  const startY = e.clientY;
  let started = false;

  function onMove(me) {
    const dy = Math.abs(me.clientY - startY);
    if (!started && dy >= DRAG_THRESHOLD) {
      started = true;
      document.body.style.userSelect = "none";
      const srcIdx = currentTags.findIndex(t => t.id === tagId);
      const sourceEl = tagListEl.children[srcIdx];
      const rect = sourceEl.getBoundingClientRect();

      // Create ghost
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.style.width = rect.width + "px";
      const ghostDot = document.createElement("span");
      ghostDot.className = "tag-color-dot";
      ghostDot.style.background = currentTags[srcIdx].color;
      ghost.append(ghostDot, currentTags[srcIdx].name);
      ghost.style.left = rect.left + "px";
      ghost.style.top = rect.top + "px";
      document.body.appendChild(ghost);

      sourceEl.classList.add("tag-drag-source");
      tagDragState = { tagId, ghost, offsetY: startY - rect.top };
    }
    if (started) onTagDragMove(me);
  }

  function onUp(ue) {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    if (started) {
      onTagDragEnd();
    } else if (ue.ctrlKey) {
      toggleTagOnItemsWithHierarchy(tagId);
    } else {
      toggleTagOnItems(tagId);
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onTagDragMove(e) {
  if (!tagDragState) return;
  const { ghost, offsetY } = tagDragState;
  const listRect = tagListEl.getBoundingClientRect();
  ghost.style.left = listRect.left + "px";
  ghost.style.top = (e.clientY - offsetY) + "px";

  const tagEntries = Array.from(tagListEl.querySelectorAll(".tag-entry"));
  const relY = e.clientY - listRect.top;
  const entryHeight = tagEntries.length > 0 ? tagEntries[0].offsetHeight : 26;
  let targetRow = Math.round(relY / entryHeight);
  targetRow = Math.max(0, Math.min(targetRow, currentTags.length));

  const srcIdx = currentTags.findIndex((t) => t.id === tagDragState.tagId);
  if (srcIdx === -1 || targetRow === srcIdx) return;

  const [moved] = currentTags.splice(srcIdx, 1);
  const insertIdx = targetRow > srcIdx ? targetRow - 1 : targetRow;
  currentTags.splice(insertIdx, 0, moved);

  renderTagPane();
  renderItems();

  // Re-mark source
  const newSrc = tagListEl.querySelector(`.tag-entry:nth-child(${currentTags.findIndex(t => t.id === tagDragState.tagId) + 1})`);
  if (newSrc) newSrc.classList.add("tag-drag-source");
}

function onTagDragEnd() {
  if (!tagDragState) return;
  tagDragState.ghost.remove();
  const tagId = tagDragState.tagId;
  tagDragState = null;

  renderTagPane();
  renderItems();

  // Send new order to server
  api(`/lists/${currentListId}/tags/reorder`, {
    method: "POST",
    body: { order: currentTags.map((t) => t.id) },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function getTargetItems() {
  if (selectedIds.size > 0) return [...selectedIds];
  const focused = document.activeElement?.closest?.(".item");
  return focused ? [focused.dataset.id] : [];
}

function toggleTagOnItems(tagId) {
  const targetIds = getTargetItems();
  if (targetIds.length === 0) return;

  const targets = currentItems.filter((it) => targetIds.includes(it.id));
  const allHave = targets.every((it) => itemHasTag(it, tagId));
  const updates = [];
  for (const it of targets) {
    if (allHave) {
      removeTagFromItemData(it, tagId);
    } else {
      addTagToItem(it, tagId);
    }
    updates.push({ id: it.id, tags: [...it.tags] });
  }
  renderItems();
  api(`/lists/${currentListId}/items`, {
    method: "PATCH",
    body: { updates },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function removeTagFromItemById(itemId, tagId) {
  const item = currentItems.find((it) => it.id === itemId);
  if (!item) return;
  removeTagFromItemData(item, tagId);
  renderItems();
  api(`/lists/${currentListId}/items/${itemId}`, {
    method: "PATCH",
    body: { tags: item.tags },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function removeTagFromHierarchy(index, tagId) {
  const [start, end] = getChildRange(index);
  const block = [currentItems[index], ...currentItems.slice(start, end)];
  const updates = [];
  for (const it of block) {
    removeTagFromItemData(it, tagId);
    updates.push({ id: it.id, tags: [...it.tags] });
  }
  renderItems();
  api(`/lists/${currentListId}/items`, {
    method: "PATCH",
    body: { updates },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function getHierarchyItems(targetIds) {
  const allIds = new Set();
  for (const id of targetIds) {
    const idx = currentItems.findIndex((it) => it.id === id);
    if (idx === -1) continue;
    allIds.add(id);
    const [start, end] = getChildRange(idx);
    for (let j = start; j < end; j++) allIds.add(currentItems[j].id);
  }
  return currentItems.filter((it) => allIds.has(it.id));
}

function toggleTagOnItemsWithHierarchy(tagId) {
  const targetIds = getTargetItems();
  if (targetIds.length === 0) return;

  const targets = getHierarchyItems(targetIds);
  const allHave = targets.every((it) => itemHasTag(it, tagId));
  const updates = [];
  for (const it of targets) {
    if (allHave) {
      removeTagFromItemData(it, tagId);
    } else {
      addTagToItem(it, tagId);
    }
    updates.push({ id: it.id, tags: [...it.tags] });
  }
  renderItems();
  api(`/lists/${currentListId}/items`, {
    method: "PATCH",
    body: { updates },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function updateTag(tagId, fields) {
  const tag = currentTags.find((t) => t.id === tagId);
  if (tag) {
    if ("name" in fields) tag.name = fields.name;
    if ("color" in fields) tag.color = fields.color;
    renderTagPane();
    renderItems();
  }
  api(`/lists/${currentListId}/tags/${tagId}`, {
    method: "PATCH",
    body: fields,
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

function deleteTag(tagId) {
  currentTags = currentTags.filter((t) => t.id !== tagId);
  for (const item of currentItems) {
    removeTagFromItemData(item, tagId);
  }
  hiddenTagIds.delete(tagId);
  renderTagPane();
  renderItems();
  api(`/lists/${currentListId}/tags/${tagId}`, { method: "DELETE" })
    .then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

btnNewTag.addEventListener("click", () => {
  const li = document.createElement("li");
  li.className = "tag-entry";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "list-rename-input";
  inp.placeholder = "Tag name\u2026";
  li.appendChild(inp);
  tagListEl.insertBefore(li, tagListEl.firstChild);
  inp.focus();
  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const name = inp.value.trim();
    if (name) {
      api(`/lists/${currentListId}/tags`, {
        method: "POST",
        body: { name },
      }).then((tag) => {
        if (tag && !tag.error) {
          currentTags.push(tag);
          renderTagPane();
          renderItems();
        }
      });
    } else {
      li.remove();
    }
  }
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { inp.value = ""; inp.blur(); }
    e.stopPropagation();
  });
});

// -------------------------------------------------------------------
// Views
// -------------------------------------------------------------------

const viewListEl = document.getElementById("view-list");
const btnSaveView = document.getElementById("btn-save-view");

function captureViewState() {
  return {
    textFilters: textFilters.map((f) => f.pattern),
    tagFilters: tagFilters.map((f) => ({ tagId: f.tagId, condition: f.condition, exclude: f.exclude || false })),
    completionFilter,
    sort: currentSort ? { tagId: currentSort.tagId, direction: currentSort.direction } : null,
    hiddenTagIds: [...hiddenTagIds],
  };
}

function applyViewState(view) {
  // Validate tag references still exist
  const validTagIds = new Set(currentTags.map((t) => t.id));

  textFilters.length = 0;
  for (const pattern of (view.textFilters || [])) {
    try {
      textFilters.push({ pattern, regex: new RegExp(pattern, "i") });
    } catch (e) {}
  }

  tagFilters.length = 0;
  for (const f of (view.tagFilters || [])) {
    if (validTagIds.has(f.tagId)) {
      tagFilters.push({ tagId: f.tagId, condition: f.condition, exclude: f.exclude || false });
    }
  }

  completionFilter = view.completionFilter || "all";
  document.querySelectorAll(".comp-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === completionFilter)
  );

  if (view.sort && validTagIds.has(view.sort.tagId)) {
    currentSort = { tagId: view.sort.tagId, direction: view.sort.direction };
  } else {
    currentSort = null;
  }

  hiddenTagIds.clear();
  for (const id of (view.hiddenTagIds || [])) {
    if (validTagIds.has(id)) hiddenTagIds.add(id);
  }

  renderFilterBar();
  renderItems();
  renderTagPane();
  scrollToItem(lastSelectedId);
}

function saveViewsToServer() {
  api(`/lists/${currentListId}`, {
    method: "PATCH",
    body: { views: currentViews },
  });
}

function saveActiveViewToServer() {
  api(`/lists/${currentListId}`, {
    method: "PATCH",
    body: { active_view: activeViewId },
  });
}

function renderViewPane() {
  viewListEl.innerHTML = "";
  for (const view of currentViews) {
    const li = document.createElement("li");
    li.className = "view-entry" + (activeViewId === view.id ? " active-view" : "");

    const name = document.createElement("span");
    name.className = "view-name";
    name.textContent = view.name;

    // Overwrite view with current state
    const saveBtn = document.createElement("button");
    saveBtn.className = "view-save-btn";
    saveBtn.textContent = "\u21bb";
    saveBtn.title = "Overwrite with current state";
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      Object.assign(view, captureViewState());
      saveViewsToServer();
      renderViewPane();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "view-delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Delete view";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      currentViews = currentViews.filter((v) => v.id !== view.id);
      if (activeViewId === view.id) {
        activeViewId = null;
        saveActiveViewToServer();
      }
      saveViewsToServer();
      renderViewPane();
    });

    li.append(name, saveBtn, delBtn);

    // Click to apply (delayed to allow double-click)
    let viewClickTimer = null;
    li.addEventListener("click", () => {
      if (viewClickTimer) clearTimeout(viewClickTimer);
      viewClickTimer = setTimeout(() => {
        viewClickTimer = null;
        if (activeViewId === view.id) {
          // Toggle off: clear filters and deactivate view
          activeViewId = null;
          textFilters.length = 0;
          tagFilters.length = 0;
          currentSort = null;
          completionFilter = "all";
          hiddenTagIds.clear();
          searchInput.value = "";
          renderFilterBar();
          renderItems();
          renderTagPane();
        } else {
          activeViewId = view.id;
          applyViewState(view);
        }
        saveActiveViewToServer();
        renderViewPane();
      }, 250);
    });

    // Double-click to rename
    name.addEventListener("dblclick", (e) => {
      if (viewClickTimer) { clearTimeout(viewClickTimer); viewClickTimer = null; }
      e.stopPropagation();
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "list-rename-input";
      inp.value = view.name;
      name.replaceWith(inp);
      inp.focus();
      inp.select();
      function commit() {
        const val = inp.value.trim();
        if (val && val !== view.name) {
          view.name = val;
          saveViewsToServer();
        }
        renderViewPane();
      }
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") { ke.preventDefault(); inp.blur(); }
        if (ke.key === "Escape") { inp.value = view.name; inp.blur(); }
        ke.stopPropagation();
      });
      inp.addEventListener("click", (ce) => ce.stopPropagation());
      inp.addEventListener("mousedown", (me) => me.stopPropagation());
    });

    viewListEl.appendChild(li);
  }
}

btnSaveView.addEventListener("click", () => {
  // Create new view with inline naming
  const li = document.createElement("li");
  li.className = "view-entry";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "list-rename-input";
  inp.placeholder = "View name\u2026";
  li.appendChild(inp);
  viewListEl.insertBefore(li, viewListEl.firstChild);
  inp.focus();
  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const name = inp.value.trim();
    if (name) {
      const view = {
        id: Math.random().toString(36).slice(2, 14),
        name,
        ...captureViewState(),
      };
      currentViews.push(view);
      activeViewId = view.id;
      saveViewsToServer();
      saveActiveViewToServer();
    }
    renderViewPane();
  }
  inp.addEventListener("blur", commit);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { inp.value = ""; inp.blur(); }
    e.stopPropagation();
  });
});

// -------------------------------------------------------------------
// Context menu
// -------------------------------------------------------------------

const ctxMenu = document.getElementById("context-menu");
const ctxHeader = document.getElementById("context-menu-header");
const ctxDelete = document.getElementById("ctx-delete");
const ctxCopy = document.getElementById("ctx-copy");
const ctxTags = document.getElementById("ctx-tags");
let ctxItemId = null;
let ctxHierarchy = false;

function showContextMenu(e, itemId, hierarchy) {
  e.preventDefault();
  hideListContextMenu();
  ctxItemId = itemId;
  ctxHierarchy = hierarchy;

  const item = currentItems.find((it) => it.id === itemId);
  if (!item) return;

  ctxHeader.textContent = hierarchy ? "Hierarchy" : "Item";
  ctxDelete.textContent = hierarchy ? "Delete hierarchy" : "Delete";
  ctxCopy.textContent = hierarchy ? "Copy hierarchy" : "Copy to clipboard";

  // Show/hide "Visit link"
  const urlMatch = item.text.match(/https?:\/\/[^\s]+/);
  const ctxLink = document.getElementById("ctx-link");
  if (urlMatch) {
    ctxLink.classList.remove("disabled");
    ctxLink.dataset.url = urlMatch[0];
  } else {
    ctxLink.classList.add("disabled");
    ctxLink.dataset.url = "";
  }

  // Build tag list
  ctxTags.innerHTML = "";
  for (const tagDef of currentTags) {
    const row = document.createElement("div");
    row.className = "context-menu-tag";

    const check = document.createElement("span");
    check.className = "ctx-tag-check";

    if (hierarchy) {
      const dataIdx = currentItems.indexOf(item);
      const [start, end] = getChildRange(dataIdx);
      const block = [item, ...currentItems.slice(start, end)];
      const allHave = block.every((it) => itemHasTag(it, tagDef.id));
      const someHave = block.some((it) => itemHasTag(it, tagDef.id));
      check.textContent = allHave ? "\u2713" : someHave ? "\u2013" : "";
    } else {
      check.textContent = itemHasTag(item, tagDef.id) ? "\u2713" : "";
    }

    const dot = document.createElement("span");
    dot.className = "ctx-tag-dot";
    dot.style.background = tagDef.color;

    const name = document.createElement("span");
    name.textContent = tagDef.name;

    row.append(check, dot, name);
    row.addEventListener("click", () => {
      if (hierarchy) {
        toggleTagOnContextHierarchy(tagDef.id);
      } else {
        toggleTagOnContextItem(tagDef.id);
      }
    });
    ctxTags.appendChild(row);
  }

  // Position menu
  ctxMenu.classList.remove("hidden");
  if (mobileQuery.matches) {
    // Bottom sheet — CSS handles positioning, show backdrop
    ctxMenu.style.left = "";
    ctxMenu.style.top = "";
    panelBackdrop.classList.add("active");
    // Scroll item above the bottom sheet
    const itemEl = itemsEl.querySelector(`.item[data-id="${itemId}"]`);
    if (itemEl) {
      const menuTop = window.innerHeight - ctxMenu.getBoundingClientRect().height;
      const itemRect = itemEl.getBoundingClientRect();
      if (itemRect.bottom > menuTop) {
        itemsContainer.scrollBy({ top: itemRect.bottom - menuTop + 10, behavior: "smooth" });
      }
    }
  } else {
    const menuRect = ctxMenu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 5;
    if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 5;
    ctxMenu.style.left = x + "px";
    ctxMenu.style.top = y + "px";
  }
}

function hideContextMenu() {
  ctxMenu.classList.add("hidden");
  if (mobileQuery.matches) panelBackdrop.classList.remove("active");
  ctxItemId = null;
}

function toggleTagOnContextItem(tagId) {
  const item = currentItems.find((it) => it.id === ctxItemId);
  if (!item) return;
  if (itemHasTag(item, tagId)) {
    removeTagFromItemData(item, tagId);
  } else {
    addTagToItem(item, tagId);
  }
  renderItems();
  api(`/lists/${currentListId}/items/${ctxItemId}`, {
    method: "PATCH",
    body: { tags: item.tags },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
  // Refresh the menu to update checks
  showContextMenuForCurrentItem();
}

function toggleTagOnContextHierarchy(tagId) {
  const item = currentItems.find((it) => it.id === ctxItemId);
  if (!item) return;
  const dataIdx = currentItems.indexOf(item);
  const [start, end] = getChildRange(dataIdx);
  const block = [item, ...currentItems.slice(start, end)];
  const allHave = block.every((it) => itemHasTag(it, tagId));
  const updates = [];
  for (const it of block) {
    if (allHave) {
      removeTagFromItemData(it, tagId);
    } else {
      addTagToItem(it, tagId);
    }
    updates.push({ id: it.id, tags: [...it.tags] });
  }
  renderItems();
  api(`/lists/${currentListId}/items`, {
    method: "PATCH",
    body: { updates },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
  showContextMenuForCurrentItem();
}

function showContextMenuForCurrentItem() {
  // Re-show the menu at its current position to refresh tag checks
  if (!ctxItemId) return;
  const rect = ctxMenu.getBoundingClientRect();
  const fakeEvent = { preventDefault() {}, clientX: rect.left, clientY: rect.top };
  showContextMenu(fakeEvent, ctxItemId, ctxHierarchy);
}

ctxDelete.addEventListener("click", () => {
  if (!ctxItemId) return;
  const item = currentItems.find((it) => it.id === ctxItemId);
  if (!item) return;
  let ids;
  if (ctxHierarchy) {
    const dataIdx = currentItems.indexOf(item);
    const [start, end] = getChildRange(dataIdx);
    ids = new Set([item.id, ...currentItems.slice(start, end).map((it) => it.id)]);
  } else {
    ids = new Set([ctxItemId]);
  }
  // Optimistic local delete, single bulk server request
  currentItems = currentItems.filter((it) => !ids.has(it.id));
  renderItems();
  api(`/lists/${currentListId}/items/bulk-delete`, {
    method: "POST",
    body: { item_ids: [...ids] },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
  hideContextMenu();
});

ctxCopy.addEventListener("click", async () => {
  if (!ctxItemId) return;
  const item = currentItems.find((it) => it.id === ctxItemId);
  if (!item) return;
  let items;
  if (ctxHierarchy) {
    const dataIdx = currentItems.indexOf(item);
    const [start, end] = getChildRange(dataIdx);
    items = [item, ...currentItems.slice(start, end)];
  } else {
    items = [item];
  }
  const baseDepth = items[0].depth;
  const lines = items.map((it) => {
    const indent = "  ".repeat(it.depth - baseDepth);
    const checkbox = it.done ? "[x]" : "[ ]";
    return `${indent}- ${checkbox} ${it.text}`;
  });
  await navigator.clipboard.writeText(lines.join("\n"));
  hideContextMenu();
});

document.getElementById("ctx-link").addEventListener("click", () => {
  const url = document.getElementById("ctx-link").dataset.url;
  if (url) {
    window.open(url, "_blank", "noopener");
    hideContextMenu();
  }
});

const ctxGather = document.getElementById("ctx-gather");

ctxGather.addEventListener("click", () => {
  if (!ctxItemId) return;
  const target = currentItems.find((it) => it.id === ctxItemId);
  if (!target) return;
  const targetIdx = currentItems.indexOf(target);
  const targetName = target.text.trim().toLowerCase();
  const targetDepth = target.depth;

  // Determine search scope
  let scopeStart = 0;
  let scopeEnd = currentItems.length;
  if (targetDepth > 0) {
    // Find parent's hierarchy bounds
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (currentItems[i].depth < targetDepth) {
        scopeStart = i + 1;
        break;
      }
    }
    const parentIdx = scopeStart - 1;
    if (parentIdx >= 0) {
      const [, pEnd] = getChildRange(parentIdx);
      scopeEnd = pEnd;
    }
  }

  // Find matching items at the same depth within scope
  const matchIndices = [];
  for (let i = scopeStart; i < scopeEnd; i++) {
    if (i === targetIdx) continue;
    if (currentItems[i].depth === targetDepth &&
        currentItems[i].text.trim().toLowerCase() === targetName) {
      matchIndices.push(i);
    }
  }

  if (matchIndices.length === 0) {
    hideContextMenu();
    return;
  }

  // Collect children from each match (in global order) and remove duplicates
  const childrenToGather = [];
  const indicesToRemove = new Set();
  // Process matches in reverse so indices stay valid
  for (const mi of matchIndices.slice().reverse()) {
    const [cStart, cEnd] = getChildRange(mi);
    // Collect children, adjusting depth relative to target
    for (let c = cStart; c < cEnd; c++) {
      childrenToGather.push(currentItems[c]);
      indicesToRemove.add(c);
    }
    // Mark the duplicate parent for removal
    indicesToRemove.add(mi);
  }

  // Sort gathered children by their original index to maintain global order
  childrenToGather.sort((a, b) => currentItems.indexOf(a) - currentItems.indexOf(b));

  // Find where to insert: after target's existing children
  const [, targetChildEnd] = getChildRange(targetIdx);

  // Remove gathered items from list
  currentItems = currentItems.filter((_, i) => !indicesToRemove.has(i));

  // Find target's new position (may have shifted after removals)
  const newTargetIdx = currentItems.indexOf(target);
  const [, newEnd] = getChildRange(newTargetIdx);

  // Insert gathered children after existing children
  currentItems.splice(newEnd, 0, ...childrenToGather);

  renderItems();
  hideContextMenu();

  // Send gather request to server
  api(`/lists/${currentListId}/items/gather`, {
    method: "POST",
    body: { item_id: ctxItemId },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
});

// Close context menu on click elsewhere
document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});
document.addEventListener("contextmenu", (e) => {
  if (!ctxMenu.contains(e.target) && !e.target.closest(".item")) hideContextMenu();
});

// -------------------------------------------------------------------
// Keyboard shortcuts
// -------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (!currentListId) return;

  // Ctrl+. — toggle collapse on focused item
  if (e.ctrlKey && e.key === ".") {
    e.preventDefault();
    const focused = document.activeElement;
    const itemEl = focused?.closest?.(".item");
    if (itemEl) {
      const id = itemEl.dataset.id;
      const idx = parseInt(itemEl.dataset.index, 10);
      if (hasChildren(idx)) toggleCollapse(id);
    }
    return;
  }

  // Ctrl+0..9 — toggle collapse at depth N
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= "0" && e.key <= "9") {
    const depth = parseInt(e.key, 10);
    const maxDepth = currentItems.reduce((m, it) => Math.max(m, it.depth), 0);
    if (depth <= maxDepth) {
      e.preventDefault();
      let anyExpanded = false;
      for (let i = 0; i < currentItems.length; i++) {
        if (currentItems[i].depth === depth && hasChildren(i) && !collapsedIds.has(currentItems[i].id)) {
          anyExpanded = true;
          break;
        }
      }
      if (anyExpanded) collapseAllAtDepth(depth);
      else expandAllAtDepth(depth);
    }
    return;
  }

  // Ctrl+E — expand all
  if (e.ctrlKey && e.key === "e" && !e.shiftKey && !e.altKey) {
    if (document.activeElement?.classList?.contains("item-text")) return;
    e.preventDefault();
    expandAll();
    return;
  }

  // Ctrl+Z — undo
  if (e.ctrlKey && e.key === "z" && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    performUndo();
    return;
  }

  // Ctrl+Shift+Z or Ctrl+Y — redo
  if (e.ctrlKey && ((e.key === "z" && e.shiftKey) || (e.key === "y" && !e.shiftKey)) && !e.altKey) {
    e.preventDefault();
    performRedo();
    return;
  }
});

// -------------------------------------------------------------------
// List context menu
// -------------------------------------------------------------------

const listCtxMenu = document.getElementById("list-context-menu");
const listCtxHeader = document.getElementById("list-ctx-header");
let listCtxId = null;
let listCtxName = null;

function showListContextMenu(e, listId, listName, ownerId) {
  e.preventDefault();
  listCtxId = listId;
  listCtxName = listName;
  listCtxHeader.textContent = listName;
  hideContextMenu();

  const isOwner = !ownerId || ownerId === currentUserId;
  document.getElementById("list-ctx-rename").style.display = isOwner ? "" : "none";
  document.getElementById("list-ctx-delete").style.display = isOwner ? "" : "none";
  document.getElementById("list-ctx-leave").style.display = isOwner ? "none" : "";

  if (mobileQuery.matches) {
    listCtxMenu.style.left = "0";
    listCtxMenu.style.top = "";
    listCtxMenu.style.bottom = "0";
    listCtxMenu.style.right = "0";
    listCtxMenu.style.borderRadius = "12px 12px 0 0";
    listCtxMenu.style.width = "100%";
    panelBackdrop.classList.add("active");
  } else {
    listCtxMenu.style.bottom = "";
    listCtxMenu.style.right = "";
    listCtxMenu.style.borderRadius = "";
    listCtxMenu.style.width = "";
    listCtxMenu.style.left = e.clientX + "px";
    listCtxMenu.style.top = e.clientY + "px";
  }
  listCtxMenu.classList.remove("hidden");
}

function hideListContextMenu() {
  listCtxMenu.classList.add("hidden");
  if (mobileQuery.matches) panelBackdrop.classList.remove("active");
}

document.getElementById("list-ctx-rename").addEventListener("click", () => {
  hideListContextMenu();
  const li = listIndex.querySelector(`li[data-id="${listCtxId}"]`);
  if (li) startListRename(li, listCtxId, listCtxName);
});

document.getElementById("list-ctx-delete").addEventListener("click", () => {
  hideListContextMenu();
  deleteListById(listCtxId, listCtxName);
});

async function leaveList(listId, listName) {
  if (!confirm(`Leave "${listName}"? You will lose access unless re-shared.`)) return;
  await api(`/lists/${listId}/leave`, { method: "POST" });
  if (listId === currentListId) {
    currentListId = null;
    listView.classList.add("hidden");
    tagPane.classList.add("hidden");
    emptyState.classList.remove("hidden");
  }
  await loadLists();
}

document.getElementById("list-ctx-leave").addEventListener("click", () => {
  hideListContextMenu();
  leaveList(listCtxId, listCtxName);
});

document.getElementById("list-ctx-sharing").addEventListener("click", () => {
  hideListContextMenu();
  showSharingModal(listCtxId);
});

// Close list context menu on outside click
document.addEventListener("click", (e) => {
  if (!listCtxMenu.contains(e.target)) hideListContextMenu();
});

// -------------------------------------------------------------------
// Sharing modal
// -------------------------------------------------------------------

const sharingModal = document.getElementById("sharing-modal");

document.getElementById("sharing-close").addEventListener("click", () => {
  sharingModal.classList.add("hidden");
});
sharingModal.addEventListener("click", (e) => {
  if (e.target === sharingModal) sharingModal.classList.add("hidden");
});

async function showSharingModal(listId) {
  const [sharing, contacts] = await Promise.all([
    api(`/lists/${listId}/sharing`),
    api("/contacts"),
  ]);
  if (!sharing || sharing.error) return;

  document.getElementById("sharing-modal-title").textContent = "Sharing";
  const ownerEl = document.getElementById("sharing-owner");
  if (sharing.owner) {
    ownerEl.textContent = `Owner: ${sharing.owner.display_name} (${sharing.owner.username})`;
  } else {
    ownerEl.textContent = "Owner: unset";
  }

  const listEl = document.getElementById("sharing-list");
  const noContactsEl = document.getElementById("sharing-no-contacts");
  listEl.innerHTML = "";

  const contactList = contacts?.contacts || [];
  const sharedMap = {};
  for (const s of sharing.shared_with) {
    sharedMap[s.user_id] = s.permission;
  }

  if (!sharing.is_owner) {
    // Non-owners can only view sharing info
    if (sharing.shared_with.length === 0) {
      noContactsEl.textContent = "This list is not shared with anyone.";
    } else {
      noContactsEl.textContent = "";
      for (const s of sharing.shared_with) {
        const row = document.createElement("div");
        row.className = "sharing-row";
        row.innerHTML = `<span class="sharing-name">${s.display_name} (${s.username})</span>
          <span style="font-size:0.75rem; color:var(--text-muted)">${s.permission}</span>`;
        listEl.appendChild(row);
      }
    }
  } else if (contactList.length === 0) {
    noContactsEl.textContent = "Add contacts on the User page to share lists.";
  } else {
    noContactsEl.textContent = "";
    for (const c of contactList) {
      const perm = sharedMap[c.id] || null;
      const row = document.createElement("div");
      row.className = "sharing-row";

      const name = document.createElement("span");
      name.className = "sharing-name";
      name.textContent = `${c.display_name} (${c.username})`;

      const controls = document.createElement("span");
      controls.className = "sharing-controls";

      const levels = [
        { key: null, label: "None" },
        { key: "view", label: "View" },
        { key: "check", label: "Check" },
        { key: "edit", label: "Edit" },
      ];

      async function setPermission(newPerm) {
        const current = await api(`/lists/${listId}`);
        if (!current || current.error) return;
        let sw = current.shared_with || [];
        sw = sw.filter(s => s.user_id !== c.id);
        if (newPerm) {
          sw.push({ user_id: c.id, permission: newPerm });
        }
        await api(`/lists/${listId}`, { method: "PATCH", body: { shared_with: sw } });
        showSharingModal(listId);
      }

      for (const lvl of levels) {
        const btn = document.createElement("button");
        btn.className = "sharing-btn" + (perm === lvl.key ? " active" : "");
        btn.textContent = lvl.label;
        btn.addEventListener("click", () => setPermission(perm === lvl.key ? null : lvl.key));
        controls.appendChild(btn);
      }
      row.append(name, controls);
      listEl.appendChild(row);
    }
  }

  sharingModal.classList.remove("hidden");
}

// -------------------------------------------------------------------
// Undo / Redo
// -------------------------------------------------------------------

async function flushActiveEdit() {
  const active = document.activeElement;
  if (active?.classList?.contains("item-text")) {
    const itemEl = active.closest(".item");
    if (itemEl) {
      const itemId = itemEl.dataset.id;
      const item = currentItems.find((it) => it.id === itemId);
      const val = active.value.trim();
      if (item && val !== item.text) {
        item.text = val;
        await api(`/lists/${currentListId}/items/${itemId}`, {
          method: "PATCH",
          body: { text: val },
        });
      }
    }
  }
}

async function performUndo() {
  if (!currentListId) return;
  await flushActiveEdit();
  const data = await api(`/lists/${currentListId}/undo`, { method: "POST" });
  if (data && !data.error) {
    currentItems = data.items;
    currentTags = data.tags || [];
    renderItems();
    renderTagPane();
  }
}

async function performRedo() {
  if (!currentListId) return;
  const data = await api(`/lists/${currentListId}/redo`, { method: "POST" });
  if (data && !data.error) {
    currentItems = data.items;
    currentTags = data.tags || [];
    renderItems();
    renderTagPane();
  }
}

// -------------------------------------------------------------------
// Drag and drop
// -------------------------------------------------------------------

let dragState = null;
const DRAG_THRESHOLD = 5;

function onItemMouseDown(e, itemId, isTextClick = false) {
  const startX = e.clientX;
  const startY = e.clientY;
  const ctrlKey = e.ctrlKey;
  let started = false;

  function onMove(me) {
    const dx = me.clientX - startX;
    const dy = me.clientY - startY;
    if (!started && Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
      started = true;
      // Suppress text selection during drag
      document.body.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
      // Blur any focused text input so edits save
      if (document.activeElement?.classList?.contains("item-text")) {
        document.activeElement.blur();
      }
      startDrag(me, itemId, startY, ctrlKey);
    }
    if (started && dragState) {
      onDragMove(me);
    }
  }

  function onUp(ue) {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (started) {
      document.body.style.userSelect = "";
      onDragEnd();
    } else if (isTextClick && !ue.shiftKey && !ue.ctrlKey) {
      // Select the item without re-rendering (which would destroy the focused input)
      selectedIds.clear();
      selectedIds.add(itemId);
      lastSelectedId = itemId;
      applySelectionStyles();
    } else {
      handleSelectionClick(itemId, ue.shiftKey, ue.ctrlKey);
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startDrag(e, itemId, startY, ctrlKey) {
  const sourceEl = itemsEl.querySelector(`.item[data-id="${itemId}"]`);
  if (!sourceEl) return;

  const rect = sourceEl.getBoundingClientRect();
  const itemsRect = itemsEl.getBoundingClientRect();

  let blockIds;
  let useFullReorder = false;

  if (ctrlKey) {
    // Ctrl+drag: include children
    const dataIdx = currentItems.findIndex((it) => it.id === itemId);
    const [, end] = getChildRange(dataIdx);
    blockIds = new Set(currentItems.slice(dataIdx, end).map((it) => it.id));
  } else if (selectedIds.size > 1 && selectedIds.has(itemId)) {
    // Drag selection: consolidate selected items at the dragged item's position
    blockIds = new Set(selectedIds);
    useFullReorder = true;
    // Pull selected items out, preserving their relative order
    const selected = currentItems.filter((it) => blockIds.has(it.id));
    const rest = currentItems.filter((it) => !blockIds.has(it.id));
    // Find where the dragged item would be among the remaining items
    const dragIdx = currentItems.findIndex((it) => it.id === itemId);
    // Count how many non-selected items come before the drag point
    let insertAt = 0;
    for (let i = 0; i < dragIdx; i++) {
      if (!blockIds.has(currentItems[i].id)) insertAt++;
    }
    rest.splice(insertAt, 0, ...selected);
    currentItems = rest;
  } else {
    // Single item drag
    blockIds = new Set([itemId]);
  }

  const blockSize = blockIds.size;

  // Create ghost
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.style.width = rect.width + "px";
  const label = sourceEl.querySelector(".item-text")?.value || "";
  ghost.textContent = blockSize > 1 ? `${label} (+${blockSize - 1})` : label;
  const depth = parseInt(sourceEl.dataset.depth) || 0;
  ghost.style.paddingLeft = (depth * 1.8 + 0.3) + "rem";
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  document.body.appendChild(ghost);

  markDragSource(blockIds);

  // Re-render to show consolidated positions
  if (useFullReorder) renderItems();

  dragState = {
    itemId,
    ghost,
    blockIds,
    blockSize,
    useFullReorder,
    offsetX: e.clientX - rect.left,
    offsetY: startY - rect.top,
    itemHeight: ITEM_HEIGHT,
    itemsRect,
    currentVisibleIdx: getVisibleIndex(itemId),
    sourceListId: currentListId,
    crossListTarget: null,
    hoverListId: null,
    hoverTimer: null,
    switchedList: false,
    draggedItems: null,
  };

  markDragSource(blockIds);
}

function getVisibleIndex(itemId) {
  for (let i = 0; i < visibleList.length; i++) {
    if (visibleList[i].item.id === itemId) return i;
  }
  return -1;
}

function getDataIndexOfVisibleRow(visibleRow) {
  if (visibleRow >= 0 && visibleRow < visibleList.length) {
    return visibleList[visibleRow].dataIdx;
  }
  return currentItems.length;
}

function markDragSource(blockIds) {
  for (const id of blockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.add("drag-source");
  }
}

function clearDragSource(blockIds) {
  for (const id of blockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.remove("drag-source");
  }
}

function getListEntryUnderMouse(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return null;
  const li = el.closest("#list-index li");
  return li;
}

function clearSidebarHighlight() {
  listIndex.querySelectorAll("li.drag-target").forEach((el) => el.classList.remove("drag-target"));
}

function onDragMove(e) {
  if (!dragState) return;
  const { ghost, itemId, blockIds, blockSize, offsetY, itemHeight, itemsRect } = dragState;

  // Move ghost to follow mouse
  ghost.style.left = (e.clientX - dragState.offsetX) + "px";
  ghost.style.top = (e.clientY - offsetY) + "px";

  // Check if mouse is over sidebar list
  const targetListEntry = getListEntryUnderMouse(e);
  clearSidebarHighlight();

  if (targetListEntry && targetListEntry.dataset.id !== dragState.sourceListId) {
    targetListEntry.classList.add("drag-target");
    dragState.crossListTarget = targetListEntry.dataset.id;

    // Hover-to-switch: start timer to switch to hovered list
    if (dragState.hoverListId !== targetListEntry.dataset.id) {
      dragState.hoverListId = targetListEntry.dataset.id;
      if (dragState.hoverTimer) clearTimeout(dragState.hoverTimer);
      dragState.hoverTimer = setTimeout(() => {
        switchDuringDrag(dragState.hoverListId);
      }, 1000);
    }
    return;
  }

  // Not over sidebar — clear hover timer
  if (dragState.hoverTimer) { clearTimeout(dragState.hoverTimer); dragState.hoverTimer = null; }
  dragState.hoverListId = null;
  dragState.crossListTarget = null;

  // Normal within-list drag logic
  const container = document.getElementById("items-container");
  const relY = e.clientY - itemsRect.top + container.scrollTop;
  let targetRow = Math.round(relY / itemHeight);
  targetRow = Math.max(0, Math.min(targetRow, visibleList.length));

  if (targetRow === dragState.currentVisibleIdx) return;

  const srcDataIdx = currentItems.findIndex((it) => it.id === itemId);
  const destDataIdx = getDataIndexOfVisibleRow(targetRow);
  if (srcDataIdx === -1 || srcDataIdx === destDataIdx) return;

  const block = currentItems.splice(srcDataIdx, blockSize);
  const insertIdx = destDataIdx > srcDataIdx ? destDataIdx - blockSize : destDataIdx;
  currentItems.splice(Math.max(0, insertIdx), 0, ...block);

  dragState.currentVisibleIdx = targetRow;
  renderItems();
  markDragSource(blockIds);
}

async function switchDuringDrag(destListId) {
  if (!dragState) return;
  // Remember source list so we can move items on drop
  dragState.switchedList = true;

  // Remove dragged items from current display
  const { blockIds } = dragState;
  dragState.draggedItems = currentItems.filter((it) => blockIds.has(it.id));
  currentItems = currentItems.filter((it) => !blockIds.has(it.id));

  // Switch to destination list
  const data = await api(`/lists/${destListId}`);
  if (!data || data.error || !dragState) return;

  currentListId = destListId;
  currentItems = data.items;
  currentTags = data.tags || [];
  listTitle.textContent = data.name;

  // Insert dragged items at top temporarily
  currentItems.unshift(...dragState.draggedItems);
  dragState.blockSize = dragState.draggedItems.length;
  dragState.currentVisibleIdx = 0;
  dragState.itemsRect = itemsEl.getBoundingClientRect();

  renderItems();
  renderTagPane();
  listIndex.querySelectorAll("li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === destListId);
  });
  clearSidebarHighlight();

  markDragSource(blockIds);
}

function onDragEnd() {
  if (!dragState) return;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);

  const { itemId, blockIds, blockSize, useFullReorder, ghost, sourceListId, crossListTarget, switchedList } = dragState;
  ghost.remove();
  clearSidebarHighlight();
  if (dragState.hoverTimer) clearTimeout(dragState.hoverTimer);

  clearDragSource(blockIds);

  const itemIds = [...blockIds];
  dragState = null;

  if (crossListTarget && !switchedList) {
    // Simple drop on sidebar: move to top of destination list
    currentItems = currentItems.filter((it) => !blockIds.has(it.id));
    renderItems();
    api(`/lists/${crossListTarget}/items/move-from`, {
      method: "POST",
      body: { source_list_id: sourceListId, item_ids: itemIds, index: 0 },
    }).then(() => {
      scheduleSyncFromServer();
    }).catch(() => refreshItems());
  } else if (switchedList || currentListId !== sourceListId) {
    // Dropped within switched list — commit the cross-list move at current position
    const finalIdx = currentItems.findIndex((it) => it.id === itemId);
    // Remove dragged items from display (server will add them)
    currentItems = currentItems.filter((it) => !blockIds.has(it.id));
    renderItems();
    api(`/lists/${currentListId}/items/move-from`, {
      method: "POST",
      body: { source_list_id: sourceListId, item_ids: itemIds, index: Math.max(0, finalIdx) },
    }).then(() => {
      refreshItems();
      loadLists();
    }).catch(() => refreshItems());
  } else {
    // Normal within-list reorder
    let body;
    if (useFullReorder) {
      body = { order: currentItems.map((it) => it.id) };
    } else {
      const finalIdx = currentItems.findIndex((it) => it.id === itemId);
      body = { item_id: itemId, index: finalIdx, count: blockSize };
    }
    api(`/lists/${currentListId}/items/reorder`, {
      method: "POST",
      body,
    }).then(() => scheduleSyncFromServer())
      .catch(() => refreshItems());
  }
}

// -------------------------------------------------------------------
// Touch support (long-press context menu)
// -------------------------------------------------------------------

const itemsContainer = document.getElementById("items-container");

let longPressActive = false;  // true while a long-press timer is running

// Suppress native context menu and text selection on mobile
if (mobileQuery.matches) {
  window.oncontextmenu = (e) => { e.preventDefault(); return false; };
}
mobileQuery.addEventListener("change", (e) => {
  window.oncontextmenu = e.matches ? (ev) => { ev.preventDefault(); return false; } : null;
});
document.addEventListener("selectstart", (e) => {
  if (longPressActive && mobileQuery.matches) e.preventDefault();
});

function setupItemTouch(li, itemId) {
  let longPressTimer = null;

  li.addEventListener("touchstart", (e) => {
    if (e.target.type === "checkbox") return;
    const touch = e.touches[0];
    longPressActive = true;

    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressActive = false;
      window.getSelection()?.removeAllRanges();
      // Blur input to dismiss iOS keyboard/selection
      if (document.activeElement?.classList?.contains("item-text")) {
        document.activeElement.blur();
      }
      showContextMenu(
        { preventDefault() {}, clientX: touch.clientX, clientY: touch.clientY },
        itemId, false
      );
      // Clear selection again after a tick (iOS sometimes re-selects)
      setTimeout(() => window.getSelection()?.removeAllRanges(), 50);
    }, 500);
  }, { passive: true });

  li.addEventListener("touchmove", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; longPressActive = false; }
  }, { passive: true });

  li.addEventListener("touchend", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });
}

// -------------------------------------------------------------------
// Mobile reorder mode
// -------------------------------------------------------------------

const reorderBanner = document.getElementById("reorder-banner");
const reorderLabel = document.getElementById("reorder-label");
const reorderCursor = document.getElementById("reorder-cursor");
let reorderItemId = null;   // the item being moved
let reorderBlockIds = null; // Set of ids (item + children if hierarchy)

function enterReorderMode(itemId, hierarchy) {
  const item = currentItems.find((it) => it.id === itemId);
  if (!item) return;

  reorderItemId = itemId;
  const dataIdx = currentItems.indexOf(item);

  if (hierarchy) {
    const [start, end] = getChildRange(dataIdx);
    reorderBlockIds = new Set(currentItems.slice(dataIdx, end).map((it) => it.id));
  } else {
    reorderBlockIds = new Set([itemId]);
  }

  const label = item.text || "(untitled)";
  const count = reorderBlockIds.size;
  reorderLabel.textContent = count > 1
    ? `Moving: ${label} (+${count - 1})`
    : `Moving: ${label}`;

  // Mark source items
  for (const id of reorderBlockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.add("drag-source");
  }

  reorderBanner.classList.remove("hidden");
  reorderCursor.classList.remove("hidden");
  updateReorderCursor();
  itemsContainer.addEventListener("scroll", updateReorderCursor);
}

function updateReorderCursor() {
  if (!reorderItemId) return;
  const containerRect = itemsContainer.getBoundingClientRect();
  // Cursor sits at vertical center of the items container
  const cursorY = containerRect.top + containerRect.height / 2;
  reorderCursor.style.top = cursorY + "px";
}

function getReorderInsertIndex() {
  const containerRect = itemsContainer.getBoundingClientRect();
  const centerY = containerRect.height / 2;
  const scrollTop = itemsContainer.scrollTop;
  // Which visible row is at the center?
  const row = Math.round((scrollTop + centerY) / ITEM_HEIGHT);
  // Convert visible row to data index
  const dataIdx = getDataIndexOfVisibleRow(Math.max(0, row));
  return dataIdx;
}

function commitReorder() {
  if (!reorderItemId) return;

  const destIdx = getReorderInsertIndex();

  // Remove the block from current position
  const block = currentItems.filter((it) => reorderBlockIds.has(it.id));
  currentItems = currentItems.filter((it) => !reorderBlockIds.has(it.id));

  // Insert at destination (adjust for removal shift)
  const clampedIdx = Math.min(destIdx, currentItems.length);
  // Find the right insert position — destIdx was computed before removal,
  // so recalculate based on new array
  const insertAt = Math.min(clampedIdx, currentItems.length);
  currentItems.splice(insertAt, 0, ...block);

  renderItems();

  // Send reorder to server
  api(`/lists/${currentListId}/items/reorder`, {
    method: "POST",
    body: { order: currentItems.map((it) => it.id) },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());

  exitReorderMode();
}

function exitReorderMode() {
  if (reorderBlockIds) {
    for (const id of reorderBlockIds) {
      const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
      if (el) el.classList.remove("drag-source");
    }
  }
  reorderItemId = null;
  reorderBlockIds = null;
  reorderBanner.classList.add("hidden");
  reorderCursor.classList.add("hidden");
  itemsContainer.removeEventListener("scroll", updateReorderCursor);
}

document.getElementById("reorder-place").addEventListener("click", commitReorder);
document.getElementById("reorder-cancel").addEventListener("click", exitReorderMode);
document.getElementById("ctx-move").addEventListener("click", () => {
  const itemId = ctxItemId;
  hideContextMenu();
  enterReorderMode(itemId, false);
});
document.getElementById("ctx-move-hierarchy").addEventListener("click", () => {
  const itemId = ctxItemId;
  hideContextMenu();
  enterReorderMode(itemId, true);
});

// -------------------------------------------------------------------
// Auth
// -------------------------------------------------------------------

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  window.location.href = "/";
});

let currentUserId = null;
async function loadCurrentUser() {
  const data = await api("/me");
  if (data && !data.error) {
    currentUserId = data.id;
    document.getElementById("user-display").textContent = data.display_name || data.username;
  }
}

// -------------------------------------------------------------------
// Mobile panel toggles
// -------------------------------------------------------------------

const panelBackdrop = document.getElementById("panel-backdrop");
const sidebar = document.getElementById("sidebar");

function closePanels() {
  sidebar.classList.remove("panel-open");
  tagPane.classList.remove("panel-open");
  document.body.classList.remove("panel-active");
}

document.getElementById("btn-toggle-sidebar").addEventListener("click", () => {
  const opening = !sidebar.classList.contains("panel-open");
  closePanels();
  if (opening) {
    sidebar.classList.add("panel-open");
    document.body.classList.add("panel-active");
  }
});

document.getElementById("btn-toggle-tagpane").addEventListener("click", () => {
  if (!currentListId) return;
  const opening = !tagPane.classList.contains("panel-open");
  closePanels();
  if (opening) {
    tagPane.classList.add("panel-open");
    document.body.classList.add("panel-active");
  }
});

// Close panels when tapping outside them
let panelRecentlyClosed = false;
document.addEventListener("touchstart", (e) => {
  if (!document.body.classList.contains("panel-active")) return;
  if (sidebar.contains(e.target) || tagPane.contains(e.target)) return;
  if (e.target.closest(".header-toggle")) return;
  closePanels();
  panelRecentlyClosed = true;
  setTimeout(() => { panelRecentlyClosed = false; }, 800);
}, true);

// Block ALL events on list-view items while panels are open or just closed.
// iOS WebKit ignores pointer-events:none for touch events and replays them
// when the property is removed, so we must guard in JS.
for (const evt of ["touchstart", "touchend", "click", "mousedown", "mouseup"]) {
  document.addEventListener(evt, (e) => {
    if (!panelRecentlyClosed && !document.body.classList.contains("panel-active")) return;
    if (listView && listView.contains(e.target)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
}


// Handle mobile breakpoint changes
mobileQuery.addEventListener("change", (e) => {
  if (!e.matches) closePanels();
  ITEM_HEIGHT = getItemHeight();
  if (currentListId) renderItems();
});

// -------------------------------------------------------------------
// Background polling (sync from other devices)
// -------------------------------------------------------------------

const POLL_MIN = 5000;      // start at 5 seconds
const POLL_MAX = 30000;     // slow down to 30 seconds
const IDLE_TIMEOUT = 300000; // 5 minutes
let lastActivity = Date.now();
let pollTimer = null;
let pollInterval = POLL_MIN;

function onUserActivity() {
  const wasIdle = Date.now() - lastActivity > IDLE_TIMEOUT;
  lastActivity = Date.now();
  if (wasIdle) {
    pollInterval = POLL_MIN;
    syncFromServer();
    startPolling();
  }
}

function resetPollInterval() {
  pollInterval = POLL_MIN;
}

function schedulePollTick() {
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (!currentListId || document.hidden) return;
    if (Date.now() - lastActivity > IDLE_TIMEOUT) return;
    syncFromServer();
    // Slow down if no changes were detected (pollInterval unchanged),
    // speed up if syncFromServer detected changes (it calls resetPollInterval)
    pollInterval = Math.min(pollInterval * 1.5, POLL_MAX);
    schedulePollTick();
  }, pollInterval);
}

function startPolling() {
  stopPolling();
  pollInterval = POLL_MIN;
  schedulePollTick();
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    lastActivity = Date.now();
    syncFromServer();
    startPolling();
  }
});

for (const evt of ["mousedown", "keydown", "touchstart", "scroll"]) {
  document.addEventListener(evt, onUserActivity, { passive: true, capture: true });
}

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------

const _h1 = document.querySelector("header h1");
_h1.textContent = "Klaar";
dbg(`Klaar v${KLAAR_VERSION}`);
// Debug panel toggle: long-press on mobile, double-click on desktop
if (_isMobile && _dbgEl) {
  let _dbgTimer = null;
  _h1.addEventListener("touchstart", () => {
    _dbgTimer = setTimeout(() => {
      _dbgEl.style.display = _dbgEl.style.display === "none" ? "block" : "none";
      _dbgTimer = null;
    }, 500);
  }, { passive: true });
  _h1.addEventListener("touchend", () => { if (_dbgTimer) { clearTimeout(_dbgTimer); _dbgTimer = null; } });
  _h1.addEventListener("touchmove", () => { if (_dbgTimer) { clearTimeout(_dbgTimer); _dbgTimer = null; } });
}
loadCurrentUser().then(() => loadLists());
