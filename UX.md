# aidb — Finished UX API & TODO

Goal: make the command surface as small as possible while keeping
workspaces / sessions / targets / layouts. Governing doctrine:

> **There are only two kinds of commands, and each has its own rule.**
>
> - **Navigation nouns** (things you *store and browse*): `session`, `layout`,
>   `target`, `pane`. Rule: bare → finder, one operand → direct action.
> - **Construction verbs** (things you *do* that take real parameters):
>   `run`, `break`, `print`, ... Rule: flat, top-level, **never**
>   plugged into a modal, never given subcommands.

Everything else follows from these two rules.

---

## 1 · Command categories

| kind | commands | rule | modal? |
|---|---|---|---|
| **Debugger verbs** | `run attach break remove continue next step finish print set stack locals info` | flat + aliases | never |
| **navigation nouns** | `session layout target pane` | bare → finder · `save` only sub-verb | yes |
| **Universal actions** | `new help quit open settings` | flat, no operands needed | partially |
| **Passthrough** | everything unknown → gdb verbatim | never special-cased | no |

---

## 2 · The one grammar rule (flattening)

Every **navigation noun** obeys the same law, so the user learns it once:

```
/noun                → (bare) opens the finder over saved instances
/noun <name>          → acts on that one instance (switch / restore / load)
/noun save <name>     → the ONLY argument-carrying form (naming needs typing)
```

The finder's **footer keys are constant across all nouns** and never fight
the type-to-filter input:

```
↵ open/restore · ^s save current… · ^r rename · ^d delete · Esc
```

Delete-all extra subcommands (`list switch status label name resume clear
new delete`) — their jobs fold into the finder + footer:

| gone today | becomes |
|---|---|
| `/session list` | bare `/session` finder (the finder *is* the list) |
| `/session switch <n>` | `/session <n>` or pick with Enter |
| `/session label <n>` · `/name` | `^r` in the picker |
| `/session delete` | `^d` (twice = confirm) |
| `/session new` | `/new` |
| `/target status` | status bar (not a command) |
| `/target clear` | `/new` |
| `/layout list/switch/status/new/delete` | finder + `^s`/`^r`/`^d` + `/new` |

**Completer rule:** a noun's argument completer completes *instance names*,
never subcommand words. So the completer and the picker are the same list —
one source of truth in `slash.ts`.

---

## 3 · Keyboard shortcuts (super minimal)

**No per-topic shortcut rubble. We ship exactly four non-typing keys:**

| binding | action |
|---|---|
| `Alt-O` | `/open` — the single combined finder |
| `Alt-S` | settings catalog |
| `Tab` | completion (existing) |
| `↑`/`↓` on empty prompt | history (existing) |

**Deleted shortcuts (didn't know what they did either):** `Alt-R` (sessions
finder) and any other Alt-chord except `Alt-O` / `Alt-S`. One entry chord
(`/open`) is the rule. Anything a key used to do, the corresponding `/noun`
does.

> Principle: if a chord has a *single plausible meaning* it can exist. If a
> user can't guess it from the task, it must not exist. Panes stay
> mouse/prompt-driven; they never capture keys.

---

## 4 · `/open` — the single "everything saved" surface

One centered finder, grouped as sections, one fuzzy pass **across** groups:

```
┌─ open — sessions · layouts · targets ─────────────┐
│  filter: m▌                                      │
│  sessions                                        │
│  ▸ memleak ✳   bug1·code-watch · bp 3 · 2m ago    │
│    race         game·code-watch · bp 2 · 1h ago   │
│  layouts                                         │
│    code-watch   3 panes · 2 watch                 │
│  targets                                         │
│    mem          ./memleak --size 64               │
│    game         ./game --seed 42                  │
├─ ↵ open · ^s save current… · ^r rename · ^d delete ┤
└───────────────────────────────────────────────────┘
```

- This replaces `/workspace` (which is **deleted** — it meant three
  different things and only ever dumped what this finder lets you pick).
- Enter semantics by group: **session** restores · **layout** applies ·
  **target** loads symbols (never auto-runs).
- **Empty states teach the create-verbs.** With nothing saved, show
  unselectable rows:
  ```
  no saved sessions
    run ./program --args         load + start a program (auto-saves a target)
    /layout save <name>        save the current pane arrangement
    /new                       fresh session
  ```

---

## 5 · The modal = finder of instances, not a menu of instructions

The rule that prevents a help-maze:

> The picker shows **actual saved instances** (names). "What can you do" is
> one constant footer line (`↵ restore · ^s save · ^r rename · ^d delete`),
> never a descriptive submenu. Enter acts on a named thing. Nothing that
> isn't a distinct stored concept becomes a picker row.

