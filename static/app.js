/* Klaar – front-end logic */

const API = "/api";

// DOM refs
const listIndex = document.getElementById("list-index");
const listView = document.getElementById("list-view");
const emptyState = document.getElementById("empty-state");
const listTitle = document.getElementById("list-title");
const itemsEl = document.getElementById("items");
const addForm = document.getElementById("add-item-form");
const newItemText = document.getElementById("new-item-text");
const btnNewList = document.getElementById("btn-new-list");
const btnDeleteList = document.getElementById("btn-delete-list");
const collapseBar = document.getElementById("collapse-bar");
const foldGutter = document.getElementById("fold-gutter");

let currentListId = null;
let currentItems = [];          // latest items from server
const collapsedIds = new Set();  // client-side collapse state

// -------------------------------------------------------------------
// API helpers
// -------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
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
    li.textContent = l.name;
    li.dataset.id = l.id;
    if (l.id === currentListId) li.classList.add("active");
    li.addEventListener("click", () => selectList(l.id));
    listIndex.appendChild(li);
  }
}

async function selectList(id) {
  currentListId = id;
  collapsedIds.clear();
  const data = await api(`/lists/${id}`);
  if (!data || data.error) {
    currentListId = null;
    listView.classList.add("hidden");
    emptyState.classList.remove("hidden");
    await loadLists();
    return;
  }
  currentItems = data.items;
  listTitle.textContent = data.name;
  emptyState.classList.add("hidden");
  listView.classList.remove("hidden");
  renderItems();
  listIndex.querySelectorAll("li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === id);
  });
}

async function refreshItems() {
  const data = await api(`/lists/${currentListId}`);
  if (!data || data.error) return;
  currentItems = data.items;
  renderItems();
}

btnNewList.addEventListener("click", async () => {
  const name = prompt("List name:");
  if (!name) return;
  const data = await api("/lists", { method: "POST", body: { name } });
  await loadLists();
  selectList(data.id);
});

