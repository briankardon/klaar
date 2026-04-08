"""Klaar - a collaborative todo list server."""

import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="static")

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)


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
        return json.load(f)


def _save_list(data: dict) -> None:
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
    data = _load_list(list_id)
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
    _save_list(data)
    return jsonify(item), 201


@app.patch("/api/lists/<list_id>/items/<item_id>")
def update_item(list_id: str, item_id: str):
    """Update text, done, depth, or tags of an item."""
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    item = _find_item(data["items"], item_id)
    if item is None:
        return jsonify({"error": "item not found"}), 404
    body = request.get_json(force=True)
    _apply_item_fields(item, body)
    _save_list(data)
    return jsonify(item)


@app.patch("/api/lists/<list_id>/items")
def bulk_update_items(list_id: str):
    """Update multiple items at once. Body: {updates: [{id, ...fields}]}."""
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    body = request.get_json(force=True)
    updates = body.get("updates", [])
    for upd in updates:
        item = _find_item(data["items"], upd["id"])
        if item:
            _apply_item_fields(item, upd)
    _save_list(data)
    return jsonify(data)


@app.delete("/api/lists/<list_id>/items/<item_id>")
def delete_item(list_id: str, item_id: str):
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    before = len(data["items"])
    data["items"] = [it for it in data["items"] if it["id"] != item_id]
    if len(data["items"]) == before:
        return jsonify({"error": "item not found"}), 404
    _save_list(data)
    return "", 204


@app.post("/api/lists/<list_id>/items/reorder")
def reorder_items(list_id: str):
    """Reorder items. Accepts either:
    - {order: [id, ...]} to set the full ordering
    - {item_id, index, count?} to move a contiguous block
    """
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    body = request.get_json(force=True)
    items = data["items"]

    if "order" in body:
        # Full reorder: rearrange items to match the given ID order
        by_id = {it["id"]: it for it in items}
        data["items"] = [by_id[oid] for oid in body["order"] if oid in by_id]
    else:
        # Single block move
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

    _save_list(data)
    return jsonify(data)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
