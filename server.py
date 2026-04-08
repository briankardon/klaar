"""Klaar - a collaborative todo list server."""

import copy
import json
import os
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="static")

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)

UNDO_LIMIT = 50
# Per-list undo/redo stacks (in memory, lost on server restart)
_undo_stacks: dict[str, list] = defaultdict(list)
_redo_stacks: dict[str, list] = defaultdict(list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _list_path(list_id: str) -> Path:
    return DATA_DIR / f"{list_id}.json"


def _load_list(list_id: str) -> dict | None:
    path = _list_path(list_id)
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    _ensure_tags(data)
    return data


def _snapshot(data: dict) -> dict:
    """Capture the undoable state (items + tags) of a list."""
    return {
        "items": copy.deepcopy(data["items"]),
        "tags": copy.deepcopy(data["tags"]),
    }


def _push_undo(list_id: str, snapshot: dict) -> None:
    stack = _undo_stacks[list_id]
    stack.append(snapshot)
    if len(stack) > UNDO_LIMIT:
        stack.pop(0)
    _redo_stacks[list_id].clear()


def _load_and_snapshot(list_id: str) -> tuple[dict, dict] | tuple[None, None]:
    """Load a list and take a snapshot for undo. Returns (data, snapshot)."""
    data = _load_list(list_id)
    if data is None:
        return None, None
    return data, _snapshot(data)


def _save_with_undo(data: dict, snapshot: dict) -> None:
    """Push an undo snapshot and save the list."""
    _push_undo(data["id"], snapshot)
    _save_list(data)


def _save_list(data: dict, *, undoable: bool = True) -> None:
    path = _list_path(data["id"])
    # Atomic write: write to temp file, then rename to avoid corruption
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def _new_item(text: str, depth: int = 0) -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "text": text,
        "done": False,
        "depth": depth,
        "created": _now(),
        "completed": None,
        "tags": [],
    }


def _find_item(items: list[dict], item_id: str) -> dict | None:
    for item in items:
        if item["id"] == item_id:
            return item
    return None


TAG_COLORS = [
    "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
    "#3498db", "#9b59b6", "#e84393", "#6c5ce7", "#00b894",
]


def _ensure_tags(data: dict) -> None:
    """Ensure list has a tags array and migrate old tag formats."""
    if "tags" not in data:
        data["tags"] = []
    # Migrate item tags from string IDs to {id, value} objects
    for item in data.get("items", []):
        item["tags"] = [
            t if isinstance(t, dict) else {"id": t, "value": None}
            for t in item.get("tags", [])
        ]


def _next_tag_color(data: dict) -> str:
    used = {t["color"] for t in data["tags"]}
    for c in TAG_COLORS:
        if c not in used:
            return c
    return TAG_COLORS[len(data["tags"]) % len(TAG_COLORS)]


def _apply_item_fields(item: dict, fields: dict) -> None:
    if "text" in fields:
        item["text"] = fields["text"]
    if "done" in fields:
        was_done = item["done"]
        item["done"] = bool(fields["done"])
        if item["done"] and not was_done:
            item["completed"] = _now()
        elif not item["done"] and was_done:
            item["completed"] = None
    if "depth" in fields:
        item["depth"] = max(0, int(fields["depth"]))
    if "tags" in fields:
        item["tags"] = fields["tags"]


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ---------------------------------------------------------------------------
# List endpoints
# ---------------------------------------------------------------------------

@app.get("/api/lists")
def get_lists():
    """Return metadata for every todo list."""
    lists = []
    for path in sorted(DATA_DIR.glob("*.json")):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        lists.append({"id": data["id"], "name": data["name"], "created": data["created"]})
    return jsonify(lists)


@app.post("/api/lists")
def create_list():
    """Create a new todo list."""
    body = request.get_json(force=True)
    name = body.get("name", "Untitled").strip() or "Untitled"
    data = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "created": _now(),
        "tags": [],
        "items": [],
    }
    _save_list(data)
    return jsonify(data), 201


@app.get("/api/lists/<list_id>")
def get_list(list_id: str):
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(data)


@app.patch("/api/lists/<list_id>")
def update_list(list_id: str):
    """Rename a list."""
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(force=True)
    if "name" in body:
        data["name"] = body["name"].strip() or data["name"]
    _save_list(data)
    return jsonify(data)


@app.delete("/api/lists/<list_id>")
def delete_list(list_id: str):
    path = _list_path(list_id)
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    path.unlink()
    return "", 204


# ---------------------------------------------------------------------------
# Item endpoints
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/items")
def add_item(list_id: str):
    """Add a new item. Optional: after_id, depth."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    body = request.get_json(force=True)
    text = body.get("text", "").strip()
    depth = max(0, int(body.get("depth", 0)))
    item = _new_item(text, depth)
    after_id = body.get("after_id")
    if after_id:
        idx = next((i for i, it in enumerate(data["items"]) if it["id"] == after_id), None)
        if idx is not None:
            data["items"].insert(idx + 1, item)
        else:
            data["items"].append(item)
    else:
        data["items"].append(item)
    _save_with_undo(data, snap)
    return jsonify(item), 201


@app.patch("/api/lists/<list_id>/items/<item_id>")
def update_item(list_id: str, item_id: str):
    """Update text, done, depth, or tags of an item."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    item = _find_item(data["items"], item_id)
    if item is None:
        return jsonify({"error": "item not found"}), 404
    body = request.get_json(force=True)
    _apply_item_fields(item, body)
    _save_with_undo(data, snap)
    return jsonify(item)