btnDeleteList.addEventListener("click", async () => {
  if (!currentListId) return;
  if (!confirm("Delete this list?")) return;
  await api(`/lists/${currentListId}`, { method: "DELETE" });
  currentListId = null;
  listView.classList.add("hidden");
  emptyState.classList.remove("hidden");
  await loadLists();
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

function isHiddenByCollapse(index) {
  // Walk backwards to see if any ancestor is collapsed and hides this item.
  const item = currentItems[index];
  for (let i = index - 1; i >= 0; i--) {
    if (currentItems[i].depth < item.depth) {
      // This is the nearest ancestor at a shallower depth
      if (collapsedIds.has(currentItems[i].id)) return true;
      // Check if *that* ancestor is itself hidden
      if (isHiddenByCollapse(i)) return true;
      // Continue searching for higher ancestors
    }
  }
  return false;
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
  for (let i = 0; i < currentItems.length; i++) {
    if (currentItems[i].depth === depth) {
      collapsedIds.delete(currentItems[i].id);
    }
  }
  renderItems();
}

function expandAll() {
  collapsedIds.clear();
  renderItems();
}

// -------------------------------------------------------------------
// Items
// -------------------------------------------------------------------

function renderItems() {
  itemsEl.innerHTML = "";
  foldGutter.innerHTML = "";
  const maxDepth = currentItems.reduce((m, it) => Math.max(m, it.depth), 0);
  updateCollapseBar(maxDepth);

  let visibleRow = 0;
  for (let i = 0; i < currentItems.length; i++) {
    const item = currentItems[i];
    if (isHiddenByCollapse(i)) continue;

    const isParent = hasChildren(i);
    const isCollapsed = collapsedIds.has(item.id);
    const row = visibleRow++;

    // Gutter toggle — positioned absolutely to align with the item row
    if (isParent) {
      const btn = document.createElement("button");
      btn.className = "gutter-toggle";
      btn.style.top = (row * 26) + "px";
      btn.textContent = isCollapsed ? "\u25b6" : "\u25bc";
      btn.title = isCollapsed ? "Expand (Ctrl+.)" : "Collapse (Ctrl+.)";
      btn.addEventListener("click", () => toggleCollapse(item.id));
      foldGutter.appendChild(btn);
    }

    const li = document.createElement("li");
    li.className = "item" + (item.done ? " done" : "");
    li.dataset.id = item.id;
    li.dataset.depth = item.depth;
    li.dataset.index = i;

    // drag: mousedown anywhere on the row, but only start drag after threshold
    li.addEventListener("mousedown", (e) => {
      if (e.target.type === "checkbox") return;
      prepareDrag(e, item.id);
    });

    // checkbox
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.addEventListener("change", () => toggleDone(item));

    // text input
    const txt = document.createElement("input");
    txt.type = "text";
    txt.className = "item-text";
    txt.value = item.text;
    txt.draggable = false;
    let deleted = false;
    txt.addEventListener("blur", () => {
      if (deleted) return;
      const val = txt.value.trim();
      if (val !== item.text) {
        updateItem(item.id, { text: val });
      }
    });
    txt.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Save any pending edit, then create a new sibling after this item
        if (txt.value.trim() !== item.text) {
          updateItem(item.id, { text: txt.value.trim() });
        }
        addItemAfter(item.id, item.depth);
        return;
      }
      if (e.key === "Backspace" && txt.value === "") {
        e.preventDefault();
        deleted = true;
        // Find previous item's ID before delete re-renders the DOM
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
        const allTexts = Array.from(itemsEl.querySelectorAll(".item-text"));
        const focused = document.activeElement;
        const idx = allTexts.indexOf(focused);
        const target = allTexts[idx + (e.key === "ArrowUp" ? -1 : 1)];
        if (target) target.focus();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const newDepth = item.depth + (e.shiftKey ? -1 : 1);
        updateItem(item.id, { depth: Math.max(0, newDepth) }, { refocusId: item.id });
      }
    });

    // child count badge when collapsed
    const badge = document.createElement("span");
    badge.className = "child-count";
    if (isParent && isCollapsed) {
      const [start, end] = getChildRange(i);
      badge.textContent = `(${end - start})`;
    }

    // indent/outdent buttons
    const btnOut = document.createElement("button");
    btnOut.className = "btn-icon";
    btnOut.textContent = "\u2190";
    btnOut.title = "Outdent";
    btnOut.addEventListener("click", () =>
      updateItem(item.id, { depth: Math.max(0, item.depth - 1) })
    );

    const btnIn = document.createElement("button");
    btnIn.className = "btn-icon";
    btnIn.textContent = "\u2192";
    btnIn.title = "Indent";
    btnIn.addEventListener("click", () =>
      updateItem(item.id, { depth: item.depth + 1 })
    );

    // delete button
    const btnDel = document.createElement("button");
    btnDel.className = "btn-icon";
    btnDel.textContent = "\u00d7";
    btnDel.title = "Delete";
    btnDel.addEventListener("click", () => deleteItem(item.id));

    li.append(cb, txt, badge, btnOut, btnIn, btnDel);
    itemsEl.appendChild(li);
  }
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
      // If any at this depth are expanded, collapse all; otherwise expand all
      let anyExpanded = false;
      for (let i = 0; i < currentItems.length; i++) {
        if (currentItems[i].depth === d && hasChildren(i) && !collapsedIds.has(currentItems[i].id)) {
          anyExpanded = true;
          break;
        }
      }
      if (anyExpanded) collapseAllAtDepth(d);
      else expandAllAtDepth(d);
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

async function addItemAfter(afterId, depth) {
  const result = await api(`/lists/${currentListId}/items`, {
    method: "POST",
    body: { text: "", after_id: afterId, depth },
  });
  await refreshItems();
  // Focus the new item's text input
  if (result && result.id) {
    const newEl = itemsEl.querySelector(`.item[data-id="${result.id}"] .item-text`);
    if (newEl) {
      newEl.value = "";
      newEl.focus();
    }
  }
}

async function toggleDone(item) {
  await updateItem(item.id, { done: !item.done });
}

// Schedule a full server refresh after edits go idle
let syncTimer = null;
function scheduleSyncFromServer() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const data = await api(`/lists/${currentListId}`);
    if (data && !data.error) {
      currentItems = data.items;
      // Don't re-render if user is mid-edit — just update the data
      const focused = document.activeElement;
      const focusedId = focused?.closest?.(".item")?.dataset?.id;
      renderItems();
      if (focusedId) {
        const el = itemsEl.querySelector(`.item[data-id="${focusedId}"] .item-text`);
        if (el) el.focus();
      }
    }
  }, 1000);
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

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = newItemText.value.trim();
  if (!text) return;
  await api(`/lists/${currentListId}/items`, { method: "POST", body: { text } });
  newItemText.value = "";
  await refreshItems();
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
    // Only intercept if not in a text input
    if (document.activeElement?.classList?.contains("item-text")) return;
    e.preventDefault();
    expandAll();
    return;
  }
});

