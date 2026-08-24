# TODO

- pi has a spinner that says Waiting while it is waiting on the model. it would be nice to have one that specifies state of the app. 

## Phase 0 — Hardening (do this before anything else)
- [ ] DAP wire tracing: ring-buffer log of all frames in/out, `aidb --trace-dap` dump
- [ ] GDB crash recovery: detect death mid-session, restart cleanly, re-bind breakpoints
- [ ] Bounded frame-parse buffer + backpressure-safe stdin writes in DapClient
- [ ] Feature-gate requests on initialize capabilities (readMemory, disassemble, ...)
- [ ] Roll back state machine when a request fails (never stick in "running")
- [ ] Per-stop caches for stack/scopes (today getStack() fires redundantly) + real frame selection for up/down
- [ ] Match breakpoint sync results by line, not array index
- [ ] Clean shutdown on every path: await gdb exit, FIFO/tmpdir cleanup, no zombies
- [ ] In-process fake gdb (mock DAP server) so vitest covers client/bridge without spawning gdb
- [ ] Fuzz tests for the Content-Length frame parser (garbage, split, oversized)
- [ ] Race tests for exit-debounce / exec-boundary / relaunch heuristics
- [ ] Golden-file tests for TUI rendering
- [ ] Perf benchmarks: step latency, giant frames, large memory reads (see benchmark-plan.html)
- [ ] Typed error taxonomy: core errors vs gdb passthrough, surfaced uniformly in TUI

## Phase 1 — Ergonomics
- [ ] Distinct colors: user input vs program stdout vs gdb console vs errors (theme.ts)
- [ ] Layered config: ~/.aidbrc + ./.aidb.json (theme, gdbPath, keybindings, defaults)
        - config is data, not commands — sections:
          `theme` (colors), `gdb` (path/args/env), `keybindings` (action → chords),
          `defaults` (break style, step behavior), `sessions` (history/persistence paths),
          `windows` (layout presets, manifest dir, refresh policy),
          `agent` (tool permissions, approval gates)
- [ ] Remappable keybindings (loaded from config)
- [ ] State-aware activity spinner (pi-style, not just "Waiting"): label reflects what aidb is
      actually doing — `launching gdb`, `waiting for breakpoint hit (pid 4242)`,
      `reading 256B @ &player`, `restarting after crash` — driven by session state +
      the in-flight request queue; a spinner that never advances also exposes hung requests
- [ ] Vim-style modal input: NORMAL/INSERT modes (Esc/i/v), j·k·g·G / Ctrl+d·u scroll,
      `:` ex-style commands; arrows = history only while the prompt is focused
- [ ] Scrollback everywhere: transcript + every pane scrolls independently when focused
- [ ] Discoverable shortcuts: contextual key-hint footer for the focused view
      (`?` overlay lists everything); hints derived from keybinding config so remaps stay true
      — REPL shows its keys too (F5/F10/F11…), no buttons needed
- [ ] Persistent sessions: breakpoints, watches, window layout survive restarts
- [ ] Persistent command history across runs
- [ ] Multiple concurrent targets behind a SessionManager (attach several, switch focus)
        - unfocused sessions sleep: events buffered/coalesced, FIFO pumps paused, zero polling

## Phase 2 — Pane & window infrastructure

Build order (each step shippable):
- [ ] 1. Layout tree: binary splits `{dir: h|v, ratio, a, b}`; leaves hold exactly one view;
      rects assigned each frame, rendered into pi-tui positioned Texts
- [ ] 2. Splitting acts on the ACTIVE pane: `/win hsplit [view]` / `/win vsplit [view]`
      - no arg → new pane is a blank watch window
      - arg auto-loads it: `/win vsplit src`, `/win hsplit mem &player`
      - vim semantics: vsplit = left/right columns, hsplit = top/bottom rows
- [ ] 3. Pane lifecycle: `/win close` collapses into sibling (REPL pane shrinks, never dies);
      focus moves with Ctrl+w h/j/k/l (directional) and Ctrl+w w (cycle);
      `/win resize <+|-|equal>` adjusts split ratios; min-size guards; tiny-terminal fallback = REPL only
- [ ] 4. Shared view base class — the reason vim keys work everywhere:
      every pane = same underlying structure (content lines + cursor + scroll state);
      base owns scrolling/cursor/clipping, views only supply `content()` + select hooks (~100 lines each)
- [ ] 5. Swap visualization in place: `/win load <id>` or `v` picker overlay on the focused pane
- [ ] 6. Blank watch pane UX: `o` add expression inline, Enter follow pointer, `d` delete entry
- [ ] 7. Views: source (#3), assembly (#4), registers (#5), locals tree w/ lazy children, threads
- [ ] 8. `/tree` stop-history browser: snapshot every stop (frames, vars, regs, watched bytes);
      browse past commands/stops and view their cached state read-only — no rewind, but no amnesia
      (opens in a pane like any other view — the layout tree makes it free)
- [ ] 9. Persist the layout tree + per-view state with sessions (P1)
- [ ] Source view: current-line marker, breakpoint markers, syntax coloring
- [ ] Assembly view: DAP `disassemble`, PC arrow, source/asm interleave toggle
- [ ] Registers view with per-step change highlighting
- [ ] Locals/args tree with lazy child expansion (variablesReference)
- [ ] Threads view: list all threads, switch, per-thread state

## Phase 3 — Memory engine & watch windows (raddebugger-style)
- [ ] MemoryService: DAP `readMemory` with `x/…` evaluate fallback; symbol→address resolution
- [ ] Hexdump window: hex + ascii columns, type overlays, pointer-follow navigation
- [ ] Diff highlighting: changed bytes / registers / vars between stops
- [ ] Pinned windows bound to expressions (`&player`, heap ranges), auto-refresh on stop
- [ ] Watch entries with persistent per-expression formatting (hex/dec/float/char/bin)
- [ ] Struct-over-memory rendering driven by `ptype /o` offset introspection
- [ ] Sparkline/plot windows for values sampled at each stop (ring-buffer history)

## Phase 4 — Agent-built visualization (pi integration)
- [ ] Declarative window manifests (versioned JSON schema) — the agent authoring surface
- [ ] Hot-reloading manifest directory; schema validation with precise, actionable errors
- [ ] pi tools: `create_window`, `update_window`, `read_memory`, `evaluate`, `snapshot`
- [ ] Text snapshot export of any window so the agent can perceive what it built
- [ ] Sandboxed formatter scripts (isolated VM; no fs/net/process access)
- [ ] Template library of example manifests (few-shot material for agents)
- [ ] Approval gates for side-effectful agent actions (attach, kill, memory writes)
- [ ] Documented generate → render → snapshot → refine loop for agents

## Later / stretch
- [ ] Backend abstraction so lldb-dap can sit behind the same DebuggerAPI
- [ ] Remote debugging (gdbserver) + record/replay reverse stepping
- [ ] Time-travel scratchpad: pin state snapshots, compare stops side by side
