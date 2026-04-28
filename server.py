"""Klaar - a collaborative todo list server."""

import copy
import json
import os
import re
import secrets
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
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

app.permanent_session_lifetime = timedelta(days=90)

UNDO_LIMIT = 50
MIN_PASSWORD_LENGTH = 6
MAX_DEPTH = 20
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
    _migrate_list_fields(data)
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
    data["version"] = data.get("version", 0) + 1
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


def _migrate_list_fields(data: dict) -> None:
    """Backfill any list-data fields added in later versions onto on-disk
    lists that predate them. Called from every code path that loads a list.
    Add a new block here whenever a feature introduces a new list field."""
    if "owner" not in data:
        data["owner"] = None
    if "shared_with" not in data:
        data["shared_with"] = []
    if "views" not in data:
        data["views"] = []
    if "api_token" not in data:
        data["api_token"] = None
        data["api_token_created_at"] = None
        data["api_token_last_used_at"] = None


def _ensure_contacts(user: dict) -> None:
    """Ensure user has contacts and contact request fields (migration)."""
    if "contacts" not in user:
        user["contacts"] = []
    if "contact_requests_in" not in user:
        user["contact_requests_in"] = []
    if "contact_requests_out" not in user:
        user["contact_requests_out"] = []


def _load_contact_pair(user: dict):
    """Load users list and resolve me + target for contact request operations.
    Returns (users, me, target, error_response)."""
    body = request.get_json(force=True)
    target_id = body.get("user_id", "")
    users = _load_users()
    me = next((u for u in users if u["id"] == user["id"]), None)
    target = next((u for u in users if u["id"] == target_id), None)
    if target is None:
        return None, None, None, (jsonify({"error": "user not found"}), 404)
    _ensure_contacts(me)
    _ensure_contacts(target)
    return users, me, target, None


def _delete_user_data(uid: str, users: list) -> None:
    """Delete a user's owned lists and clean up contact references."""
    for path in list(DATA_DIR.glob("*.json")):
        if path.name == "users.json":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("owner") == uid:
                path.unlink()
        except (json.JSONDecodeError, KeyError):
            pass
    for other in users:
        if other["id"] == uid:
            continue
        _ensure_contacts(other)
        other["contacts"] = [c for c in other["contacts"] if c != uid]
        other["contact_requests_in"] = [c for c in other["contact_requests_in"] if c != uid]
        other["contact_requests_out"] = [c for c in other["contact_requests_out"] if c != uid]


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
        item["depth"] = max(0, min(MAX_DEPTH, int(fields["depth"])))
    if "tags" in fields:
        item["tags"] = fields["tags"]


def _can_access(data: dict, user: dict) -> bool:
    """Check if user can read this list."""
    if data["owner"] is None:
        return True  # legacy unowned lists
    if data["owner"] == user["id"]:
        return True
    for s in data.get("shared_with", []):
        if s["user_id"] == user["id"]:
            return True
    return False


_PERM_MIGRATE = {"read": "view", "write": "edit"}

def _get_permission(data: dict, user: dict) -> str:
    """Return the user's permission level: 'edit', 'check', 'view', or 'none'."""
    if data["owner"] is None:
        return "edit"
    if data["owner"] == user["id"]:
        return "edit"
    for s in data.get("shared_with", []):
        if s["user_id"] == user["id"]:
            p = s.get("permission", "view")
            return _PERM_MIGRATE.get(p, p)
    return "none"


def _can_write(data: dict, user: dict) -> bool:
    """Check if user can fully modify this list."""
    return _get_permission(data, user) == "edit"


# ---------------------------------------------------------------------------
# List-scoped API token auth
# ---------------------------------------------------------------------------

def _bearer_token() -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip() or None
    tok = request.args.get("token", "").strip()
    return tok or None


def _check_list_token(data: dict) -> bool:
    """If the request carries a valid list API token for this list, mark it
    used (in-memory; caller persists) and return True."""
    expected = data.get("api_token")
    if not expected:
        return False
    presented = _bearer_token()
    if not presented:
        return False
    if not secrets.compare_digest(expected, presented):
        return False
    data["api_token_last_used_at"] = _now()
    return True


def _authorize_list_write(list_id: str):
    """Authorize a write operation on a list. Accepts session+edit permission
    or a matching list API token. Returns (data, snapshot, error_response)."""
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return None, None, (jsonify({"error": "list not found"}), 404)
    if _check_list_token(data):
        return data, snap, None
    user = _current_user()
    if not user:
        return None, None, (jsonify({"error": "unauthorized"}), 401)
    if not _can_write(data, user):
        return None, None, (jsonify({"error": "forbidden"}), 403)
    return data, snap, None


def _list_for_response(data: dict) -> dict:
    """Strip the api_token (and timestamps) before returning list data to a
    client — the token is fetched via its own owner-only endpoint."""
    out = dict(data)
    out.pop("api_token", None)
    out.pop("api_token_created_at", None)
    out.pop("api_token_last_used_at", None)
    return out


def _verbose_response() -> bool:
    """True if the caller wants the full list back from a bulk-mutation
    endpoint. Default is a compact ack to keep responses small for AI /
    scripted consumers (the web UI ignores these responses and re-syncs
    via a separate GET, so the trim is free)."""
    return request.args.get("verbose") == "1"


