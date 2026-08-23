# aidb

A pi-style terminal debugger TUI for C/C++ on top of `gdb --interpreter=dap`.

## Layout

- `debugger-core/` — headless debugger library (DAP client + API)
  - `src/dap-client.ts` — speaks Content-Length framed JSON to gdb's DAP interpreter; owns lifecycle events
  - `src/event-bus.ts` — typed event bus (`stopped`, `continued`, `output`, `session:*`, ...)
  - `src/repl-bridge.ts` — high-level `DebuggerAPI` built on the client (launch, breakpoints, evaluate, state)
  - `src/types.ts` — shared types
- `tui/` — interactive REPL front-end (`npm run dev` at repo root runs it)
  - native GDB-style commands (`file`, `run`, `break`, `continue`, `print`, `info`, `bt`, ...),
    slash aliases, Ctrl+P/N history, Tab path completion

## Commands

```sh
npm run build                  # build debugger-core (tsc -> dist/)
npm test                       # vitest in debugger-core
npm run typecheck --workspace aidb-tui
gcc -g -O0 example.c -o example          # sample program used in manual tests
node --import tsx test/test-debugger.mjs # manual end-to-end harness (uses ./example)
```

Run the TUI: `npm run dev` (loads a program with `file <path>` inside the REPL, then `run`).

## Inferior program output (read this before touching dap-client.ts)

GDB 15's DAP forwards inferior stdout only **lazily** (it flushes when the next
command is processed) and mangles line boundaries. To get prompt, complete,
non-duplicated output we:

1. Install an exec-wrapper before launching:
   `set exec-wrapper /bin/sh -c 'exec "$@" >FIFO 2>&1' sh`
   GDB appends the real program+args after `sh`; symbols/breakpoints are unaffected.
2. Drain the FIFO ourselves (`DapClient.pumpInferiorOutput`): complete lines are
   emitted as `output` events immediately; an unterminated tail is flushed
   ~150ms after session exit.
3. Suppress GDB's delayed console re-forwards of the same lines (rolling window
   in `handleEvent`'s `output` case).

Gotchas discovered the hard way:

- Do NOT use `set inferior-tty <fifo>`: GDB opens the FIFO too and steals bytes.
- With an exec-wrapper, GDB emits exited/terminated at **every exec boundary**
  (the pre-exec shell image dies). Exits are therefore debounced 120ms and
  cancelled on life signs (`scheduleExit`).
- Programs using plain `printf` without `fflush`/`setvbuf` still buffer output
  when stdout is a pipe (glibc full buffering); that is inherent, same as real gdb.

## Conventions

- No commits unless asked; keep commits small and topical.
- `.gitignore` covers build artifacts (`dist`, compiled samples like `/example`,
  `test/test`) and local planning docs (`*.html`).
