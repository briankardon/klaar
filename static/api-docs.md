# Klaar List API

A small JSON HTTP API for adding, editing, and removing items in a single Klaar list. Intended use case: granting an AI assistant (or scripted tool) write access to one specific list without giving it your password.

All requests are scoped to a single list. The token authorizes operations on **that list only** — it cannot read or modify other lists, list metadata, sharing, or your account.

---

## Authentication

Every request must include the list's API token, either as:

```
Authorization: Bearer <token>
```

or as a query parameter:

```
?token=<token>
```

The header is preferred. The token is generated from the list's right-click menu in the Klaar web UI ("API access"). It can be rotated or revoked at any time from there or from the user settings page.

---

## Base URL

All paths below are relative to your Klaar host, e.g. `https://klaar.example.com`. The list ID appears in the URL hash when viewing a list (`#list=<id>`) and is included in the token-share workflow.

---

## Read

### `GET /api/lists/<list_id>`

Returns the full list state.

**Response:**
```json
{
  "id": "abc123def456",
  "name": "Project plan",
  "created": "2026-01-15T12:34:56+00:00",
  "version": 42,
  "tags": [
    {"id": "t_due", "name": "Due", "color": "#e74c3c", "type": "date"},
    {"id": "t_owner", "name": "Owner", "color": "#3498db", "type": "text"}
  ],
  "items": [
    {
      "id": "i_001",
      "text": "Top-level goal",
      "depth": 0,
      "done": false,
      "created": "2026-01-15T12:34:56+00:00",
      "completed": null,
      "tags": [{"id": "t_due", "value": "2026-05-01"}]
    },
    {
      "id": "i_002",
      "text": "Sub-task",
      "depth": 1,
      "done": false,
      ...
    }
  ]
}
```

### `GET /api/lists/<list_id>/version`

Returns just `{"version": <int>}`. Increments on every write — use this to cheaply check if the list has changed since you last read it.

---

## Items

Items are stored as a **flat ordered list**. Hierarchy is purely positional: an item with `depth=N` is a child of the nearest preceding item with `depth < N`. There is no `parent_id` field.

To create a tree:
- Append a `depth=0` item (the parent)
- Append `depth=1` items immediately after it (its children)
- Append `depth=2` items after a `depth=1` item to make grandchildren
- Returning to `depth=0` starts a new top-level item

`depth` is clamped to 0–20.

### `POST /api/lists/<list_id>/items`

Add a single item. Body:

```json
{
  "text": "New item text",
  "depth": 0,
  "tags": [{"id": "t_due", "value": "2026-05-01"}],
  "after_id": "i_001",
  "before_id": null
}
```

All fields except `text` are optional. Position defaults to end of list. `after_id` / `before_id` (if provided and matching an existing item) place the new item adjacent to that one.

> ⚠️ **Hierarchy footgun:** position-and-depth defines parenting. If the named item has children and you insert at lower-or-equal depth, those children become children of *your* new item, not of the original. To insert *after a whole subtree*, append at the end, or place after the subtree's last descendant. Bulk-add (below) is usually a better fit when adding nested structure.

Returns the created item with its assigned `id`.

### `POST /api/lists/<list_id>/items/bulk-add`

Add many items at once, in order. Body:

```json
{
  "items": [
    {"text": "Goal A", "depth": 0},
    {"text": "Step 1", "depth": 1, "tags": [{"id": "t_due", "value": "2026-05-01"}]},
    {"text": "Step 2", "depth": 1, "done": true},
    {"text": "Goal B", "depth": 0}
  ]
}
```

Items are appended at the end of the list, in array order. This is the most efficient way to build a hierarchical plan in one request. Returns the full updated list.

### `PATCH /api/lists/<list_id>/items/<item_id>`

Update one item. Body fields are optional and overwrite:

```json
{
  "text": "New text",
  "done": true,
  "depth": 1,
  "tags": [{"id": "t_due", "value": "2026-05-15"}]
}
```

Setting `done: true` records a completion timestamp; `done: false` clears it.

### `PATCH /api/lists/<list_id>/items`

Bulk update. Body:

```json
{
  "updates": [
    {"id": "i_001", "done": true},
    {"id": "i_002", "text": "Renamed", "tags": [...]}
  ]
}
```

Each update needs an `id` plus any fields to change. Returns the full updated list.

### `DELETE /api/lists/<list_id>/items/<item_id>`

Delete a single item. Children of the deleted item are **not** automatically removed — they remain in place at their existing depths (which may now be orphaned). To delete a subtree, use bulk-delete with all the descendant IDs.

### `POST /api/lists/<list_id>/items/bulk-delete`

Body: `{"item_ids": ["i_001", "i_002", ...]}`. Returns the updated list.

### `POST /api/lists/<list_id>/items/reorder`

Two forms:

1. **Replace order entirely:** `{"order": ["i_a", "i_b", ...]}` — must contain every existing item ID exactly once.
2. **Move a block:** `{"item_id": "i_x", "index": 5, "count": 3}` — move the item at the given ID, plus the next `count - 1` items, to position `index`.

---

## Tags

Tag *definitions* (the named columns) live on the list. Tag *values* live on individual items as `{id: <tag_id>, value: <string|null>}`.

This API does not currently support creating or editing tag definitions via list-token auth — you must use existing tag IDs from `GET /api/lists/<list_id>`. Ask the list owner to pre-create any tags you need.

**Tags are typeless.** Every tag has just a `name` and a `color`; the `value` you set on an item is a free-form string. There is no schema enforcing what kind of data goes on which tag — that's a per-list convention you (and the list owner) decide.

The Klaar UI inspects values opportunistically:
- A value matching `YYYY-MM-DD` (with optional time suffix) is treated as a date — it gets a date picker in the UI, contributes to the calendar feed, and renders as a friendly relative label ("Today", "Tomorrow", "Last Friday", etc.). Use this format any time you mean to convey a date.
- Anything else is shown as plain text.

To remove a tag from an item, omit it from the item's `tags` array on a PATCH (or send `value: null` to keep the tag attached but blank).

---

## Errors

Standard JSON error responses:

- `400` — bad request (malformed body)
- `401` — missing or invalid token
- `403` — token valid but operation not allowed (rare — token grants full edit on the list)
- `404` — list or item not found

Errors return `{"error": "<message>"}`.

---

## Notes

- **Concurrency:** the list has a `version` counter that increments on every write. Two clients writing concurrently will both succeed (last write wins for any given field), but the version lets you detect that a change happened.
- **Undo:** writes are recorded in the list's undo stack as if a logged-in user made them. Owners can undo API-driven changes via the web UI.
- **Auditing:** the token's last-used timestamp is updated on every write. Rotate or revoke from the list's right-click menu, or from the user settings page if you want to review all active tokens at once.
