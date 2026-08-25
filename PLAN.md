# aidb Visualizer Plan

## Current Hardening

- [ ] Fix nested split sizing so a full-height left pane is not shortened when
  only the right branch is horizontally split.
- [ ] Reset live visualization state at new runs, relaunches, attaches, and
  debugger-session resets. Preserve watch expressions, but clear stale values.
- [ ] Add an explicit memory-size option, preferably:
  `/win load <pane> mem <expr> --bytes <count>`.
- [ ] Make plots use the available pane width while retaining the min/max/last
  footer.
- [ ] Run the full test, build, typecheck, and manual debugger verification.
- [ ] Update `TODO.md` only for features actually implemented. Do not modify
  `README.md`.

## Source And Assembly

- [x] Add reusable live views for source and assembly.
- [x] Add a text renderer for generic output and a code renderer with line
  numbers, current-line/PC markers, and code-aware clipping.
- [x] Add source and assembly bindings over the current location and DAP
  disassembly APIs.

## Scrolling

- [x] Add vertical scrolling with Up/Down. Global `j`/`k` routing remains deferred.
- [x] Add horizontal scrolling with Left/Right for code, long text, and
  hexdumps.
- [ ] Let renderers opt out of horizontal scrolling when it is not useful,
  such as compact tables.
- [x] Preserve prompt editing behavior while routing navigation keys to the
  active pane.

## Plot Extensibility

- [ ] Keep `SeriesBinding` independent from presentation.
- [ ] Add plot interpreters such as sparkline, bar, line, histogram, stats,
  and table.
- [ ] Support swapping plot renderers through `/win pick`.
- [ ] Consider multi-row charts after full-width rendering is in place.

## Slash Autocomplete

- [ ] Show all slash commands after `/`.
- [ ] Narrow command suggestions as input is typed, for example `/wi` to
  `/win`.
- [ ] Provide context-aware suggestions for `/win` subcommands, pane targets,
  visualizer types, and options.
- [ ] Preserve the existing overlay behavior so suggestions do not change
  document height.
