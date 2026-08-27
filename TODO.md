# TODO

- pi has a spinner that says Waiting while it is waiting on the model. it would be nice to have one that specifies state of the app. 

## Phase 0 — Hardening (do this before anything else)
- [x] DAP wire tracing: ring-buffer log of all frames in/out, `aidb --trace-dap` dump
- [x] GDB crash recovery: detect death mid-session, restart cleanly, re-bind breakpoints
- [x] Bounded frame-parse buffer + backpressure-safe stdin writes in DapClient
- [x] Feature-gate requests on initialize capabilities (readMemory, disassemble, ...)
- [x] Roll back state machine when a request fails (never stick in "running")
- [x] Per-stop caches for stack/scopes (today getStack() fires redundantly) + real frame selection for up/down
- [x] Match breakpoint sync results by line, not array index
- [x] Clean shutdown on every path: await gdb exit, FIFO/tmpdir cleanup, no zombies
- [ ] In-process fake gdb (mock DAP server) so vitest covers client/bridge without spawning gdb
- [x] Fuzz tests for the Content-Length frame parser (garbage, split, oversized)
- [x] Race tests for exit-debounce / exec-boundary / relaunch heuristics
- [ ] Golden-file tests for TUI rendering
- [x] Perf benchmarks: initial step/command latency suite (see benchmark-plan.html)
- [ ] Perf benchmarks: giant frames and large memory reads
- [x] Typed error taxonomy: core errors vs gdb passthrough, surfaced uniformly in TUI

## Phase 1 — Ergonomics
- [ ] Distinct colors: user input vs program stdout vs gdb console vs errors (theme.ts)
- [ ] Layered config: ~/.aidbrc + ./.aidb.json (theme, gdbPath, keybindings, defaults)
        - config is data, not commands — sections:
          `theme` (colors), `gdb` (path/args/env), `keybindings` (action → chords),
          `defaults` (break style, step behavior), `sessions` (history/persistence paths),
          `windows` (layout presets, manifest dir, refresh policy),
          `agent` (tool permissions, approval gates)
- [ ] Remappable keybindings (loaded from config)
- [x] State-aware activity spinner (pi-style, not just "Waiting"): label reflects what aidb is
      actually doing — `launching gdb`, `waiting for breakpoint hit (pid 4242)`,
      `reading 256B @ &player`, `restarting after crash` — driven by session state +
      the in-flight request queue; a spinner that never advances also exposes hung requests
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
- [x] 4. Shared view base class — the reason vim keys work everywhere:
      every pane = same underlying structure (content lines + cursor + scroll state);
      base owns scrolling/cursor/clipping, views only supply `content()` + select hooks (~100 lines each)
