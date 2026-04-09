"""Klaar - a collaborative todo list server."""

import copy
import json
import os
import re
import secrets
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__, static_folder="static")

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
USERS_FILE = DATA_DIR / "users.json"

# Generate or load a persistent secret key
_secret_path = DATA_DIR / ".secret_key"
if _secret_path.exists():
    app.secret_key = _secret_path.read_bytes()
else:
    app.secret_key = secrets.token_bytes(32)
    _secret_path.write_bytes(app.secret_key)

UNDO_LIMIT = 50
_undo_stacks: dict[str, list] = defaultdict(list)
_redo_stacks: dict[str, list] = defaultdict(list)

# Valid ID pattern — hex strings only, prevents path traversal
_SAFE_ID = re.compile(r"^[a-f0-9]{1,24}$")


def _valid_id(id_str: str) -> bool:
    return bool(_SAFE_ID.match(id_str))


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

def _load_users() -> list[dict]:
    if not USERS_FILE.exists():
        return []
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_users(users: list[dict]) -> None:
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(users, f, indent=2, ensure_ascii=False)
        os.replace(tmp, USERS_FILE)
    except BaseException:
        os.unlink(tmp)
        raise


def _find_user(username: str) -> dict | None:
    for u in _load_users():
        if u["username"] == username:
            return u
    return None


def _find_user_by_id(user_id: str) -> dict | None:
    for u in _load_users():
        if u["id"] == user_id:
            return u
    return None


def _current_user() -> dict | None:
    uid = session.get("user_id")
    if not uid:
        return None
    return _find_user_by_id(uid)


def _require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = _current_user()
        if not user:
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


def _has_setup_completed() -> bool:
    return USERS_FILE.exists() and len(_load_users()) > 0


# ---------------------------------------------------------------------------
# List helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _list_path(list_id: str) -> Path:
    return DATA_DIR / f"{list_id}.json"


def _load_list(list_id: str) -> dict | None:
    if not _valid_id(list_id):
        return None
    path = _list_path(list_id)
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    _ensure_tags(data)
    _ensure_owner(data)
    return data


def _snapshot(data: dict) -> dict:
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
    data = _load_list(list_id)
    if data is None:
        return None, None
    return data, _snapshot(data)


def _save_with_undo(data: dict, snapshot: dict) -> None:
    _push_undo(data["id"], snapshot)
    _save_list(data)


def _save_list(data: dict) -> None:
    path = _list_path(data["id"])
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
    if "tags" not in data:
        data["tags"] = []
    for item in data.get("items", []):
        item["tags"] = [
            t if isinstance(t, dict) else {"id": t, "value": None}
            for t in item.get("tags", [])
        ]


def _ensure_owner(data: dict) -> None:
    """Ensure list has owner and shared_with fields (migration)."""
    if "owner" not in data:
        data["owner"] = None
    if "shared_with" not in data:
        data["shared_with"] = []


def _next_tag_color(data: dict) -> str:
    used = {t["color"] for t in data["tags"]}
    for c in TAG_COLORS:
        if c not in used:
            return c
    return TAG_COLORS[len(data["tags"]) % len(TAG_COLORS)]


def _apply_item_fields(item: dict, fields: dict) -> None:
    if "text" in fields:
        item["text"] = str(fields["text"])[:1000]
    if "done" in fields:
        was_done = item["done"]
        item["done"] = bool(fields["done"])
        if item["done"] and not was_done:
            item["completed"] = _now()
        elif not item["done"] and was_done:
            item["completed"] = None
    if "depth" in fields:
        item["depth"] = max(0, min(20, int(fields["depth"])))
    if "tags" in fields:
        item["tags"] = fields["tags"]


def _can_access(data: dict, user: dict) -> bool:
    """Check if user can read this list."""
    if data["owner"] is None:
        return True  # legacy unowned lists
    if data["owner"] == user["id"]:
        return True
    if user.get("admin"):
        return True
    for s in data.get("shared_with", []):
        if s["user_id"] == user["id"]:
            return True
    return False


def _can_write(data: dict, user: dict) -> bool:
    """Check if user can modify this list."""
    if data["owner"] is None:
        return True
    if data["owner"] == user["id"]:
        return True
    if user.get("admin"):
        return True
    for s in data.get("shared_with", []):
        if s["user_id"] == user["id"] and s.get("permission") == "write":
            return True
    return False