def _authorize_list_read(list_id: str):
    """Authorize a read operation on a list. Accepts session+access or a
    matching list API token. Returns (data, error_response).

    Note: token "last_used" is only persisted on writes — a read-only
    endpoint will not bump it, both to avoid a disk write per poll and
    because "last write" is the more useful staleness signal."""
    data = _load_list(list_id)
    if data is None:
        return None, (jsonify({"error": "not found"}), 404)
    expected = data.get("api_token")
    presented = _bearer_token()
    if expected and presented and secrets.compare_digest(expected, presented):
        return data, None
    user = _current_user()
    if not user:
        return None, (jsonify({"error": "unauthorized"}), 401)
    if not _can_access(data, user):
        return None, (jsonify({"error": "not found"}), 404)
    return data, None


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


@app.route("/user")
def user_page():
    if not _current_user():
        return send_from_directory("static", "login.html")
    return send_from_directory("static", "user.html")


@app.route("/help")
def help_page():
    return send_from_directory("static", "help.html")


@app.route("/api/docs")
def api_docs():
    """Serve the public API reference as plain markdown.

    Public (no auth) — it's reference material, not data. Intended audience
    is anyone holding a list API token (typically an AI assistant) who needs
    to learn the endpoint shapes without reading the source."""
    path = Path(app.static_folder) / "api-docs.md"
    body = path.read_text(encoding="utf-8")
    return body, 200, {"Content-Type": "text/markdown; charset=utf-8"}


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
    if len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"password must be at least {MIN_PASSWORD_LENGTH} characters"}), 400
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
    session.permanent = True
    session["user_id"] = user["id"]
    return jsonify({"ok": True}), 201


def _registration_is_open(invite_token: str | None) -> bool:
    # Globally open if .registration_open (no suffix) exists
    if (DATA_DIR / ".registration_open").exists():
        return True
    # Otherwise look for .registration_open_<token> matching the supplied invite
    if not invite_token:
        return False
    # Only allow tokens that look plausible to avoid filesystem trickery
    if not re.match(r"^[A-Za-z0-9_-]{4,64}$", invite_token):
        return False
    return (DATA_DIR / f".registration_open_{invite_token}").exists()


@app.get("/api/registration-status")
def registration_status():
    invite = request.args.get("invite")
    return jsonify({"open": _registration_is_open(invite)})


@app.post("/api/register")
def register():
    body = request.get_json(force=True)
    invite = body.get("invite_token")
    if not _registration_is_open(invite):
        return jsonify({"error": "registration is closed"}), 403
    username = body.get("username", "").strip()
    password = body.get("password", "")
    display = body.get("display_name", "").strip() or username
    if not username or not password:
        return jsonify({"error": "username and password required"}), 400
    if len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"password must be at least {MIN_PASSWORD_LENGTH} characters"}), 400
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
    session.permanent = True
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
    session.permanent = True
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
    _ensure_contacts(user)
    return jsonify({
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "admin": user.get("admin", False),
        "pending_contacts": len(user["contact_requests_in"]),
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


@app.patch("/api/me")
@_require_auth
def update_me():
    """Update own profile: display_name and/or password."""
    user = _current_user()
    body = request.get_json(force=True)
    users = _load_users()
    u = next((u for u in users if u["id"] == user["id"]), None)
    if u is None:
        return jsonify({"error": "user not found"}), 404

    if "display_name" in body:
        dn = str(body["display_name"]).strip()[:200]
        if dn:
            u["display_name"] = dn

    if "new_password" in body:
        current_pw = body.get("current_password", "")
        if not check_password_hash(u["password_hash"], current_pw):
            return jsonify({"error": "current password is incorrect"}), 403
        new_pw = body["new_password"]
        if len(new_pw) < MIN_PASSWORD_LENGTH:
            return jsonify({"error": f"password must be at least {MIN_PASSWORD_LENGTH} characters"}), 400
        u["password_hash"] = generate_password_hash(new_pw)

    if "list_order" in body:
        u["list_order"] = body["list_order"]

    _save_users(users)
    return jsonify({
        "id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "admin": u.get("admin", False),
    })


@app.delete("/api/me")
@_require_auth
def delete_me():
    """Delete own account. Requires password confirmation."""
    user = _current_user()
    body = request.get_json(force=True)
    password = body.get("password", "")
    users = _load_users()
    u = next((u for u in users if u["id"] == user["id"]), None)
    if u is None:
        return jsonify({"error": "user not found"}), 404
    if not check_password_hash(u["password_hash"], password):
        return jsonify({"error": "incorrect password"}), 403

    _delete_user_data(user["id"], users)
    users = [x for x in users if x["id"] != user["id"]]
    _save_users(users)
    session.clear()
    return "", 204


@app.delete("/api/users/<user_id>")
@_require_auth
def delete_user(user_id: str):
    """Admin: delete another user."""
    user = _current_user()
    if not user.get("admin"):
        return jsonify({"error": "admin required"}), 403
    if user_id == user["id"]:
        return jsonify({"error": "cannot delete yourself here, use DELETE /api/me"}), 400
    users = _load_users()
    target = next((u for u in users if u["id"] == user_id), None)
    if target is None:
        return jsonify({"error": "user not found"}), 404

    _delete_user_data(user_id, users)
    users = [x for x in users if x["id"] != user_id]
    _save_users(users)
    return "", 204


@app.patch("/api/users/<user_id>")
@_require_auth
def admin_update_user(user_id: str):
    """Admin: update another user (toggle admin, change display name, reset password)."""
    user = _current_user()
    if not user.get("admin"):
        return jsonify({"error": "admin required"}), 403
    users = _load_users()
    target = next((u for u in users if u["id"] == user_id), None)
    if target is None:
        return jsonify({"error": "user not found"}), 404
    body = request.get_json(force=True)

    if "display_name" in body:
        dn = str(body["display_name"]).strip()[:200]
        if dn:
            target["display_name"] = dn
    if "admin" in body:
        target["admin"] = bool(body["admin"])
    if "password" in body:
        pw = body["password"]
        if len(pw) < MIN_PASSWORD_LENGTH:
            return jsonify({"error": f"password must be at least {MIN_PASSWORD_LENGTH} characters"}), 400
        target["password_hash"] = generate_password_hash(pw)

    _save_users(users)
    return jsonify({
        "id": target["id"],
        "username": target["username"],
        "display_name": target["display_name"],
        "admin": target.get("admin", False),
    })


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
    if len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"password must be at least {MIN_PASSWORD_LENGTH} characters"}), 400
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
# Contact endpoints
# ---------------------------------------------------------------------------

