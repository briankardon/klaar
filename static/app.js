/* Klaar – front-end logic */

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

let currentListId = null;
let currentItems = [];          // latest items from server
let currentTags = [];           // tag definitions for current list
const collapsedIds = new Set();  // client-side collapse state
const selectedIds = new Set();   // client-side selection state
let lastSelectedId = null;       // anchor for shift-click range selection
const hiddenTagIds = new Set();  // client-side tag visibility state
const textFilters = [];          // [{pattern: string, regex: RegExp}]
const tagFilters = new Map();    // tag ID -> condition string (null = presence only)
let currentSort = null;          // {tagId, direction: "asc"|"desc"} or null

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
    delBtn.title = "Delete list";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteListById(l.id, l.name);
    });

    li.append(nameSpan, delBtn);
    li.addEventListener("click", () => selectList(l.id));
    li.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startListRename(li, l.id, l.name);
    });
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

async function selectList(id) {
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
  listTitle.textContent = data.name;
  emptyState.classList.add("hidden");
  listView.classList.remove("hidden");
  tagPane.classList.remove("hidden");
  renderItems();
  renderTagPane();
  listIndex.querySelectorAll("li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === id);
  });
  if (currentItems.length === 0) {
    addItemAfter(null, 0);
  }
}

async function refreshItems() {
  const data = await api(`/lists/${currentListId}`);
  if (!data || data.error) return;
  currentItems = data.items;
  currentTags = data.tags || [];
  renderItems();
  renderTagPane();
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

  // Detect indent unit: find smallest leading whitespace among indented lines
  let indentUnit = 0;
  for (const line of lines) {
    const m = line.match(/^(\s+)\S/);
    if (m) {
      const len = m[1].replace(/\t/g, "    ").length;
      if (indentUnit === 0 || len < indentUnit) indentUnit = len;
    }
  }
  if (indentUnit === 0) indentUnit = 4;

  for (const line of lines) {
    if (line.trim() === "") continue;

    // Measure indentation
    const leadingWs = line.match(/^(\s*)/)[1].replace(/\t/g, "    ");
    const depth = Math.round(leadingWs.length / indentUnit);

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
  for (const pi of parsedItems) {
    const result = await api(`/lists/${targetListId}/items`, {
      method: "POST",
      body: { text: pi.text, depth: pi.depth },
    });
    if (result && result.id && pi.done) {
      await api(`/lists/${targetListId}/items/${result.id}`, {
        method: "PATCH",
        body: { done: true },
      });
    }
  }
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
  applySelectionStyles();
}

function getVisibleItemIds() {
  const ids = [];
  for (let i = 0; i < currentItems.length; i++) {
    if (!isHiddenByCollapse(i)) ids.push(currentItems[i].id);
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

// -------------------------------------------------------------------
// Items
// -------------------------------------------------------------------

function renderItems() {
  itemsEl.innerHTML = "";
  foldGutter.innerHTML = "";
  const displayItems = getSortedItems();
  const maxDepth = displayItems.reduce((m, it) => Math.max(m, it.depth), 0);
  updateCollapseBar(maxDepth);
  const filterVis = computeFilterVisibility();

  let visibleRow = 0;
  for (let i = 0; i < displayItems.length; i++) {
    const item = displayItems[i];
    // Map back to currentItems index for filter/collapse checks
    const dataIdx = currentItems.indexOf(item);
    if (isHiddenByCollapse(dataIdx)) continue;
    if (filterVis.size > 0 && filterVis.get(dataIdx) === "hidden") continue;
    const isFilterAncestor = filterVis.get(dataIdx) === "ancestor";

    const isParent = hasChildren(dataIdx);
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
    li.className = "item" + (item.done ? " done" : "") + (isFilterAncestor ? " filter-ancestor" : "");
    li.dataset.id = item.id;
    li.dataset.depth = item.depth;
    li.dataset.index = dataIdx;

    // drag: mousedown anywhere on the row, but only start drag after threshold
    li.addEventListener("mousedown", (e) => {
      if (e.target.type === "checkbox") return;
      if (e.shiftKey) e.preventDefault();
      onItemMouseDown(e, item.id);
    });

    // checkbox
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.addEventListener("click", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        toggleDoneHierarchy(i);
      } else if (selectedIds.size > 1 && selectedIds.has(item.id)) {
        e.preventDefault();
        toggleDoneSelected();
      } else {
        toggleDone(item);
      }
    });

    // text input
    const txt = document.createElement("input");
    txt.type = "text";
    txt.className = "item-text";
    txt.value = item.text;
    txt.draggable = false;
    let deleted = false;
    let skipBlur = false;
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
        // Save pending edit without re-render, then navigate
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
        const allTexts = Array.from(itemsEl.querySelectorAll(".item-text"));
        const focused = document.activeElement;
        const idx = allTexts.indexOf(focused);
        const target = allTexts[idx + (e.key === "ArrowUp" ? -1 : 1)];
        if (target) target.focus();
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

    // tag bubbles (ordered by global tag order, not item assignment order)
    const tagsContainer = document.createElement("span");
    tagsContainer.className = "item-tags";
    for (const tagDef of currentTags) {
      if (!itemHasTag(item, tagDef.id)) continue;
      if (hiddenTagIds.has(tagDef.id)) continue;
      const tagId = tagDef.id;
      const tagVal = itemTagValue(item, tagId);
      const bubble = document.createElement("span");
      bubble.className = "tag-bubble";
      bubble.textContent = tagVal != null ? `${tagDef.name}: ${tagVal}` : tagDef.name;
      bubble.style.background = tagDef.color;
      bubble.title = "Click: remove / Ctrl: hierarchy / Dbl-click: set value";
      let clickTimer = null;
      let editing = false;
      bubble.addEventListener("click", (e) => {
        e.stopPropagation();
        if (editing) return;
        if (e.ctrlKey) {
          removeTagFromHierarchy(i, tagId);
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
        // Replace bubble content with inline input
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
            picker.type = "datetime-local";
            picker.className = "tag-date-picker";
            const bubbleRect = bubble.getBoundingClientRect();
            picker.style.position = "fixed";
            picker.style.left = bubbleRect.left + "px";
            picker.style.top = (bubbleRect.bottom + 2) + "px";
            picker.style.zIndex = "2000";
            // Pre-fill with current value if it's an ISO date
            if (current) {
              try { picker.value = new Date(current).toISOString().slice(0, 16); } catch (e) {}
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
                inp.value = new Date(picker.value).toISOString().replace(/\.\d{3}Z$/, "Z");
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

    const leftGroup = document.createElement("div");
    leftGroup.className = "item-left";
    leftGroup.append(cb, txt);
    li.append(leftGroup, tagsContainer, badge, btnOut, btnIn, btnDel);
    itemsEl.appendChild(li);
  }
  applySelectionStyles();
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

async function addItemAfter(afterId, depth) {
  const body = { text: "", depth };
  if (afterId) body.after_id = afterId;
  const result = await api(`/lists/${currentListId}/items`, {
    method: "POST",
    body,
  });
  await refreshItems();
  if (result && result.id) {
    const newEl = itemsEl.querySelector(`.item[data-id="${result.id}"] .item-text`);
    if (newEl) {
      newEl.value = "";
      newEl.focus();
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
function scheduleSyncFromServer() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const data = await api(`/lists/${currentListId}`);
    if (data && !data.error) {
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


// -------------------------------------------------------------------
// Search / Filtering
// -------------------------------------------------------------------

function hasActiveFilters() {
  return textFilters.length > 0 || tagFilters.size > 0;
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
  for (const f of textFilters) {
    if (!f.regex.test(item.text)) return false;
  }
  for (const [tagId, condition] of tagFilters) {
    if (!itemHasTag(item, tagId)) return false;
    if (condition && !matchesCondition(itemTagValue(item, tagId), condition)) return false;
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
    });
    filterBar.appendChild(bubble);
  }

  for (const [tagId, condition] of tagFilters) {
    const tagDef = currentTags.find((t) => t.id === tagId);
    if (!tagDef) continue;
    const bubble = document.createElement("span");
    bubble.className = "filter-bubble filter-bubble-tag";
    bubble.style.background = tagDef.color;
    const label = condition ? `${tagDef.name} ${condition}` : tagDef.name;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    const xSpan = document.createElement("span");
    xSpan.className = "filter-x";
    xSpan.textContent = "\u00d7";
    bubble.append(labelSpan, xSpan);
    bubble.title = "Click: remove / Double-click: set condition";
    let clickTimer = null;
    bubble.addEventListener("click", () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        tagFilters.delete(tagId);
        renderFilterBar();
        renderItems();
        renderTagPane();
      }, 250);
    });
    bubble.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      // Replace bubble content with inline input
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
        tagFilters.set(tagId, val);
        renderFilterBar();
        renderItems();
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

function toggleTagFilter(tagId) {
  if (tagFilters.has(tagId)) {
    tagFilters.delete(tagId);
  } else {
    tagFilters.set(tagId, null);
  }
  renderFilterBar();
  renderItems();
  renderTagPane();
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

    // Tag name
    const name = document.createElement("span");
    name.className = "tag-name";
    name.textContent = tag.name;

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
    filterBtn.className = "tag-filter-btn" + (tagFilters.has(tag.id) ? " active" : "");
    filterBtn.textContent = "\u25e2";
    filterBtn.title = tagFilters.has(tag.id) ? "Remove filter" : "Filter by this tag";
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

btnNewTag.addEventListener("click", async () => {
  const name = prompt("Tag name:");
  if (!name) return;
  const tag = await api(`/lists/${currentListId}/tags`, {
    method: "POST",
    body: { name },
  });
  if (tag && !tag.error) {
    currentTags.push(tag);
    renderTagPane();
  }
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
// Undo / Redo
// -------------------------------------------------------------------

async function performUndo() {
  if (!currentListId) return;
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

function onItemMouseDown(e, itemId) {
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

  // Mark all block items as drag-source
  for (const id of blockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.add("drag-source");
  }

  // Re-render to show consolidated positions
  if (useFullReorder) renderItems();

  dragState = {
    itemId,
    ghost,
    blockIds,
    blockSize,
    useFullReorder,
    offsetY: startY - rect.top,
    itemHeight: 26,
    itemsRect,
    currentVisibleIdx: getVisibleIndex(itemId),
    sourceListId: currentListId,
    crossListTarget: null,
    hoverListId: null,
    hoverTimer: null,
    switchedList: false,
    draggedItems: null,
  };

  // Re-mark after potential re-render
  for (const id of blockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.add("drag-source");
  }
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
  ghost.style.left = (e.clientX + 10) + "px";
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
  const relY = e.clientY - itemsRect.top;
  const visibleCount = itemsEl.querySelectorAll(".item").length;
  let targetRow = Math.round(relY / itemHeight);
  targetRow = Math.max(0, Math.min(targetRow, visibleCount));

  if (targetRow === dragState.currentVisibleIdx) return;

  const srcDataIdx = currentItems.findIndex((it) => it.id === itemId);
  const destDataIdx = getDataIndexOfVisibleRow(targetRow);
  if (srcDataIdx === -1 || srcDataIdx === destDataIdx) return;

  const block = currentItems.splice(srcDataIdx, blockSize);
  const insertIdx = destDataIdx > srcDataIdx ? destDataIdx - blockSize : destDataIdx;
  currentItems.splice(Math.max(0, insertIdx), 0, ...block);

  dragState.currentVisibleIdx = targetRow;
  renderItems();

  for (const id of blockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.add("drag-source");
  }
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

  // Re-mark dragged items
  for (const id of blockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.add("drag-source");
  }
}

function onDragEnd() {
  if (!dragState) return;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);

  const { itemId, blockIds, blockSize, useFullReorder, ghost, sourceListId, crossListTarget, switchedList } = dragState;
  ghost.remove();
  clearSidebarHighlight();
  if (dragState.hoverTimer) clearTimeout(dragState.hoverTimer);

  // Remove drag-source styling
  for (const id of blockIds) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
    if (el) el.classList.remove("drag-source");
  }

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
// Auth
// -------------------------------------------------------------------

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  window.location.href = "/";
});

async function loadCurrentUser() {
  const data = await api("/me");
  if (data && !data.error) {
    document.getElementById("user-display").textContent = data.display_name || data.username;
  }
}

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------

loadCurrentUser();
loadLists();