# ---------------------------------------------------------------------------
# Auth pages & endpoints
# ---------------------------------------------------------------------------

@app.route("/.well-known/acme-challenge/<path:filename>")
def acme_challenge(filename):
    """Let's Encrypt challenge passthrough for NFSN."""
    return send_from_directory("/home/public/.well-known/acme-challenge", filename)


@app.route("/")
def index():
    if not _has_setup_completed():
        return send_from_directory("static", "setup.html")
    if not _current_user():
        return send_from_directory("static", "login.html")
    return send_from_directory("static", "index.html")


@app.post("/api/setup")
def setup():
    """Create the first (admin) user."""
    if _has_setup_completed():
        return jsonify({"error": "already set up"}), 400
    body = request.get_json(force=True)
    username = body.get("username", "").strip()
    password = body.get("password", "")
    display = body.get("display_name", "").strip() or username
    if not username or not password:
        return jsonify({"error": "username and password required"}), 400
    if len(password) < 6:
        return jsonify({"error": "password must be at least 6 characters"}), 400
    user = {
        "id": uuid.uuid4().hex[:12],
        "username": username,
        "password_hash": generate_password_hash(password),
        "display_name": display,
        "admin": True,
        "created": _now(),
    }
    _save_users([user])
    # Claim any existing unowned lists
    for path in DATA_DIR.glob("*.json"):
        if path.name == "users.json":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("owner") is None:
                data["owner"] = user["id"]
                _save_list(data)
        except (json.JSONDecodeError, KeyError):
            pass
    session["user_id"] = user["id"]
    return jsonify({"ok": True}), 201


@app.get("/api/registration-status")
def registration_status():
    open_file = DATA_DIR / ".registration_open"
    return jsonify({"open": open_file.exists()})


@app.post("/api/register")
def register():
    open_file = DATA_DIR / ".registration_open"
    if not open_file.exists():
        return jsonify({"error": "registration is closed"}), 403
    body = request.get_json(force=True)
    username = body.get("username", "").strip()
    password = body.get("password", "")
    display = body.get("display_name", "").strip() or username
    if not username or not password:
        return jsonify({"error": "username and password required"}), 400
    if len(password) < 6:
        return jsonify({"error": "password must be at least 6 characters"}), 400
    if _find_user(username):
        return jsonify({"error": "username already exists"}), 400
    users = _load_users()
    new_user = {
        "id": uuid.uuid4().hex[:12],
        "username": username,
        "password_hash": generate_password_hash(password),
        "display_name": display,
        "admin": False,
        "created": _now(),
    }
    users.append(new_user)
    _save_users(users)
    session["user_id"] = new_user["id"]
    return jsonify({"ok": True}), 201


@app.post("/api/login")
def login():
    body = request.get_json(force=True)
    username = body.get("username", "")
    password = body.get("password", "")
    user = _find_user(username)
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "invalid credentials"}), 401
    session["user_id"] = user["id"]
    return jsonify({"ok": True, "user": {"id": user["id"], "username": user["username"], "display_name": user["display_name"]}})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
@_require_auth
def me():
    user = _current_user()
    return jsonify({
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "admin": user.get("admin", False),
    })


@app.get("/api/users")
@_require_auth
def list_users():
    """List all users (admin only)."""
    user = _current_user()
    if not user.get("admin"):
        return jsonify({"error": "admin required"}), 403
    users = _load_users()
    return jsonify([{
        "id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "admin": u.get("admin", False),
    } for u in users])


@app.post("/api/users")
@_require_auth
def create_user():
    """Create a new user (admin only)."""
    user = _current_user()
    if not user.get("admin"):
        return jsonify({"error": "admin required"}), 403
    body = request.get_json(force=True)
    username = body.get("username", "").strip()
    password = body.get("password", "")
    display = body.get("display_name", "").strip() or username
    if not username or not password:
        return jsonify({"error": "username and password required"}), 400
    if len(password) < 6:
        return jsonify({"error": "password must be at least 6 characters"}), 400
    if _find_user(username):
        return jsonify({"error": "username already exists"}), 400
    users = _load_users()
    new_user = {
        "id": uuid.uuid4().hex[:12],
        "username": username,
        "password_hash": generate_password_hash(password),
        "display_name": display,
        "admin": bool(body.get("admin", False)),
        "created": _now(),
    }
    users.append(new_user)
    _save_users(users)
    return jsonify({"id": new_user["id"], "username": username, "display_name": display}), 201