---

## 6 · One start verb: `run`

The most confusing cluster is `file` / `run` / `launch` / `target <prog>` all
overlapping to select + start a program with four different syntaxes. The
user's call: **`run` just starts your target.** Collapse everything into one
verb:

```
run   <program> [args…]     the ONE start verb: select + spawn in one shot
run   [args…]               bare → restart the last-selected program
attach <pid>                (separate, see below)
/new                        unselect → fresh session
```

### What disappears

| today | after |
|---|---|
| `file <prog>` | `run <prog>` |
| `launch <prog> [args]` | `run <prog> [args]` |
| `run <prog>` | `run <prog>` (kept — now does select + start) |
| `target <prog>` (select) | dies — `target`'s only job becomes **stored profiles** |
| `target clear` | `/new` |

- One verb does the whole act: `run <prog> [args…]` names the program, loads
  symbols, and starts it — no separate selection step to learn.
- `run` alone (no args) restarts the last program (matches the existing
  `lastLaunch`).
- `target <name>` keeps its **profile** meaning only: switch a *saved*
  target profile via the `/open` finder. `target` never selects a program.
- `file` / `launch` may survive one release as invisible aliases for muscle
  memory; completion never suggests them.

### `attach` stays a separate flat verb — why

`attach` and `target` feel the same because both end at "I am debugging a
process", but they arrive by **opposite routes**:

- **`run <prog>`** — the debugger *spawns* a process from program + args. GDB
  owns its whole life (start / stop / restart) — which is exactly why aidb
  can install its exec-wrapper/fIFO to harvest stdout.
- **`attach <pid>`** — the process *already exists* (someone else started it).
  GDB connects by PID: no program path, no args, no exec-wrapper, no
  run-to-breakpoint lifecycle. You can only pause / step / inspect what's
  already running.

Same destination, opposite origin (create vs. grab). `attach` can't be
folded into `run` (run *creates* a process; attach *grabs* one), and its
mechanism doesn't route through the FIFO output-shim at all. It's also rare. So:

> Keep `attach <pid>` as its own single flat verb. It is not sub-commandable,
> it carries one operand, and one extra verb costs less than the confusion of
> hiding a different mechanism. If it never gets used, it costs nothing.

---

## 7 · `help` vs `/help`, and the passthrough rule

The `help` vs `/help` duplication is a symptom of **two dispatchers** that
should be one. Today a *slash* command table and a *bare* GDB command table
could disagree on what exists (e.g. `status`/`locals`/`stack` only exist as
slash; `help` works both ways; `target` only as slash). Unify.

### 7a. One dispatcher

- There is **no `/` special-casing for commands you name yourself.**
  Aidb's own commands live in one registry (`slash.ts`); GDB's dialect is a
  separate namespace it maps into.
- **`help` (no slash) is the noun, and `/help` just works** because the
  legacy slash alias route forwards it — but they must render identical
  output. Kill the "topic" path or make it a picker (below).

### 7b. `help` shows a *finder*, not a wall

Nothing a user must "know before acting" should be a printout to read then
re-type. Make `help` a centered finder of `topics`, so discovery is free:

```
┌─ help — type to filter ─────────────────────┐
│  filter: w▌                                 │
│  run        start/restart the program       │
│  win        split/closes panes              │
│  workspace  saved sessions·layouts·targets  │
│  watch      pin expressions to a pane       │
│  config     theme, gdb, keybindings         │
│  quit                                       │
├─ ↵ show topic · Esc ─────────────────────────┤
└──────────────────────────────────────────────┘
```

One row = one register entry (`slash.ts`), one description. ⏎ prints that
topic's sheet through the existing `showHelp`. `help `…` <tab>` completes
topic names from the same registry.

### 7c. Only *your* verbs get help rows

GDB-native things the user may already know (`pwd`, `x/4xw`,
`disassemble`) go to passthrough and are **not** in the help finder. The
help finder's job: "what does *aidb* add on top of GDB?" — and finally, the
answer is: **one combined finder, three noun verbs, one settings catalog, a
few flat debug verbs, and a passthrough.** That's the whole pitch.

### 7d. Consistency test

```
help        → help finder
/help       → same help finder        (identical)
help win    → win topic sheet         (or a row in the finder)
/help win   → identical
```

---

## 8 · Settings (not a pane)

- `/settings` (bare → finder, `Alt-S`) is the catalog: theme · keybindings ·
  gdb · sessions · defaults + actions (`reload config`, open `~/.aidbrc`,
  open `./.aidb.json`).
- **`SettingsBinding` as a live pane is deleted** (same as `workspace`).
  Panes are debug visuals only: watch · regs · mem · plot · tree · source ·
  asm · iasm.