def _resolve_contact_users(user_ids: list[str], users: list[dict]) -> list[dict]:
    """Resolve a list of user IDs to {id, username, display_name} dicts."""
    by_id = {u["id"]: u for u in users}
    result = []
    for uid in user_ids:
        u = by_id.get(uid)
        if u:
            result.append({
                "id": u["id"],
                "username": u["username"],
                "display_name": u["display_name"],
            })
    return result


@app.get("/api/contacts")
@_require_auth
def get_contacts():
    """Return my contacts, incoming requests, and outgoing requests."""
    user = _current_user()
    users = _load_users()
    me = next((u for u in users if u["id"] == user["id"]), None)
    if me is None:
        return jsonify({"error": "user not found"}), 404
    _ensure_contacts(me)
    return jsonify({
        "contacts": _resolve_contact_users(me["contacts"], users),
        "incoming": _resolve_contact_users(me["contact_requests_in"], users),
        "outgoing": _resolve_contact_users(me["contact_requests_out"], users),
    })


@app.post("/api/contacts/request")
@_require_auth
def send_contact_request():
    """Send a contact request by username."""
    user = _current_user()
    body = request.get_json(force=True)
    username = body.get("username", "").strip()
    if not username:
        return jsonify({"error": "username is required"}), 400

    users = _load_users()
    me = next((u for u in users if u["id"] == user["id"]), None)
    target = next((u for u in users if u["username"] == username), None)

    if target is None:
        return jsonify({"error": "user not found"}), 404
    if target["id"] == user["id"]:
        return jsonify({"error": "cannot send a request to yourself"}), 400

    _ensure_contacts(me)
    _ensure_contacts(target)

    if target["id"] in me["contacts"]:
        return jsonify({"error": "already in your contacts"}), 400
    if target["id"] in me["contact_requests_out"]:
        return jsonify({"error": "request already sent"}), 400

    # If they already sent us a request, auto-accept
    if target["id"] in me["contact_requests_in"]:
        me["contact_requests_in"] = [c for c in me["contact_requests_in"] if c != target["id"]]
        target["contact_requests_out"] = [c for c in target["contact_requests_out"] if c != me["id"]]
        me["contacts"].append(target["id"])
        target["contacts"].append(me["id"])
        _save_users(users)
        return jsonify({"ok": True, "auto_accepted": True})

    me["contact_requests_out"].append(target["id"])
    target["contact_requests_in"].append(me["id"])
    _save_users(users)
    return jsonify({"ok": True})


@app.post("/api/contacts/accept")
@_require_auth
def accept_contact_request():
    """Accept an incoming contact request."""
    users, me, target, err = _load_contact_pair(_current_user())
    if err:
        return err

    if target["id"] not in me["contact_requests_in"]:
        return jsonify({"error": "no pending request from this user"}), 400

    me["contact_requests_in"] = [c for c in me["contact_requests_in"] if c != target["id"]]
    target["contact_requests_out"] = [c for c in target["contact_requests_out"] if c != me["id"]]
    me["contacts"].append(target["id"])
    target["contacts"].append(me["id"])
    _save_users(users)
    return jsonify({"ok": True})


@app.post("/api/contacts/decline")
@_require_auth
def decline_contact_request():
    """Decline an incoming contact request."""
    users, me, target, err = _load_contact_pair(_current_user())
    if err:
        return err

    me["contact_requests_in"] = [c for c in me["contact_requests_in"] if c != target["id"]]
    target["contact_requests_out"] = [c for c in target["contact_requests_out"] if c != me["id"]]
    _save_users(users)
    return jsonify({"ok": True})


@app.post("/api/contacts/cancel")
@_require_auth
def cancel_contact_request():
    """Cancel my outgoing contact request."""
    users, me, target, err = _load_contact_pair(_current_user())
    if err:
        return err

    me["contact_requests_out"] = [c for c in me["contact_requests_out"] if c != target["id"]]
    target["contact_requests_in"] = [c for c in target["contact_requests_in"] if c != me["id"]]
    _save_users(users)
    return jsonify({"ok": True})