# ---------------------------------------------------------------------------
# List endpoints
# ---------------------------------------------------------------------------

@app.get("/api/lists")
@_require_auth
def get_lists():
    user = _current_user()
    lists = []
    for path in sorted(DATA_DIR.glob("*.json")):
        if path.name == "users.json":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            _ensure_owner(data)
            if not _can_access(data, user):
                continue
            lists.append({
                "id": data["id"],
                "name": data["name"],
                "created": data["created"],
                "owner": data.get("owner"),
                "shared": len(data.get("shared_with", [])) > 0,
            })
        except (json.JSONDecodeError, KeyError):
            continue
    return jsonify(lists)


@app.post("/api/lists")
@_require_auth
def create_list():
    user = _current_user()
    body = request.get_json(force=True)
    name = str(body.get("name", "Untitled")).strip()[:200] or "Untitled"
    data = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "created": _now(),
        "owner": user["id"],
        "shared_with": [],
        "tags": [],
        "items": [],
    }
    _save_list(data)
    return jsonify(data), 201


@app.get("/api/lists/<list_id>")
@_require_auth
def get_list(list_id: str):
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if not _can_access(data, user):
        return jsonify({"error": "not found"}), 404
    return jsonify(data)


@app.patch("/api/lists/<list_id>")
@_require_auth
def update_list(list_id: str):
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    if "name" in body:
        data["name"] = str(body["name"]).strip()[:200] or data["name"]
    if "shared_with" in body and (data["owner"] == user["id"] or user.get("admin")):
        data["shared_with"] = body["shared_with"]
    _save_list(data)
    return jsonify(data)


@app.delete("/api/lists/<list_id>")
@_require_auth
def delete_list(list_id: str):
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if data["owner"] and data["owner"] != user["id"] and not user.get("admin"):
        return jsonify({"error": "forbidden"}), 403
    path = _list_path(list_id)
    path.unlink()
    return "", 204