---

## 9 · Final command surface (the whole API)

Debugger verbs (flat): `run attach break remove continue next step finish
print set stack locals info`.

Navigation nouns (fork grammar): `session layout target pane`.

Universal: `new quit help open settings`.

Passthrough: anything else → gdb.

```
run    <program> [args…]   select + spawn a program (the ONE start verb)
run    [args…]             restart the last-selected program
attach <pid>               attach to an already-running process
break  <loc> [if cond]     set a breakpoint
remove [id…]               remove breakpoint(s)
continue next step finish  execution control
print  <expr>              evaluate in current frame
set    <var> = <val>       assign in current frame
stack locals info          frame inspection
/new                       fresh session (clears selection)
/help                      help finder
/quit                      exit
/open                       one finder over sessions·layouts·targets  [Alt-O]
/settings                  settings catalog                          [Alt-S]
/session  [name] | save <name>         finder | restore | save
/layout   [name] | save <name>         finder | apply  | save
/target   [name]                       finder | select profile
pane/win  sub…                          finder + splits
```

---

## TODO — implementation status

> Last updated after the command-surface rewrite. `[x]` = done, `[~]` = kept
> simpler than the plan (documented), `[ ]` = not yet.

### Phase A · Kill clutter nouns
- [x] Deleted `views/workspace.ts`, `WorkspaceBinding`, `/workspace`, viz
      `workspace`/`settings` bindings, intro "workspace", `workspace.test.ts`.
- [x] Deleted `SettingsBinding` as a live pane; **kept** `renderSettings()`
      for the `/settings` command.
- [x] Moved `relativeTime` → `picker.ts`.

### Phase B · One grammar / flatten nouns
- [x] Flatten `session` → `save` only; bare opens finder; `<name>` restores;
      completer lists session *names*.
- [x] Flatten `layout` identically.
- [x] Flatten `target` → bare finder, `<name>` → open profile, `save`.
- [x] Removed `/resume`, `/name`, `/workspace`, and all
      `list|switch|status|label|name|args|clear|new` sub-verbs.
- [x] `ctrl+d` delete (twice=confirm) + `ctrl+r` rename in `picker.ts`.
- [~] Saving current = the `+ create` row (`Enter` on a fresh name) rather than
      a separate `^s` + `prefillEditor` host capability — fewer keystrokes.
- [x] `switch` kept as an invisible alias (`/session switch <n>`).

### Phase C · `/open` + settings
- [x] `/open` (Alt-O): sessions·layouts·targets finder, single fuzzy pass
      (kind tags in the labels), Enter opens the right one, empty state points
      at the create verbs.
- [~] `/settings` stays a plain command that prints the config (no catalog
      picker / Alt-S chord yet).
- [x] Deleted **all** Alt-chords except Alt-O (Alt-R removed).
- [x] Defaults, `ACTIONS`, `ACTION_LABELS`, settings render, intro keys line
      updated for the new `open` action.

### Phase D · One start verb
- [x] `run <prog> [args…]` = the ONE start verb (select + spawn + load symbols).
- [x] `run` bare restarts the last program.
- [x] `file` / `launch` kept as hidden aliases that route to `run`; not in the
      completion registry.
- [x] `target`'s sole job = **stored profiles**; `target <prog>` selection dies.
- [x] `attach <pid>` kept as its own flat verb.
- [x] `/new` = the single unselect / fresh-slate verb (`target clear` dies).

### Phase E · One help + one command surface
- [x] `help` == `/help` (both already routed through `showHelp`; identical).
- [~] HELP rewritten around the new verbs; `workspace`/`resume`/`launch`
      references dropped. (**Kept** the text sheet; a `help` *finder* is polish.)
- [x] Intro banner: `[session] fresh session`; tip points at Alt-O.
- [x] Passthrough preserved: unknown words go to gdb verbatim.

### Phase F · Remaining polish
- [ ] `help` as a topic *finder* fed by `slash.ts` (not just a text sheet).
- [ ] `/settings` as a catalog picker (sections + `reload config` / open rc).
- [ ] Grouped picker sections in `picker.ts` (currently `/open` uses kind tags
      in labels instead of real section headers).
- [ ] Empty-state picker rows teach the 3 create-verbs verbatim.
- [ ] `/"list"` sweep — confirm no subcommand named "list" anywhere.
- [ ] Grace alias (`switch`, `launch`) documented for one release.

Verification targets (current): `rg -i workspace` ≈ 0 in `tui/src` ·
`rg 'alt\+r|sessionPicker'` = 0 · typecheck clean · `251/251` TUI tests green.