@app.delete("/api/contacts/<user_id>")
@_require_auth
def remove_contact(user_id: str):
    """Remove a contact from both users."""
    user = _current_user()
    users = _load_users()
    me = next((u for u in users if u["id"] == user["id"]), None)
    target = next((u for u in users if u["id"] == user_id), None)

    if target is None:
        return jsonify({"error": "user not found"}), 404

    _ensure_contacts(me)
    _ensure_contacts(target)

    me["contacts"] = [c for c in me["contacts"] if c != user_id]
    target["contacts"] = [c for c in target["contacts"] if c != me["id"]]
    _save_users(users)
    return jsonify({"ok": True})


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
            _migrate_list_fields(data)
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
    # Sort by user's saved list order, pruning stale IDs
    order = user.get("list_order", [])
    if order:
        valid_ids = {l["id"] for l in lists}
        pruned = [lid for lid in order if lid in valid_ids]
        if len(pruned) != len(order):
            users = _load_users()
            u = next((u for u in users if u["id"] == user["id"]), None)
            if u:
                u["list_order"] = pruned
                _save_users(users)
        order_map = {lid: i for i, lid in enumerate(pruned)}
        lists.sort(key=lambda l: order_map.get(l["id"], len(pruned)))
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
    return jsonify(_list_for_response(data)), 201


@app.get("/api/lists/<list_id>")
def get_list(list_id: str):
    data, err = _authorize_list_read(list_id)
    if err:
        return err
    return jsonify(_list_for_response(data))


@app.get("/api/lists/<list_id>/version")
def get_list_version(list_id: str):
    data, err = _authorize_list_read(list_id)
    if err:
        return err
    return jsonify({"version": data.get("version", 0)})


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
    if "views" in body:
        data["views"] = body["views"]
    if "active_view" in body:
        data["active_view"] = body["active_view"]
    _save_list(data)
    return jsonify(_list_for_response(data))


@app.get("/api/lists/<list_id>/sharing")
@_require_auth
def get_list_sharing(list_id: str):
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if not _can_access(data, user):
        return jsonify({"error": "not found"}), 404
    users = _load_users()
    by_id = {u["id"]: u for u in users}
    owner = by_id.get(data.get("owner"))
    shared = []
    for s in data.get("shared_with", []):
        u = by_id.get(s["user_id"])
        if u:
            shared.append({
                "user_id": u["id"],
                "username": u["username"],
                "display_name": u["display_name"],
                "permission": s.get("permission", "read"),
            })
    return jsonify({
        "owner": {
            "id": owner["id"],
            "username": owner["username"],
            "display_name": owner["display_name"],
        } if owner else None,
        "is_owner": data.get("owner") == user["id"],
        "shared_with": shared,
    })


@app.post("/api/lists/<list_id>/leave")
@_require_auth
def leave_list(list_id: str):
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if data.get("owner") == user["id"]:
        return jsonify({"error": "owners cannot leave their own list"}), 400
    data["shared_with"] = [s for s in data.get("shared_with", []) if s["user_id"] != user["id"]]
    _save_list(data)
    return jsonify({"ok": True})


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
def add_item(list_id: str):
    data, snap, err = _authorize_list_write(list_id)
    if err:
        return err
    body = request.get_json(force=True)
    text = str(body.get("text", "")).strip()[:1000]
    depth = max(0, min(MAX_DEPTH, int(body.get("depth", 0))))
    item = _new_item(text, depth)
    if "tags" in body and isinstance(body["tags"], list):
        item["tags"] = body["tags"]
    after_id = body.get("after_id")
    before_id = body.get("before_id")
    if before_id and _valid_id(before_id):
        idx = next((i for i, it in enumerate(data["items"]) if it["id"] == before_id), None)
        if idx is not None:
            data["items"].insert(idx, item)
        else:
            data["items"].append(item)
    elif after_id and _valid_id(after_id):
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
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    token_ok = _check_list_token(data)
    if token_ok:
        perm = "edit"
    else:
        user = _current_user()
        if not user:
            return jsonify({"error": "unauthorized"}), 401
        perm = _get_permission(data, user)
        if perm == "none" or perm == "view":
            return jsonify({"error": "forbidden"}), 403
    item = _find_item(data["items"], item_id)
    if item is None:
        return jsonify({"error": "item not found"}), 404
    body = request.get_json(force=True)
    if perm == "check":
        # Only allow toggling done status
        if set(body.keys()) - {"done"}:
            return jsonify({"error": "forbidden"}), 403
    _apply_item_fields(item, body)
    _save_with_undo(data, snap)
    return jsonify(item)