# ---------------------------------------------------------------------------
# Item endpoints
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/items")
@_require_auth
def add_item(list_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    text = str(body.get("text", "")).strip()[:1000]
    depth = max(0, min(20, int(body.get("depth", 0))))
    item = _new_item(text, depth)
    after_id = body.get("after_id")
    if after_id and _valid_id(after_id):
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
@_require_auth
def update_item(list_id: str, item_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    item = _find_item(data["items"], item_id)
    if item is None:
        return jsonify({"error": "item not found"}), 404
    body = request.get_json(force=True)
    _apply_item_fields(item, body)
    _save_with_undo(data, snap)
    return jsonify(item)


@app.patch("/api/lists/<list_id>/items")
@_require_auth
def bulk_update_items(list_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    updates = body.get("updates", [])
    for upd in updates:
        item = _find_item(data["items"], upd["id"])
        if item:
            _apply_item_fields(item, upd)
    _save_with_undo(data, snap)
    return jsonify(data)


@app.delete("/api/lists/<list_id>/items/<item_id>")
@_require_auth
def delete_item(list_id: str, item_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    before = len(data["items"])
    data["items"] = [it for it in data["items"] if it["id"] != item_id]
    if len(data["items"]) == before:
        return jsonify({"error": "item not found"}), 404
    _save_with_undo(data, snap)
    return "", 204


@app.post("/api/lists/<list_id>/items/move-from")
@_require_auth
def move_items(list_id: str):
    dest, dest_snap = _load_and_snapshot(list_id)
    if dest is None:
        return jsonify({"error": "destination list not found"}), 404
    user = _current_user()
    if not _can_write(dest, user):
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    source_id = body.get("source_list_id")
    item_ids = set(body.get("item_ids", []))
    index = body.get("index", 0)
    src, src_snap = _load_and_snapshot(source_id)
    if src is None:
        return jsonify({"error": "source list not found"}), 404
    if not _can_write(src, user):
        return jsonify({"error": "forbidden"}), 403

    moved = [it for it in src["items"] if it["id"] in item_ids]
    src["items"] = [it for it in src["items"] if it["id"] not in item_ids]

    dest_tag_ids = {t["id"] for t in dest["tags"]}
    for tag in src["tags"]:
        if tag["id"] not in dest_tag_ids:
            dest["tags"].append(tag)

    index = max(0, min(index, len(dest["items"])))
    for i, it in enumerate(moved):
        dest["items"].insert(index + i, it)

    _save_with_undo(src, src_snap)
    _save_with_undo(dest, dest_snap)
    return jsonify(dest)


@app.post("/api/lists/<list_id>/items/reorder")
@_require_auth
def reorder_items(list_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
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
@_require_auth
def create_tag(list_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    name = str(body.get("name", "")).strip()[:100]
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
@_require_auth
def update_tag(list_id: str, tag_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    tag = next((t for t in data["tags"] if t["id"] == tag_id), None)
    if tag is None:
        return jsonify({"error": "tag not found"}), 404
    body = request.get_json(force=True)
    if "name" in body:
        tag["name"] = str(body["name"]).strip()[:100] or tag["name"]
    if "color" in body:
        tag["color"] = body["color"]
    _save_with_undo(data, snap)
    return jsonify(tag)


@app.post("/api/lists/<list_id>/tags/reorder")
@_require_auth
def reorder_tags(list_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    order = body.get("order", [])
    by_id = {t["id"]: t for t in data["tags"]}
    data["tags"] = [by_id[tid] for tid in order if tid in by_id]
    _save_with_undo(data, snap)
    return jsonify(data)


@app.delete("/api/lists/<list_id>/tags/<tag_id>")
@_require_auth
def delete_tag(list_id: str, tag_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    data["tags"] = [t for t in data["tags"] if t["id"] != tag_id]
    for item in data["items"]:
        item["tags"] = [t for t in item["tags"] if t.get("id") != tag_id]
    _save_with_undo(data, snap)
    return "", 204


# ---------------------------------------------------------------------------
# Undo / Redo
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/undo")
@_require_auth
def undo(list_id: str):
    stack = _undo_stacks[list_id]
    if not stack:
        return jsonify({"error": "nothing to undo"}), 400
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    _redo_stacks[list_id].append(_snapshot(data))
    prev = stack.pop()
    data["items"] = prev["items"]
    data["tags"] = prev["tags"]
    _save_list(data)
    return jsonify(data)


@app.post("/api/lists/<list_id>/redo")
@_require_auth
def redo(list_id: str):
    stack = _redo_stacks[list_id]
    if not stack:
        return jsonify({"error": "nothing to redo"}), 400
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    _undo_stacks[list_id].append(_snapshot(data))
    nxt = stack.pop()
    data["items"] = nxt["items"]
    data["tags"] = nxt["tags"]
    _save_list(data)
    return jsonify(data)


# ---------------------------------------------------------------------------
# Debug / testing
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/items/bulk-add")
@_require_auth
def bulk_add_items(list_id: str):
    """Add multiple items at once. Body: {items: [{text, depth?, done?}]}."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    new_items = body.get("items", [])
    for ni in new_items:
        text = str(ni.get("text", "")).strip()[:1000]
        depth = max(0, min(20, int(ni.get("depth", 0))))
        item = _new_item(text, depth)
        if ni.get("done"):
            item["done"] = True
            item["completed"] = _now()
        data["items"].append(item)
    _save_with_undo(data, snap)
    return jsonify(data), 201


@app.post("/api/lists/generate-test")
@_require_auth
def generate_test_list():
    """Generate a test list with N items. Body: {count, name?}."""
    user = _current_user()
    body = request.get_json(force=True)
    count = min(int(body.get("count", 100)), 50000)
    name = body.get("name", f"Test ({count} items)")
    data = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "created": _now(),
        "owner": user["id"],
        "shared_with": [],
        "tags": [],
        "items": [],
    }
    for i in range(count):
        data["items"].append(_new_item(f"Item {i+1}", depth=i % 3))
    _save_list(data)
    return jsonify({"id": data["id"], "name": name, "count": count}), 201


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