@app.patch("/api/lists/<list_id>/items")
def bulk_update_items(list_id: str):
    """Update multiple items at once. Body: {updates: [{id, ...fields}]}."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    body = request.get_json(force=True)
    updates = body.get("updates", [])
    for upd in updates:
        item = _find_item(data["items"], upd["id"])
        if item:
            _apply_item_fields(item, upd)
    _save_with_undo(data, snap)
    return jsonify(data)


@app.delete("/api/lists/<list_id>/items/<item_id>")
def delete_item(list_id: str, item_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    before = len(data["items"])
    data["items"] = [it for it in data["items"] if it["id"] != item_id]
    if len(data["items"]) == before:
        return jsonify({"error": "item not found"}), 404
    _save_with_undo(data, snap)
    return "", 204


@app.post("/api/lists/<list_id>/items/reorder")
def reorder_items(list_id: str):
    """Reorder items. Accepts either:
    - {order: [id, ...]} to set the full ordering
    - {item_id, index, count?} to move a contiguous block
    """
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    body = request.get_json(force=True)
    items = data["items"]

    if "order" in body:
        by_id = {it["id"]: it for it in items}
        data["items"] = [by_id[oid] for oid in body["order"] if oid in by_id]
    else:
        item_id = body.get("item_id")
        target_index = body.get("index")
        count = max(1, int(body.get("count", 1)))
        if item_id is None or target_index is None:
            return jsonify({"error": "item_id and index required"}), 400
        src = next((i for i, it in enumerate(items) if it["id"] == item_id), None)
        if src is None:
            return jsonify({"error": "item not found"}), 404
        block = items[src:src + count]
        del items[src:src + count]
        target_index = max(0, min(target_index, len(items)))
        for i, it in enumerate(block):
            items.insert(target_index + i, it)

    _save_with_undo(data, snap)
    return jsonify(data)


# ---------------------------------------------------------------------------
# Tag endpoints
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/tags")
def create_tag(list_id: str):
    """Create a new tag. Body: {name, color?}."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    body = request.get_json(force=True)
    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    tag = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "color": body.get("color") or _next_tag_color(data),
    }
    data["tags"].append(tag)
    _save_with_undo(data, snap)
    return jsonify(tag), 201


@app.patch("/api/lists/<list_id>/tags/<tag_id>")
def update_tag(list_id: str, tag_id: str):
    """Update a tag's name or color."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    tag = next((t for t in data["tags"] if t["id"] == tag_id), None)
    if tag is None:
        return jsonify({"error": "tag not found"}), 404
    body = request.get_json(force=True)
    if "name" in body:
        tag["name"] = body["name"].strip() or tag["name"]
    if "color" in body:
        tag["color"] = body["color"]
    _save_with_undo(data, snap)
    return jsonify(tag)


@app.post("/api/lists/<list_id>/tags/reorder")
def reorder_tags(list_id: str):
    """Reorder tags. Body: {order: [id, ...]}."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    body = request.get_json(force=True)
    order = body.get("order", [])
    by_id = {t["id"]: t for t in data["tags"]}
    data["tags"] = [by_id[tid] for tid in order if tid in by_id]
    _save_with_undo(data, snap)
    return jsonify(data)


@app.delete("/api/lists/<list_id>/tags/<tag_id>")
def delete_tag(list_id: str, tag_id: str):
    """Delete a tag and remove it from all items."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    data["tags"] = [t for t in data["tags"] if t["id"] != tag_id]
    for item in data["items"]:
        item["tags"] = [t for t in item["tags"] if t.get("id") != tag_id]
    _save_with_undo(data, snap)
    return "", 204


# ---------------------------------------------------------------------------
# Undo / Redo
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/undo")
def undo(list_id: str):
    stack = _undo_stacks[list_id]
    if not stack:
        return jsonify({"error": "nothing to undo"}), 400
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    # Push current state onto redo before restoring
    _redo_stacks[list_id].append(_snapshot(data))
    # Restore previous state
    prev = stack.pop()
    data["items"] = prev["items"]
    data["tags"] = prev["tags"]
    _save_list(data)
    return jsonify(data)


@app.post("/api/lists/<list_id>/redo")
def redo(list_id: str):
    stack = _redo_stacks[list_id]
    if not stack:
        return jsonify({"error": "nothing to redo"}), 400
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    # Push current state onto undo before restoring
    _undo_stacks[list_id].append(_snapshot(data))
    # Restore redo state
    nxt = stack.pop()
    data["items"] = nxt["items"]
    data["tags"] = nxt["tags"]
    _save_list(data)
    return jsonify(data)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