@app.patch("/api/lists/<list_id>/items")
def bulk_update_items(list_id: str):
    data, snap = _load_and_snapshot(list_id)
    if data is None:
        return jsonify({"error": "list not found"}), 404
    token_ok = _check_list_token(data)
    if token_ok:
        perm = "edit"
    else:
        user = _current_user()
        if not user:
            return jsonify({"error": "unauthorized"}), 401
        perm = _get_permission(data, user)
        if perm == "none" or perm == "view":
            return jsonify({"error": "forbidden"}), 403
    body = request.get_json(force=True)
    updates = body.get("updates", [])
    applied = 0
    for upd in updates:
        if perm == "check" and set(upd.keys()) - {"id", "done"}:
            return jsonify({"error": "forbidden"}), 403
        item = _find_item(data["items"], upd["id"])
        if item:
            _apply_item_fields(item, upd)
            applied += 1
    _save_with_undo(data, snap)
    if _verbose_response():
        return jsonify(_list_for_response(data))
    return jsonify({"ok": True, "version": data.get("version", 0), "updated": applied})


@app.delete("/api/lists/<list_id>/items/<item_id>")
def delete_item(list_id: str, item_id: str):
    data, snap, err = _authorize_list_write(list_id)
    if err:
        return err
    before = len(data["items"])
    data["items"] = [it for it in data["items"] if it["id"] != item_id]
    if len(data["items"]) == before:
        return jsonify({"error": "item not found"}), 404
    _save_with_undo(data, snap)
    return "", 204


@app.post("/api/lists/<list_id>/items/bulk-delete")
def bulk_delete_items(list_id: str):
    """Delete multiple items at once. Body: {item_ids: [...]}."""
    data, snap, err = _authorize_list_write(list_id)
    if err:
        return err
    body = request.get_json(force=True)
    ids = set(body.get("item_ids", []))
    before = len(data["items"])
    data["items"] = [it for it in data["items"] if it["id"] not in ids]
    deleted = before - len(data["items"])
    _save_with_undo(data, snap)
    if _verbose_response():
        return jsonify(_list_for_response(data))
    return jsonify({"ok": True, "version": data.get("version", 0), "deleted": deleted})


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
    return jsonify(_list_for_response(dest))


@app.post("/api/lists/<list_id>/items/reorder")
def reorder_items(list_id: str):
    data, snap, err = _authorize_list_write(list_id)
    if err:
        return err
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
    if _verbose_response():
        return jsonify(_list_for_response(data))
    return jsonify({"ok": True, "version": data.get("version", 0)})


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
    return jsonify(_list_for_response(data))


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
    return jsonify(_list_for_response(data))


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
    return jsonify(_list_for_response(data))


# ---------------------------------------------------------------------------
# Gather
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/items/gather")
def gather_items(list_id: str):
    """Gather items with matching names at the same depth under the target.
    Body: {item_id}. Merges children of duplicates into the target item.
    """
    data, snap, err = _authorize_list_write(list_id)
    if err:
        return err
    body = request.get_json(force=True)
    target_id = body.get("item_id")
    items = data["items"]

    target_idx = next((i for i, it in enumerate(items) if it["id"] == target_id), None)
    if target_idx is None:
        return jsonify({"error": "item not found"}), 404

    target = items[target_idx]
    target_name = target["text"].strip().lower()
    target_depth = target["depth"]

    # Determine search scope for non-root items
    scope_start = 0
    scope_end = len(items)
    if target_depth > 0:
        # Find parent
        for i in range(target_idx - 1, -1, -1):
            if items[i]["depth"] < target_depth:
                scope_start = i + 1
                # Find parent's hierarchy end
                parent_depth = items[i]["depth"]
                scope_end = i + 1
                while scope_end < len(items) and items[scope_end]["depth"] > parent_depth:
                    scope_end += 1
                break

    # Find matching items at the same depth
    def _child_range(idx):
        d = items[idx]["depth"]
        end = idx + 1
        while end < len(items) and items[end]["depth"] > d:
            end += 1
        return idx + 1, end

    # Collect matches and their children
    indices_to_remove = set()
    children_to_gather = []  # (original_index, item) pairs for ordering

    for i in range(scope_start, scope_end):
        if i == target_idx:
            continue
        if items[i]["depth"] != target_depth:
            continue
        if items[i]["text"].strip().lower() != target_name:
            continue
        # Found a match — collect its children and mark for removal
        c_start, c_end = _child_range(i)
        for c in range(c_start, c_end):
            children_to_gather.append((c, items[c]))
            indices_to_remove.add(c)
        indices_to_remove.add(i)

    if not indices_to_remove:
        if _verbose_response():
            return jsonify(_list_for_response(data))
        return jsonify({"ok": True, "version": data.get("version", 0), "removed": 0})

    # Sort gathered children by original position
    children_to_gather.sort(key=lambda x: x[0])
    gathered = [it for _, it in children_to_gather]

    # Find target's child end
    _, target_child_end = _child_range(target_idx)

    # Build new items list: keep everything except removed items,
    # insert gathered children after target's existing children
    new_items = []
    for i, it in enumerate(items):
        if i in indices_to_remove:
            continue
        new_items.append(it)
        if i == target_child_end - 1 or (target_child_end == target_idx + 1 and i == target_idx):
            new_items.extend(gathered)

    removed_count = sum(1 for i in indices_to_remove if items[i]["depth"] == target_depth)
    data["items"] = new_items
    _save_with_undo(data, snap)
    if _verbose_response():
        return jsonify(_list_for_response(data))
    return jsonify({"ok": True, "version": data.get("version", 0), "removed": removed_count})


# ---------------------------------------------------------------------------
# Debug / testing
# ---------------------------------------------------------------------------