// -------------------------------------------------------------------
// Drag and drop
// -------------------------------------------------------------------

let dragState = null;
const DRAG_THRESHOLD = 5;

function prepareDrag(e, itemId) {
  const startX = e.clientX;
  const startY = e.clientY;
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
      startDrag(me, itemId, startY);
    }
    if (started && dragState) {
      onDragMove(me);
    }
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (started) {
      document.body.style.userSelect = "";
      onDragEnd();
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startDrag(e, itemId, startY) {
  const sourceEl = itemsEl.querySelector(`.item[data-id="${itemId}"]`);
  if (!sourceEl) return;

  const rect = sourceEl.getBoundingClientRect();
  const itemsRect = itemsEl.getBoundingClientRect();

  // Create ghost
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.style.width = rect.width + "px";
  ghost.textContent = sourceEl.querySelector(".item-text")?.value || "";
  const depth = parseInt(sourceEl.dataset.depth) || 0;
  ghost.style.paddingLeft = (depth * 1.8 + 0.3) + "rem";
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  document.body.appendChild(ghost);

  // Mark source
  sourceEl.classList.add("drag-source");

  dragState = {
    itemId,
    ghost,
    offsetY: startY - rect.top,
    itemHeight: 26,
    itemsRect,
    currentVisibleIdx: getVisibleIndex(itemId),
  };
}

function getVisibleIndex(itemId) {
  // Find the index of this item among currently visible items
  let vis = 0;
  for (let i = 0; i < currentItems.length; i++) {
    if (isHiddenByCollapse(i)) continue;
    if (currentItems[i].id === itemId) return vis;
    vis++;
  }
  return -1;
}

function getDataIndexOfVisibleRow(visibleRow) {
  // Map a visible row number to an index in currentItems
  let vis = 0;
  for (let i = 0; i < currentItems.length; i++) {
    if (isHiddenByCollapse(i)) continue;
    if (vis === visibleRow) return i;
    vis++;
  }
  return currentItems.length;
}

function onDragMove(e) {
  if (!dragState) return;
  const { ghost, itemId, offsetY, itemHeight, itemsRect } = dragState;

  // Move ghost
  ghost.style.left = itemsRect.left + "px";
  ghost.style.top = (e.clientY - offsetY) + "px";

  // Which visible row is the mouse over?
  const relY = e.clientY - itemsRect.top;
  const visibleCount = itemsEl.querySelectorAll(".item").length;
  let targetRow = Math.round(relY / itemHeight);
  targetRow = Math.max(0, Math.min(targetRow, visibleCount));

  if (targetRow === dragState.currentVisibleIdx) return;

  // Move item in the data model
  const srcDataIdx = currentItems.findIndex((it) => it.id === itemId);
  const destDataIdx = getDataIndexOfVisibleRow(targetRow);
  if (srcDataIdx === -1 || srcDataIdx === destDataIdx) return;

  const [moved] = currentItems.splice(srcDataIdx, 1);
  const insertIdx = destDataIdx > srcDataIdx ? destDataIdx - 1 : destDataIdx;
  currentItems.splice(insertIdx, 0, moved);

  dragState.currentVisibleIdx = targetRow;
  renderItems();

  // Re-mark the source element after re-render
  const newSourceEl = itemsEl.querySelector(`.item[data-id="${itemId}"]`);
  if (newSourceEl) newSourceEl.classList.add("drag-source");
}

function onDragEnd() {
  if (!dragState) return;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);

  const { itemId, ghost } = dragState;
  ghost.remove();

  // Remove drag-source styling
  const sourceEl = itemsEl.querySelector(`.item[data-id="${itemId}"]`);
  if (sourceEl) sourceEl.classList.remove("drag-source");

  const finalIdx = currentItems.findIndex((it) => it.id === itemId);
  dragState = null;

  // Send final position to server
  api(`/lists/${currentListId}/items/reorder`, {
    method: "POST",
    body: { item_id: itemId, index: finalIdx },
  }).then(() => scheduleSyncFromServer())
    .catch(() => refreshItems());
}

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------

loadLists();
