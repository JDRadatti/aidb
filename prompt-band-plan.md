# Prompt zone framing — IMPLEMENTED (2026-08-29)

Origin: TODO: "the prompt input + fuzzy + popup area should be a different color
so it is more visible". Nudged toward: *slightly* different, a top line that
also runs *above the popups*, and a **left rail** instead of a background tint.

## Status — implemented (one follow-up)

- `ui.promptZone: "off" | "line" | "line+rail"` (default `line`);
  `theme.inputBorder` (default 240) colors the frame. The `line+rail` rail was
  removed as the default per user request — the left bar on the popup is gone;
  the divider remains. `line+rail` stays available opt-in.
- Divider above the band when a dropdown/picker is composited; the editor's
  own top border is suppressed while a band exists (no stacked top lines;
  idle look unchanged).
- Geometry follow-up: suppressing the top border shrank the editor's render by
  one row AND that freed row became the prompt's own row (the document shrank
  by one, so base content climbed up by one). The overlay's `offsetY` was
  still `-(rowsBelow + lastHeight)` — the band then landed on the prompt line,
  hiding the prompt every time a popup opened. Fixed by nudging the overlay up
  two rows whenever a framed zone has a band up (`+2` to the offset: one for
  the border's row, one for the prompt's climb). Covered by unit + screen
  composition (exact terminal-fill) regression tests.
- Implemented in `completion-overlay.ts` (AidbEditor.render + overlay render)
  and `main.ts` (host + config wiring); live re-theme on `/config reload`.
- The background tint stays dead (reverted twice) — the rail replaced it.

## Current geometry (facts)

- The editor is pi-tui's `Editor`: it renders `[top border ──][prompt line][bottom
  border]` (no side borders; `components/editor.js:382-461`).
- The fuzzy picker + slash dropdown share one chrome-less overlay band docked
  flush **above** the editor's top border (`attachDropdownOverlay`,
  `completion-overlay.ts`). While a popup is open, rows sit between the prompt
  and nothing — there is no frame around the input zone at all.
- A background tint was tried (5508080) and reverted (133e6a2) because it
  painted the chrome permanently. Any new version must be **opt-in and
  activation-gated**.

## Design

One coherent "input zone" visual: a thin frame that appears **only while the
popup band is composited** (picker or dropdown open) — the moment that matters
for findability — and is fully off when the prompt is idle.

### 1. The top line moves with the popups

The single horizontal line that is *supposed* to top the prompt zone should sit
**above the band when a popup is open**, not between the popup and the prompt.

- Band active: the overlay's render prepends one divider row
  (`─` run, `theme.inputBorder`). The editor's own top border is suppressed
  (`AidbEditor.render` already post-processes editor output for the dropdown
  stripper; add a `bandActive` flag and drop the top border row while set) so
  we never get divider + band + border stacked.
- Band inactive: no divider, the editor's top border renders as today — zero
  change to the resting look.

### 2. Left rail instead of background tint

Prefer a 1-column left rail (`│`) over a background fill, as requested.

- **Band rows + divider:** fully ours — prefix `‖ rail ‖` each band row and
  the divider in a new `theme.inputBorder` colour role.
- **Prompt line itself:** the editor draws no side border and the cursor
  column math is internal, so injecting a rail char shifts the cursor by one
  and needs a wrapper/offset — heavy. Two options:
  - **A (recommended for now):** rail the band + divider only. The zone is
    already delimited by the top line, the rail, and the prompt's own text
    block; the cursor stays exact.
  - **B (later refinement):** wrap the editor so its content line renders
    `│ ` before the prompt and the cursor column is offset by the rail width.
    Cleanest at the TUI cursor-placement layer, not by string-splicing
    `Editor.render` output.
- Keep the popup **rows** borderless (the chrome-less feel that was
  deliberate last time) — the frame wraps the zone, it doesn't box the list.

### 3. Subtlety + opt-in

- New theme role `theme.inputBorder` (default: a notch lighter than `border`,
  e.g. `237` — "ever so slightly different", not a highlight).
- Config key `ui.promptZone: "off" | "line" | "line+rail"` (default `off`) so
  the resting screen is byte-identical to today unless someone opts in.
- `theme.inputBorder` flows through the normal config/theme path: `config.ts`
  themeKeys + defaults, `settings.ts` + `/config` listing, and the live
  `/config reload` re-theme (already wired for the editor).

## Files touched (when implemented)

- `tui/src/theme.ts` — `inputBorder` role; `config.ts` schema + default.
- `tui/src/completion-overlay.ts` — divider row + rail prefixing in the band
  source; `bandActive` flag.
- `tui/src/picker.ts` — its band lines ride the same overlay source, so the
  rail/divider come for free.
- `tui/src/main.ts` / `AidbEditor` — suppress the editor top border while
  `bandActive`; Option B wrapper later.

## Acceptance criteria

- Resting prompt (no popup): indistinguishable from today.
- Popup open: one top line above the band, `│` rail on the left of band rows
  and divider; rows themselves unpainted.
- `/config reload` re-colors the frame live; `ui.promptZone` off = no change.