@app.post("/api/lists/<list_id>/items/bulk-add")
def bulk_add_items(list_id: str):
    """Add multiple items at once. Body: {items: [{text, depth?, done?, tags?}]}.

    `tags` (optional) is a list of {id, value?} objects; tag IDs must exist in
    the list's tag definitions. Items are appended in order — hierarchy is
    expressed via the `depth` attribute combined with relative position."""
    data, snap, err = _authorize_list_write(list_id)
    if err:
        return err
    body = request.get_json(force=True)
    new_items = body.get("items", [])
    valid_tag_ids = {t["id"] for t in data.get("tags", [])}
    added_ids = []
    for ni in new_items:
        text = str(ni.get("text", "")).strip()[:1000]
        depth = max(0, min(MAX_DEPTH, int(ni.get("depth", 0))))
        item = _new_item(text, depth)
        if ni.get("done"):
            item["done"] = True
            item["completed"] = _now()
        if isinstance(ni.get("tags"), list):
            cleaned = []
            for t in ni["tags"]:
                if isinstance(t, dict) and t.get("id") in valid_tag_ids:
                    cleaned.append({"id": t["id"], "value": t.get("value")})
            item["tags"] = cleaned
        data["items"].append(item)
        added_ids.append(item["id"])
    _save_with_undo(data, snap)
    if _verbose_response():
        return jsonify(_list_for_response(data)), 201
    return jsonify({"ok": True, "version": data.get("version", 0), "added_ids": added_ids}), 201


_ISO_DATE_PREFIX = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _earliest_item_date(item: dict) -> str | None:
    """Return the earliest YYYY-MM-DD key among the item's tag values, or None."""
    earliest = None
    for t in item.get("tags", []):
        v = t.get("value")
        if not isinstance(v, str):
            continue
        m = _ISO_DATE_PREFIX.match(v)
        if not m:
            continue
        k = m.group(1)
        if earliest is None or k < earliest:
            earliest = k
    return earliest


@app.get("/api/upcoming")
@_require_auth
def get_upcoming():
    """Cross-list snapshot of not-done items with a date-valued tag
    whose earliest date falls within [today - past, today + future].

    Query params: today=YYYY-MM-DD (client's local today), future (int, days),
    past ("all" or int, days). Returns sorted items with ancestor chains
    and per-list tag definitions.
    """
    user = _current_user()
    from datetime import date as _date

    today_str = request.args.get("today", "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", today_str):
        return jsonify({"error": "invalid today"}), 400
    today_date = _date.fromisoformat(today_str)

    try:
        future_days = int(request.args.get("future", "7"))
    except ValueError:
        future_days = 7
    future_days = max(0, min(future_days, 3650))
    future_cutoff = (today_date + timedelta(days=future_days)).isoformat()

    past_arg = request.args.get("past", "7")
    if past_arg == "all":
        past_cutoff = None
    else:
        try:
            past_days = int(past_arg)
        except ValueError:
            past_days = 7
        past_days = max(0, min(past_days, 3650))
        past_cutoff = (today_date - timedelta(days=past_days)).isoformat()

    lists_meta: dict[str, dict] = {}
    results = []
    for path in sorted(DATA_DIR.glob("*.json")):
        if path.name == "users.json":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            _migrate_list_fields(data)
            _ensure_tags(data)
        except (json.JSONDecodeError, KeyError, OSError):
            continue
        if not _can_access(data, user):
            continue

        list_id = data["id"]
        items = data.get("items", [])
        any_match = False

        for idx, item in enumerate(items):
            if item.get("done"):
                continue
            date_key = _earliest_item_date(item)
            if date_key is None:
                continue
            if date_key > future_cutoff:
                continue
            if past_cutoff is not None and date_key < past_cutoff:
                continue
            depth = item.get("depth", 0)
            ancestors = []
            target_depth = depth
            for j in range(idx - 1, -1, -1):
                if target_depth == 0:
                    break
                jd = items[j].get("depth", 0)
                if jd < target_depth:
                    ancestors.append({
                        "text": items[j].get("text", ""),
                        "depth": jd,
                    })
                    target_depth = jd
            ancestors.reverse()

            results.append({
                "list_id": list_id,
                "item": {
                    "id": item.get("id"),
                    "text": item.get("text", ""),
                    "depth": depth,
                    "tags": item.get("tags", []),
                },
                "ancestors": ancestors,
                "sort_date": date_key,
            })
            any_match = True

        if any_match:
            lists_meta[list_id] = {
                "name": data.get("name", ""),
                "tags": data.get("tags", []),
            }

    results.sort(key=lambda r: r["sort_date"])
    return jsonify({
        "today": today_str,
        "lists": lists_meta,
        "items": results,
    })


# ---------------------------------------------------------------------------
# Calendar subscription (.ics feed)
# ---------------------------------------------------------------------------

def _ics_escape(s: str) -> str:
    """Escape text per RFC 5545 §3.3.11."""
    return (
        s.replace("\\", "\\\\")
         .replace(";", "\\;")
         .replace(",", "\\,")
         .replace("\n", "\\n")
         .replace("\r", "")
    )


def _ics_fold(line: str) -> str:
    """Fold a line at 75 octets per RFC 5545 §3.1."""
    if len(line) <= 75:
        return line
    out = [line[:75]]
    i = 75
    while i < len(line):
        out.append(" " + line[i:i + 74])
        i += 74
    return "\r\n".join(out)


