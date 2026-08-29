# Plan: make the fuzzy finder render like the slash-command dropdown

> **Status: implemented via Route A** (shared overlay line source). See the
> [`sources` option](tui/src/completion-overlay.ts), [`pickerLineSource`](tui/src/picker.ts)
> and the [main.ts wiring](tui/src/main.ts).
>
> **Refinement:** the query now lives in the **real prompt**, cursor-style —
> while the finder is open the prompt reads `> <query>` (`setPromptText` on
> the editor, which `editor.setText` must place the cursor at the end) and
> the band shows only the narrowed items + a one-row hint footer. There is no
> `filter:` row in the band anymore.
>
> **Second pass:** the `>` prompt appears **immediately when the finder opens**
> (empty query reads `> `, like cursor's live prompt), then grows to `> <query>`
> as you type; backspacing to an empty query leaves `> `. Esc always closes the
> finder (the cancel keybinding `escape`/`ctrl+c` plus an explicit escape
> fallback), clearing the prompt and dismissing the band.

## Problem

The fuzzy finder (`/session`, `/target`, `/layout`, `/win switch`, `/open`)
renders as a **floating bordered dialog** in the middle-bottom of the screen:

```
                              ┌─ sessions ────────────────────────────┐
                              │ filter: sess█                        │
                              │ → session ✳  game · bp 3 · now       │
                              │   memleak    game · minimax · bp 1    │
                              │ ↑/↓ move · Enter select · Esc cancel │
                              └──────────────────────────────────────┘
```

Root cause (from code, not just vibes):

* It uses its **own second overlay** (`picker.ts` → `host.showOverlay`), not the
  dropdown's overlay. Same *strip* (shares the live `offsetY` via
  `rowsBelowPrompt`), but a different overlay entry.
* Its `width` is a **fixed cap** `Math.max(36, Math.min(64, termWidth − 8))`
  (`picker.ts:204`). On a wide terminal the box floats centered horizontally → "middle
  bottom".
* It hand-draws **box chrome** (`┌─┐│└┘`, a title bar, a padded filter row, a
  footer). The slash dropdown is **chrome-less**: a full-width SelectList band
  (`→ name  description` only).

By contrast the slash-command dropdown (`completion-overlay.ts`) is:
* `width: "100%"`, `anchor: "bottom-center"`, `nonCapturing`
* `offsetY = -(rowsBelow + editor.lastHeight)` recomputed every composite pass →
  always flush against the top of the prompt
* display-only SelectList lines stashed into `editor.dropdownLines`, composited on
  top of the document (nothing is pushed, no gap)

Target: the finder should be the *same kind of thing* — full-width, chrome-less,
docked flush above the prompt, using the same overlay/geometry mechanism as the
slash dropdown.

## Recommended route (A): feed the finder through the shared dropdown overlay

This is "almost the same mechanic" literally: the finder's lines go down the same
overlay the slash dropdown uses, so geometry (width 100%, live `offsetY`,
`maxHeight`) is bit-for-bit identical because it is the *same* overlay.

### 1. Generalize the dropdown line source (`completion-overlay.ts`)

Today `attachDropdownOverlay`'s component `render()` reads a single source:
`editor.dropdownLines`. Turn that into a pluggable source list, evaluated in
priority order, first non-empty wins:

```ts
export type OverlayLineSource = () => readonly string[] | null;
attachDropdownOverlay(tui, editor, { ..., sources: [dropdownSource, pickerSource] })
```

* The component keeps recomputing `offsetY = -(rowsBelow + editor.lastHeight)`
  every pass (unchanged) and renders the first non-null/non-empty source's lines.
* `editor.dropdownLines` stays one source (registered in main.ts).
* The picker registers a second source. While the picker is open it emits lines;
  otherwise null. The dropdown and finder can never be visible at once
  (picker opens on Enter of a bare slash command, editor is empty; autocomplete
  only shows while typing in the editor), so priority is purely defensive.

### 2. Rewire `picker.ts` to stop owning an overlay

* Slim `PickerHost`: drop `showOverlay`, `terminalWidth`, `rowsBelowPrompt`;
  add `setPickerLines(lines: readonly string[] | null) -> void` (and keep
  `addInputListener`, `requestRender`).
* `openPicker` no longer builds `OverlayOptions` or calls `showOverlay`; instead
  it renders into the shared source on every state change (typing, selection
  move, delete-confirm, open/close). On close it sets `setPickerLines(null)`.
* `PickerHost` no longer needs a `showOverlay` handle → `close()` just clears
  the source; `pickerActive()` / the global-input-listener deferral in main.ts
  are unchanged.
