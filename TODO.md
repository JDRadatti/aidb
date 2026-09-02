# TODO
- improve ux/readability/colors and spacing between things. related things should be grouped together and not related things should be separated by a line. 
- sessions should maybe be forced saved as well?
- open new files.
- embed nvim?
- what happens when we resume a non-exisstent session
- breakpoint extends to all assembly llanguage under a source line.
- on llm changes, we should have a git diff that we can step thorough. llm should be able to 
- mmaybe in the future this would be good: 1. prompt the llm to make a fix. they will do so then they set up a debug session that you can step through.
- for example, it could walk you through a bug (show you the data 
- each change could also do data diffs or just correlate the data with what was just changed (maybe the data that touches the diff should be also diffed)
- prompt hints for state assertions and expectations when stepping.
- locals watch mode
- remove address of assmbly
- search through current buffer with /


# NEXT — do these first
1. Whole-memory pane: a `mem` view that renders a paged window over all of
   program memory (base address + scroll/navigation) instead of a single
   address.

# PLANNING
- fuzzy find files (open any file by fuzzy name/path)
- session tags (release number, commit, gh issue, ...)
- build tool?
- whole-memory pane (mem of the program, not one address) → NEXT 1
- better pane navigation/controls/resizing (herdr-style? diff prefix?)
- more gdb features?

# ISSUES
- mem pane showing all of the program's memory, no address required → NEXT 1

# DONE — watch visualizations (per-type renderers + value formatting, was NEXT 1)
- `/watch <expr>` AUTO-picks a renderer from the snapshot's type on the first
  fetch: structs→`struct-tree`, `T[N]`/std::vector/std::array→`array`, while
  C strings (`char *`, `char [N]`, std::string) and pointers stay on the
  formatted `lines` value. One manual `/watch cycle`/`/watch flag` pins the
  choice; restored sessions never re-dispatch.
- watch entries render MULTI-LINE BLOCKS: a struct tree indents under its
  root line (`> p = struct Player = 0x… {hp = 99, …}` + ├─ children), an
  array list wraps at the pane width — pretty-printed in the watch pane
  itself, not a single mangled to-string. Cursor ops (`d`/Enter) select the
  whole entry via a row→entry map; stale-row drift after block growth is
  re-anchored on refresh.
- `formatValue` per-type scalar formatting (tui/src/viz/format.ts, pure +
  golden-tested): char glyphs (`104 'h'`), `_Bool`/bool 0|1→true/false, float
  rounding (3.1400000000000001→3.14), whitespace collapse, truncation;
  char-array values drop nul padding AND gdb's repeat elision
  (`"hey", '\000' <repeats 12 times>`→`"hey"`). Applied by the `lines`
  renderer and the struct-tree's leaf values.
- struct-tree summarizes aggregate nodes gdb left with an empty/address
  value: `0x7fff… {hp = 99, pos = {…}, name = "hey"}`; nested scalars format
  per type; leaves that differ from the previous stop keep the ▲ marker.
- new `array` renderer (watch panes + `/win load <pane> array <expr>`,
  slash completion + help updated): `int[4] {10, 20, 30, 40}`, wraps at the
  pane width, `… N more` tail at the pane height, changed elements marked;
  std::vector types shorten to `std::vector<…> · N elements`.
- ExpressionBinding snapshots now carry an eager depth-2 / 64-node child
  tree when a variablesReference exists (shared expansion with TreeBinding),
  so dispatch + pretty summaries need no extra fetch round-trips.
- tests: viz-format.test.ts (formatValue rules), renderArray + summary tests,
  ExpressionBinding tree tests, watch auto-dispatch/pinning/multi-line tests —
  real-gdb smoke test at test/smoke-watch.mjs.
- WATCH LOCALS: `/win load <pane> locals` binds a live frame-locals pane
  (LocalsBinding + struct-tree): args group + locals flat, nested structs /
  arrays expand eagerly (shared budget, depth 2 / 160 nodes), per-type value
  formatting and empty/not-stopped fallbacks. Re-fetches on every stop, so it
  tracks the frame the debugger moves through — `info locals` as a watch pane.
  Persists in layouts (PaneBindingSpec `{kind:"locals"}` + session-store
  default interpreter), slash completions + help updated. Core's existing
  `getVariables(scope)` is surfaced as `FetchCtx.getFrameVariables`.
- FIXED: `/watch p` on a C++ struct showed `—` (bare class type `Player`,
  no `struct` keyword). dispatchRenderer keyed on the struct/class/union
  keyword, so bare C++ aggregate types fell through to raw `lines`, which
  formats an empty aggregate as `—`. Dispatch now falls back to struct-tree
  for ANY aggregate with children (strings/pointers/std::vector|array still
  take their dedicated paths) — actual gdb: `> p = Player = {x = 99, y = {…},
  z = "hi"}` with the ├─ tree beneath. Regression test in watch.test.ts.
- lowdown: the old watch `add()` never parked the cursor on the new entry
  (stale lineCount from the content cache stuck it at 0); the rewrite makes
  the documented intent true (cursor follows the added entry), and the old
  `d deletes` test encoded the bug — updated to assert the real behavior.

# DECIDED
- layout watch windows are not saved when canceling/reopening: sessions keep
  referencing the named layout; only explicit `/layout save` persists.

# TESTING STRATEGY
- once we get AI integration, the AI will be able to run the debugger and visualize the screen
  we can enumerate every single feature and what it should look like. then, we can create an ai swarm
  to try each of the features in random orders (need a graph of dependent features; test both valid graphs and invalid graphs)
  we can try on different OSs with different versions with differenet screen sizes.
- we can also task the AI to create a certain visualization and check output.
- the watch windows are nice, but ideally would like to create better output visuzlations.

# DONE — small UX batch (fresh sessions, Ctrl+L, run-confirm, gutter rail)
- `/new` is now a real fresh slate: the recall history (Ctrl+P/N) is cleared
  and the transcript is reset — the only line on screen is a compact
  `[session 'x' activated]` notice instead of the full banner re-print
  (AidbEditor.clearHistory + transcript.clear in `startNew`). Startup banner
  unchanged.
- Ctrl+L clears the transcript like bash's `clear` / cmd's `cls` (new
  `clearScreen` action, default chord `ctrl+l`, remappable, listed in
  /settings + help). Typed prompt and saved state survive.
- a confirm gate for destructive actions (the picker's Enter/Esc pattern,
  but printed in the transcript): `run` now asks when it would RESTART the
  already-started program (`restarting discards the current run`); first
  runs launch straight away. Reusable via `ctx.confirm(question, action)`.
- source/asm gutter: the vertical rail is now ONE combined `muted` column in
  the plain source view, the plain asm view (it had no pipe at all) and the
  interleaved view — line numbers/addresses stop at the same muted `│`.

# DONE — principled highlighting (option A: regex, lexer reverted)
- source/asm highlighting is per-line regex + keyword set (same shape gdb uses
  via source-highlight): one `matchAll` per line; block comments colour only
  on their terminating line (accepted, matches gdb without source-highlight).
- kind→role map lives in one switch in theme.ts (`colors.syntaxRole` /
  `colors.asmRole`), read live on /config reload.
- the original asm role bug is FIXED: the first identifier is the mnemonic
  (`mnemonic` role); later identifiers are symbols (`function` role). The old
  regex had it backwards (bold-accent on the mnemonic, magenta on operands).
- `#include`/`#define` are a preprocessor token (directive role), not a
  whole-line bold-accent shortcut.
- change-marking (`mark`, bitmap ▲) uses the live `warning` role, not a
  hard-coded `\x1b[33m`; error lines use `colors.error`.
- `readSource` caches split file lines per path (16-file LRU), so stops don't
  re-read + re-split the file. (The one kept perf win; the lexer's window
  cache was reverted with the rest of viz/syntax.ts.)
- syntax-highlighting-plan.html documents this strategy (regenerate with
  node --experimental-strip-types /tmp/gen-syntax-playground.mjs).

# DONE — named theme presets (previously NEXT 1)
- `theme: "<name>"` selects a preset in one config line; `theme: { preset:
  "<name>", accent: 9 }` layers per-role overrides on top of a preset.
  Presets are ports of herdr's classic palettes (herdr `src/app/state.rs`
  `Palette`): catppuccin (+ latte), tokyo-night (+ day), dracula, nord,
  gruvbox (+ light), one-dark (+ light), solarized (+ light), kanagawa
  (+ lotus), rose-pine (+ dawn), vesper — herdr's UI roles mapped onto aidb's
  theme.* roles, RGB converted to the nearest xterm-256 code (the `terminal`
  pass-through is omitted: aidb roles are already 256-colour codes). herdr's
  theme-name aliases (tokyonight, onedark, gruvbox-dark, dawn, ...) resolve
  via canonicalThemeName; unknown names fall back to the default palette with
  a config issue (path `theme` / `theme.preset`). /settings lists presets.

