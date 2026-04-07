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

let currentListId = null;

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
  const data = await api(`/lists/${id}`);
  if (!data || data.error) {
    currentListId = null;
    listView.classList.add("hidden");
    emptyState.classList.remove("hidden");
    await loadLists();
    return;
  }
  listTitle.textContent = data.name;
  emptyState.classList.add("hidden");
  listView.classList.remove("hidden");
  renderItems(data.items);
  // update active state in sidebar
  listIndex.querySelectorAll("li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === id);
  });
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

// Rename on blur
listTitle.addEventListener("blur", async () => {
  if (!currentListId) return;
  const name = listTitle.textContent.trim();
  if (name) {
    await api(`/lists/${currentListId}`, { method: "PATCH", body: { name } });
    await loadLists();
  }
});

listTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    listTitle.blur();
  }
});

// -------------------------------------------------------------------
// Items
// -------------------------------------------------------------------

function renderItems(items) {
  itemsEl.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "item" + (item.done ? " done" : "");
    li.dataset.id = item.id;
    li.dataset.depth = item.depth;

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
    txt.addEventListener("blur", () => {
      if (txt.value.trim() !== item.text) {
        updateItem(item.id, { text: txt.value.trim() });
      }
    });
    txt.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); txt.blur(); }
      // Tab to indent, Shift+Tab to outdent
      if (e.key === "Tab") {
        e.preventDefault();
        const newDepth = item.depth + (e.shiftKey ? -1 : 1);
        updateItem(item.id, { depth: Math.max(0, newDepth) });
      }
    });

    // indent button
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

    li.append(cb, txt, btnOut, btnIn, btnDel);
    itemsEl.appendChild(li);
  }
}

async function toggleDone(item) {
  await updateItem(item.id, { done: !item.done });
}

async function updateItem(itemId, fields) {
  await api(`/lists/${currentListId}/items/${itemId}`, {
    method: "PATCH",
    body: fields,
  });
  await selectList(currentListId);
}

async function deleteItem(itemId) {
  await api(`/lists/${currentListId}/items/${itemId}`, { method: "DELETE" });
  await selectList(currentListId);
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = newItemText.value.trim();
  if (!text) return;
  await api(`/lists/${currentListId}/items`, { method: "POST", body: { text } });
  newItemText.value = "";
  await selectList(currentListId);
});

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------

loadLists();