* Drop the `MAX_VISIBLE`/box padding math that assumed a framed box.

### 3. New chrome-less render spec

Full-width band, left-aligned, no borders or title bar:

```
filter: sess█                       ← muted "filter:" + query + block cursor (one row)
→ session ✳  game · code-watch · bp 3 · now   ← SelectList rows (unchanged style)
  memleak     game · minimax · bp 1 · 2h ago
+ save current session "session"
↑/↓ move · Enter select · Enter new = save · ctrl+d delete · ctrl+r rename · Esc cancel ← muted, one row
```

* Row 1 is the only new chrome-ish element; it **replaces** the box's filter line
  (still carries the block cursor so typing feels the same). Optionally fold the
  title into it (`sessions · filter:`), or drop the title entirely — the
  transcript echo names the command. Recommend the short `filter:` form.
* SelectList rows keep their current `→` accent / muted-description styling
  (identical to the dropdown's SelectList look).
* The `+ create` row keeps its accent.
* The footer stays a single muted hint line — one row, kept because the extra
  affordances (ctrl+d/r) are invisible otherwise. Consider hiding it when no
  extra affordances exist, for closer dropdown parity.
* Rows should be emitted at full width with truncation handled by SelectList
  (drop the per-row `pad(" ", inner - w)` filler that existed for the box).

### 4. Re-point main.ts's host wiring

* `installPickerHost({ ... })`:
  * remove `showOverlay`, `terminalWidth`, `rowsBelowPrompt`,
  * `setPickerLines: (lines) => pickerSource = lines ?? null` + the shared
    overlay picks it up next composite pass (call `tui.requestRender()` as today).
* Delete the geometry mirror hack (`rowsBelowPrompt: () => -(completionOverlay.options.offsetY ?? 0)`)
  — with the shared overlay it's moot.
* Keep `pickerActive()` deferral and `isBarePickerCommand` handling untouched.

### 5. maxHeight parity

Use the dropdown's `maxHeight` setting (currently `"80%"` in main.ts) rather than
the picker's separate `"60%"`, so tall lists scroll the same way.

## Lighter route (B): keep the picker's own overlay, adopt the dropdown's look

If the overlay refactor feels too invasive, a ~30-line alternative:

* Change picker overlay options to `width: "100%"`, `maxHeight: "80%"`, keep the
  live shared `offsetY` (already wired via `rowsBelowPrompt`).
* Remove the box art from `render()` per the spec in §3.
* Downside: still a *second* overlay stacked at the same spot; geometry is
  correct but the mechanism isn't literally shared. Fine as a fallback; the plan
  targets Route A.

## Out of scope / future

* **Route C — filter lives in the real editor prompt** (drive the finder through
  the editor's native autocomplete, with the filter as the actual prompt text on
  Enter of a bare command). Most homogeneous possible, but conflicts with
  ctrl+d/r affordances and the create row; bigger risk. Not needed to fix the
  reported oddness — noted as a possible later polish.
* `/open`'s group labels and `relativeTime` formatting are unaffected.

## Test impact

* `tui/test/picker.test.ts`
  * `rendered()` helper changes from `overlay.render(50)` to reading the picker's
    emitted source lines.
  * The "docks above the prompt like the slash-command dropdown" test asserts
    `overlayOptions.anchor/offsetY/nonCapturing` — with Route A the picker no
    longer constructs an overlay. Replace with: (a) picker is non-capturing by
    construction (keys flow via its listener, asserted already), and (b) the
    shared overlay's `offsetY` is computed from live `editor.lastHeight` (moved
    to `completion-overlay.test.ts`).
  * Border-char assertions (if any) updated to the chrome-less block; `filter:`
    presence kept.
* `tui/test/completion-overlay.test.ts`: add a multi-source test — picker source
  set while dropdown closed ⇒ overlay renders picker lines at the dropdown's
  offset; both sources null ⇒ overlay renders nothing.
* Optional integration style test: compose the picker source into a synthetic
  document of height N and assert the band's top row equals the dropdown's row
  for the same N.

## Files touched

| file | change |
|------|--------|
| `tui/src/completion-overlay.ts` | pluggable line sources (dropdown stays one source) |
| `tui/src/picker.ts` | chrome-less render; feed shared source; slim `PickerHost` |
| `tui/src/main.ts` | wire `setPickerLines` into shared overlay; delete geometry mirror |
| `tui/test/picker.test.ts` | update `rendered()` + geometry assertions |
| `tui/test/completion-overlay.test.ts` | multi-source coverage |

Run: `npm run typecheck --workspace aidb-tui` and `npm test --workspace aidb-tui`.