- [x] 5. Swap visualization in place: `/win load <id>` and `/win pick` on a live pane
- [x] 6. Blank watch pane UX: `o` add expression inline, Enter refresh, `d` delete entry
- [ ] 7. Views: source (#3), assembly (#4), registers (#5), locals tree w/ lazy children, threads
- [ ] 8. `/tree` stop-history browser: snapshot every stop (frames, vars, regs, watched bytes);
      browse past commands/stops and view their cached state read-only — no rewind, but no amnesia
      (opens in a pane like any other view — the layout tree makes it free)
- [ ] 9. Persist the layout tree + per-view state with sessions (P1)
- [x] Source view: current-line marker, breakpoint markers
- [x] Source view: conservative syntax coloring (replace with semantic/LSP spans later)
- [ ] Assembly view: DAP `disassemble`, PC arrow, source/asm interleave toggle
- [x] Registers view with per-step change highlighting
- [ ] Locals/args tree with lazy child expansion (variablesReference)
- [ ] Threads view: list all threads, switch, per-thread state

## Phase 3 — Memory engine & watch windows (raddebugger-style)
- [x] MemoryService: DAP `readMemory` with `x/…` evaluate fallback; symbol→address resolution
- [x] Hexdump window: adaptive hex + ascii columns
- [x] Diff highlighting: changed bytes / registers / vars between stops
- [x] Pinned windows bound to expressions (`&player`, heap ranges), auto-refresh on stop
- [ ] Watch entries with persistent per-expression formatting (hex/dec/float/char/bin)
- [ ] Struct-over-memory rendering driven by `ptype /o` offset introspection
- [x] Sparkline/plot windows for values sampled at each stop (ring-buffer history)

## Phase 4 — Agent-built visualization (pi integration)
- [ ] Declarative window manifests (versioned JSON schema) — the agent authoring surface
- [ ] Hot-reloading manifest directory; schema validation with precise, actionable errors
- [ ] pi tools: `create_window`, `update_window`, `read_memory`, `evaluate`, `snapshot`
- [ ] Text snapshot export of any window so the agent can perceive what it built
- [ ] Sandboxed formatter scripts (isolated VM; no fs/net/process access)
- [ ] Template library of example manifests (few-shot material for agents)
- [ ] Approval gates for side-effectful agent actions (attach, kill, memory writes)
- [ ] Documented generate → render → snapshot → refine loop for agents

## Visualization (VISUALIZE_PLAN.md)

### Done
- [x] Phase 0–4: fixtures, observation bindings, capability renderers, byte-oriented renderers
- [x] Phase 5: watch entries use ExpressionBinding + RenderSpec (default `lines` renderer)
- [x] Phase A: document `mem <expr> [bytes]` — suffix is raw byte count, default 192

### Deferred — memory load sizing
- [ ] **B** — explicit tuple suffix syntax (`mem frame 4t3` → 4 tuples × 3 bytes)
- [ ] **C** — type-aware default byte counts from GDB `type` metadata (`Pixel [4]` → 12 bytes)
- [ ] **D** — full renderer-driven refetch on `/win pick` and watch entry renderer changes (partial: watch `setRenderSpec` refetches when budget grows)

### Up next
- [x] Phase 6: RenderSpec bitflags, `/win pick` options, renderer cycling keybinding, AI-facing registry export
- [ ] Phase 7: AI inspection/scaffold tools, golden fixtures, plugin boundary

## Later / stretch
- [ ] Backend abstraction so lldb-dap can sit behind the same DebuggerAPI
- [ ] Remote debugging (gdbserver) + record/replay reverse stepping
- [ ] Time-travel scratchpad: pin state snapshots, compare stops side by side


- testing strategy: 
once we get AI integration, the AI will be able to run the debugger and visualize the screen 
we can enumerate every single feature and what it should look like. then, we can create an ai swarm 
to try each of the features in random orders (need a graph of dependent features; test both valid graphs and invalid graphs)
we can try on different OSs with different versions with differenet screen sizes. 
- we can also task the AI to create a certain visualization and check output. 
- the watch windows are nice, but ideally would like to create better output visuzlations.

ISSUES: 
- Auto complete on tab even when not relevant
- cannot scoll repl


LATER: 

- [ ] Vim-style modal input: NORMAL/INSERT modes (Esc/i/v), j·k·g·G / Ctrl+d·u scroll,
      `:` ex-style commands; arrows = history only while the prompt is focused
- [ ] colors: raddbg has colors that matches source code to assembly. it might be nice to color coordinate the asm based on dependencies
- [ ] would like Enter to replay the previous command, like in gdb
- going to prev with ctrl+p should put sursor at the end

- [ ] Source/assembly visualizer: add an interleaved view that groups assembly
      instructions beneath their source lines; later add a toggle between the
      current separate panes and the interleaved view.

- gdb features are missing. like si 2 to go si twice
- asm is not rendered ideally? maybe add some spacing? gdb make clear distinction between src and func name
- if source file changes since last build, we should notify
- better pane navigation/controls/resizing/etc... i like how herdr does it, but i can't really have that be the same, can I? maybe i can with a diff prefix?