# DONE — PickCaret / ctrl-keys in the fuzzy finder
- every readline ctrl binding now works INSIDE the finder: ctrl+a/e (line
  start/end), ctrl+b/f (char left/right), alt+b/f + ctrl+left/right (word
  moves), ctrl+w/alt+d (kill word back/forward, readline whitespace intake),
  ctrl+u/k (kill to line start/end), ctrl+y (yank the last kill), backspace /
  Delete / ctrl+d delete around the caret. ctrl+d at the TYPED TAIL still
  means item-delete (readline parity: nothing to delete there).
- the block cursor in the real prompt tracks the caret (main.ts setPromptCaret).

# DONE — prompt/band framing (ui.promptZone)
- ui.promptZone: off | line | line+rail (default line: divider only — the
  left rail was dropped per user request; set \"ui\": { \"promptZone\": \"line+rail\" }
  in ~/.aidbrc to bring the rail back, or \"off\" to disable the frame).
- the line above the prompt now sits ABOVE the popups: when a dropdown/picker
  band is composite, a divider in theme.inputBorder tops the band and the
  editor's own top border is suppressed (no stacking; idle look unchanged).
- line+rail adds a left rail `│` in theme.inputBorder on the band rows AND the
  prompt line (editor lays out one column narrower; cursor stays correct).
- the overlay compensates for the suppressed top border (+2 offset while a
  framed band is up: +1 for the border's own row, +1 because the prompt climbs
  into that freed row), so the popup docks flush above the prompt instead of
  landing on it — the prompt stays visible whenever a popup is open.
- theme.inputBorder (default 240) colors the frame; /config reload re-applies
  it live. plan: prompt-band-plan.md.

# DONE — intro banner lists saved items (previously NEXT 1)
- `[sessions]` / `[targets]` / `[layouts]` tags, each followed by one
  indented line per saved item (name ✳ marks the current one, same mark as
  the pickers): sessions read `name · target · layout · bp N`, targets
  `name · ./program [args]` (or `attach pid N`), layouts `name · N panes ·
  M watch [· K live]`. Empty collections show a muted hint (auto-save off,
  no target yet, /layout save ...).
- banner trimmed to the three lists + the bare debugging verbs (run, break,
  continue, next, step, finish, print, bt, info, display, watch) + a
  `/help · /settings · \`>` — open anything saved` pointer; viz/keys/config/
  history lines dropped. /help already carried the full command sheet.

# DONE — slash hint grammar + bottom-bar tags (previously NEXT 2/3)
- `/session` hint now reads `save <name>` like target/layout (was
  `save [name]`); repl.ts doc comment updated to match.
- the bottom bar pins `[target: x] [session: y] [layout: z]` to the right
  edge (only while those names exist on disk — implicit UUID profiles count
  once saved). Left keeps state/panes/bp/location + Alt+O hint; the tags
  drop instead of wrapping when the terminal is too narrow.

# DONE — other
- fuzzy finder narrows by *name*, not group tag: `>` then typing `e` now
  filters to just the two `example` targets (5478b03). picker.ts strips SGR
  codes before matching and no longer fakes a match via the item's tag /
  decoration text.
- asm rendering: ANSI-aware column padding + a distinct `function` color role,
  interleaved gutters aligned between source and asm (3417c94).
- `display <expr>` / `undisplay <n>` / `info display` backed by the watch pane;
  display entries re-evaluate after every step (d9b944c).
- `<placeholder>` args tinted with the `placeholder` role (245) in help + the
  slash dropdown; fillKeys no longer mangles placeholders into "—" (4a73ce8).
- slash dropdown rows read `hint — description` where the description says
  what the command *does* (e.g. "saved debugger sessions"), not its args.
- new theme roles (semantic tokens, borders, placeholder, inputBorder) +
  ui.promptZone config (595c977 / f1ea869).

# Finished
- would like Enter to replay the previous command, like in gdb
- closing clears the output and prints "Resume session with: aidb -r <name>" (`-r <name>` = short alias for `--session <name>`)
- unnamed sessions/targets auto-save as noun-prefixed uuids (`session_<uuid>` / `target_<uuid>`, replacing `@<uuid>` / program-basename / "session") so they never collide and are always resume-able
- going to prev with ctrl+p (or ArrowUp) should put cursor at the end
- auto complete on tab should only fire when relevant (run/file paths, path-shaped tokens)

# performance
- memory footprint of longrunning programs
- how fast can we step through a long program
- how fast can we ctrl+up through a long long file
- startup time
- time to paint
