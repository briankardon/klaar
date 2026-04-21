# Accessibility TODO

Punch list for pre-public-release a11y work. Current state: usable with
mouse + keyboard for sighted users; significant gaps for keyboard-only and
screen-reader users. Nothing is irreversibly broken — mostly surface work.

## Biggest cost: Tab hijack

`app.js:~1210` — Tab on the item text input triggers indent instead of the
browser's native "move focus to next focusable element." Keyboard-only users
can enter an item but can't Tab out to the tag pane, list nav, or header
buttons. This is a strong outline-editor convention (Notion, Workflowy,
Logseq, Roam all do it), so removing it would be surprising.

**Recommended fix:** keep Tab hijacked but expose alternate shortcuts
(`Ctrl+]` / `Ctrl+[`) so there's at least one way to indent that doesn't
depend on Tab. Consider a "release focus" shortcut (e.g. `Escape` blurring
the input) so users can exit the input and resume normal Tab navigation.
`Escape` is currently only used in a few places — check for conflicts.

## Keyboard-only multi-select

Multi-select currently requires a mouse (Shift-click, Ctrl-click, drag).
Add:

- `Shift+↑` / `Shift+↓` — extend selection (range-select from anchor).
- `Ctrl+Space` on a focused item — toggle it in/out of the selection.
- `Space` when an item is focused and input is not in edit mode — could
  toggle the done-checkbox, but that collides with typing a space. May need
  a "navigation mode" where arrow keys move between items without editing.

## ARIA labels on icon-only buttons

These use `title` attributes but not `aria-label`. Title *usually* gets
read by screen readers but it's a lossy fallback.

- `#btn-date-filter` (📅) — app.js:~index.html, "Show only items with date tags"
- `#btn-undo` (↶), `#btn-redo` (↷) — index.html:59-60
- `#btn-transfer-list` (⇅) — import/export popover trigger
- `#btn-toggle-tagpane` (•••) — index.html:29

Mechanical fix: add `aria-label="..."` matching each `title`.

## Semantic roles for the item list

The items list is a `<ul>` of `<li>` items — generic. It's actually a
hierarchical tree of to-dos. Screen readers hear a flat list, no sense of
depth or parent/child.

- `role="tree"` on `#items` (or `#items-container`)
- `role="treeitem"` on each `<li>`
- `aria-level="<depth+1>"` per item
- `aria-expanded="true|false"` on items with children (tied to
  `collapsedIds`)
- `aria-selected="true|false"` per item (tied to `selectedIds`)

## Visible focus ring

The browser's default focus ring (the "random white box") is functional but
ugly. Keyboard users *need* a visible indicator — don't just `outline: none`
everywhere. Use `:focus-visible` to distinguish keyboard-induced focus from
mouse clicks, and style it to match the theme.

## Focus management after renderItems

`renderItems()` rebuilds the DOM wholesale. Code that cares about focus
(e.g. `changeDepthSelected` at app.js:1682) re-queries and re-focuses by
id. Many paths don't — after a re-render, focus can drop to `<body>`,
which is disorienting on keyboard. Audit callers of `renderItems` for
where focus should be restored.

## Keyboard-triggered context menu

Right-click / long-press work, but Shift+F10 / Menu key don't trigger
the context menu. Add a handler at the document keydown level that calls
`showContextMenu` with the focused item's bounding rect as the anchor.

## Color contrast

Not audited yet. Run through WCAG AA contrast checker against both light
and dark themes. Areas of concern: done-state greyed items, filter-bubble
colors on active filter bar, tag colors against bubble text.

## Respects `prefers-reduced-motion`

Any animations (slide-in panels on mobile, etc.) should check
`@media (prefers-reduced-motion: reduce)` and skip or shorten.

## Quick wins (under an hour each)

1. Add `aria-label` to every icon-only button.
2. Add `:focus-visible` ring styling.
3. Add `role="tree"` + `aria-level` to items.
4. Wire up `Escape` to blur current item input.

## Bigger efforts

1. Keyboard multi-select (arrow keys + Shift/Ctrl).
2. Full ARIA state management on the tree (expanded/selected per item).
3. Color contrast audit across themes.