def _find_user_by_calendar_token(token: str) -> dict | None:
    if not token or len(token) > 200:
        return None
    for u in _load_users():
        if u.get("calendar_token") == token:
            return u
    return None


def _collect_calendar_events(user: dict, list_filter_id: str | None) -> list[dict]:
    """Collect top-level calendar events. If a descendant shares the same
    (tag, date) pair as any ancestor, it is collapsed into the top-most such
    ancestor's event rather than emitted separately — so an aligned hierarchy
    becomes one calendar event with the children listed in the description.

    Returns a list of dicts with keys:
        list_name, list_id, item_id, item_text, tag_def, date_iso, children
    where children is a list of {text, relative_depth} for collapsed descendants.
    """
    events: list[dict] = []
    for path in sorted(DATA_DIR.glob("*.json")):
        if path.name == "users.json":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            _migrate_list_fields(data)
            _ensure_tags(data)
        except (json.JSONDecodeError, KeyError, OSError):
            continue
        if not _can_access(data, user):
            continue
        if list_filter_id is not None and data.get("id") != list_filter_id:
            continue

        tags_by_id = {t["id"]: t for t in data.get("tags", [])}
        list_name = data.get("name", "")
        list_id = data.get("id", "")
        items = data.get("items", [])

        # Pre-compute the date-valued (tag_id, date) pairs per item.
        # Done items contribute nothing, so they can't "swallow" descendants.
        item_pairs: list[set[tuple[str, str]]] = []
        for item in items:
            pairs: set[tuple[str, str]] = set()
            if not item.get("done"):
                for tag_ref in item.get("tags", []):
                    val = tag_ref.get("value")
                    if not isinstance(val, str):
                        continue
                    m = _ISO_DATE_PREFIX.match(val)
                    if not m:
                        continue
                    tid = tag_ref.get("id")
                    if tid in tags_by_id:
                        pairs.add((tid, m.group(1)))
            item_pairs.append(pairs)

        # (top_idx, tag_id, date_iso) -> event dict
        key_to_event: dict[tuple[int, str, str], dict] = {}

        for idx, item in enumerate(items):
            if not item_pairs[idx]:
                continue
            depth = item.get("depth", 0)
            for tag_id, date_iso in item_pairs[idx]:
                # Walk ancestor chain (backward, strictly-decreasing depth);
                # top_idx ends up at the top-most ancestor with the same pair,
                # or stays at idx if no ancestor matches.
                top_idx = idx
                cur_depth = depth
                for j in range(idx - 1, -1, -1):
                    if cur_depth == 0:
                        break
                    jd = items[j].get("depth", 0)
                    if jd < cur_depth:
                        if (tag_id, date_iso) in item_pairs[j]:
                            top_idx = j
                        cur_depth = jd

                if top_idx == idx:
                    ev = {
                        "list_name": list_name,
                        "list_id": list_id,
                        "item_id": item.get("id"),
                        "item_text": item.get("text", ""),
                        "tag_def": tags_by_id[tag_id],
                        "date_iso": date_iso,
                        "children": [],
                    }
                    events.append(ev)
                    key_to_event[(idx, tag_id, date_iso)] = ev
                else:
                    ev = key_to_event.get((top_idx, tag_id, date_iso))
                    if ev is not None:
                        ev["children"].append({
                            "text": item.get("text", ""),
                            "relative_depth": depth - items[top_idx].get("depth", 0),
                        })

    return events


def _build_calendar_ics(user: dict, list_filter_id: str | None, cal_name: str, cal_desc: str, base_url: str) -> str:
    from datetime import date as _date
    dtstamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Klaar//Klaar Todo//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        _ics_fold(f"X-WR-CALNAME:{_ics_escape(cal_name)}"),
        _ics_fold(f"X-WR-CALDESC:{_ics_escape(cal_desc)}"),
    ]
    for ev in _collect_calendar_events(user, list_filter_id):
        ymd = ev["date_iso"].replace("-", "")
        end_ymd = (_date.fromisoformat(ev["date_iso"]) + timedelta(days=1)).isoformat().replace("-", "")
        tag_name = ev["tag_def"].get("name", "")
        summary = f"{ev['item_text']} ({tag_name})" if tag_name else ev["item_text"]
        uid = f"klaar-{ev['item_id']}-{ev['tag_def'].get('id')}@klaar"
        deep_link = f"{base_url}#list={ev['list_id']}&item={ev['item_id']}"

        desc_parts = [f"Klaar list: {ev['list_name']}"]
        if ev["children"]:
            desc_parts.append("")
            desc_parts.append("Includes:")
            for c in ev["children"]:
                indent = "  " * c["relative_depth"]
                desc_parts.append(f"{indent}- {c['text']}")
        # Repeat the deep link in the description body. The separate URL
        # property above is ignored by Google Calendar's web UI; putting the
        # URL in the description text lets Google auto-link it so the event
        # actually becomes clickable from Google Calendar.
        desc_parts.append("")
        desc_parts.append(f"Open in Klaar: {deep_link}")
        description = "\n".join(desc_parts)

        lines.extend([
            "BEGIN:VEVENT",
            _ics_fold(f"UID:{uid}"),
            f"DTSTAMP:{dtstamp}",
            f"DTSTART;VALUE=DATE:{ymd}",
            f"DTEND;VALUE=DATE:{end_ymd}",
            _ics_fold(f"SUMMARY:{_ics_escape(summary)}"),
            _ics_fold(f"DESCRIPTION:{_ics_escape(description)}"),
            _ics_fold(f"URL:{deep_link}"),
            "END:VEVENT",
        ])
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


def _ics_base_url() -> str:
    """Base URL for ICS event deep links. Honors X-Forwarded-Proto so that
    a reverse proxy terminating HTTPS doesn't bake http:// links into feeds."""
    proto = request.headers.get("X-Forwarded-Proto", "").strip().lower()
    host = request.headers.get("X-Forwarded-Host") or request.host
    if proto in ("http", "https"):
        return f"{proto}://{host}/"
    return request.host_url


@app.get("/calendar/<token>.ics")
def calendar_feed_all(token):
    user = _find_user_by_calendar_token(token)
    if not user:
        return "Not found", 404
    label = user.get("display_name") or user.get("username", "")
    body = _build_calendar_ics(
        user,
        None,
        cal_name=f"Klaar ({label})" if label else "Klaar",
        cal_desc="All dated Klaar items",
        base_url=_ics_base_url(),
    )
    return body, 200, {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="klaar.ics"',
        "Cache-Control": "no-cache, private",
    }


@app.get("/calendar/<token>/<list_id>.ics")
def calendar_feed_list(token, list_id):
    user = _find_user_by_calendar_token(token)
    if not user:
        return "Not found", 404
    data = _load_list(list_id)
    if not data or not _can_access(data, user):
        return "Not found", 404
    list_name = data.get("name", "List")
    body = _build_calendar_ics(
        user,
        list_id,
        cal_name=f"Klaar: {list_name}",
        cal_desc=f"Dated items from {list_name}",
        base_url=_ics_base_url(),
    )
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", list_name)[:40] or "list"
    return body, 200, {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": f'inline; filename="klaar-{safe_name}.ics"',
        "Cache-Control": "no-cache, private",
    }


@app.get("/api/me/calendar-token")
@_require_auth
def get_calendar_token():
    user = _current_user()
    users = _load_users()
    u = next((x for x in users if x["id"] == user["id"]), None)
    if u is None:
        return jsonify({"error": "user not found"}), 404
    if not u.get("calendar_token"):
        u["calendar_token"] = secrets.token_urlsafe(32)
        _save_users(users)
    return jsonify({"token": u["calendar_token"]})


@app.post("/api/me/calendar-token/regenerate")
@_require_auth
def regenerate_calendar_token():
    user = _current_user()
    users = _load_users()
    u = next((x for x in users if x["id"] == user["id"]), None)
    if u is None:
        return jsonify({"error": "user not found"}), 404
    u["calendar_token"] = secrets.token_urlsafe(32)
    _save_users(users)
    return jsonify({"token": u["calendar_token"]})


# ---------------------------------------------------------------------------
# List API tokens (per-list, for granting AI / external write access)
# ---------------------------------------------------------------------------

def _api_token_info(data: dict) -> dict:
    return {
        "list_id": data["id"],
        "list_name": data.get("name", ""),
        "token": data.get("api_token"),
        "created_at": data.get("api_token_created_at"),
        "last_used_at": data.get("api_token_last_used_at"),
    }


@app.get("/api/lists/<list_id>/api-token")
@_require_auth
def get_list_api_token(list_id: str):
    """Owner-only: fetch the current API token for a list (or null)."""
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    return jsonify(_api_token_info(data))


@app.post("/api/lists/<list_id>/api-token")
@_require_auth
def create_list_api_token(list_id: str):
    """Owner-only: create or rotate the API token for a list."""
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    data["api_token"] = secrets.token_urlsafe(32)
    data["api_token_created_at"] = _now()
    data["api_token_last_used_at"] = None
    _save_list(data)
    return jsonify(_api_token_info(data))


@app.delete("/api/lists/<list_id>/api-token")
@_require_auth
def revoke_list_api_token(list_id: str):
    """Owner-only: clear the API token for a list."""
    data = _load_list(list_id)
    if data is None:
        return jsonify({"error": "not found"}), 404
    user = _current_user()
    if not _can_write(data, user):
        return jsonify({"error": "forbidden"}), 403
    data["api_token"] = None
    data["api_token_created_at"] = None
    data["api_token_last_used_at"] = None
    _save_list(data)
    return "", 204


@app.get("/api/me/api-tokens")
@_require_auth
def list_my_api_tokens():
    """Return all lists the current user can write to that have an active
    API token, plus created/last-used timestamps. Used by the user page
    to surface zombie tokens for review."""
    user = _current_user()
    out = []
    for path in sorted(DATA_DIR.glob("*.json")):
        if path.name == "users.json":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            _migrate_list_fields(data)
        except (json.JSONDecodeError, KeyError, OSError):
            continue
        if not data.get("api_token"):
            continue
        if not _can_write(data, user):
            continue
        info = _api_token_info(data)
        info.pop("token", None)  # don't leak token value via the list endpoint
        out.append(info)
    return jsonify({"tokens": out})


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
