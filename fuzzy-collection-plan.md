# Plan: fuzzy-finder UX for list collections (`/layout`, `/session`, `/target`, ...)

## Goal

Turn every "named collection" slash command into a class of commands with one
unified UX: **bare `/command` opens a fuzzy finder**. No more
`/layout list` → `/layout switch <name>` → `/layout save <name>` round-trips.

```
/layout
  │  ┌───────────────────────────────────────┐
  │  │  ┌─ switch layout ───────────────────┐ │
  │  │  │ filter: mydebug█                  │ │
  │  │  │  mydebug   4 panes · 2 watch      │ │
  │  │  │  debug    6 panes · 1 watch       │ │
  │  │  │+ create new layout "mydebug"      │ │
  │  │  │ ↑/↓ move · Enter pick · ctrl+d del│ │
  │  │  └───────────────────────────────────┘ │
  │  └───────────────────────────────────────┘
```

- Typing narrows fuzzy; the input area starts empty.
- Enter on an **existing** item performs the "select" action (restore/switch).
- Typing a name that **doesn't exist** surfaces a `+ create new layout <name>`
  row; Enter on it *creates*, no separate `save` verb needed.
- Deletion handled inside the picker (see [Deletion](#deletion) — open design
  question, recommendation included).

## Collections in scope

| bare command | items            | Enter (existing)      | Enter on create row              | delete |
|--------------|------------------|-----------------------|----------------------------------|--------|
| `/layout`    | saved layouts    | `/layout switch <n>`  | save current panes/watch as `<n>` (`/layout save <n>`) | yes |
| `/session`   | saved sessions   | `/session switch <n>` | fresh session named `<n>` (`/session new <n>`) | yes |
| `/target`    | target profiles  | `/target switch <n>`  | name the live target `<n>` (`/target name <n>`, only when a live target exists) | yes |
| `/win switch`| panes (existing) | switch pane           | — (no create)                        | no  |
| `/resume`    | sessions alias   | switch session        | fresh session named `<n>`            | yes |

`/workspace` stays the map view — it renders a graph, it isn't an item list.
(If desired later, it could gain a picker over sessions filtered by target;
out of scope.)

Subcommands do **not** disappear: `/layout list|save|switch|delete|new ...`,
`/session ...`, `/target ...` remain for scripted/power use. The picker is the
primary path; subcommands are the explicit fallback. `list` keeps working for
a transcript-style dump.

## Design

### 1. `picker.ts` — generalize `openPicker`

Add to `PickerOptions`:

```ts
interface PickerOptions {
  title: string;
  items: PickerItem[];
  onPick(item: PickerItem): void;
  onCancel?(): void;
  onCreate?(query: string): void;        // new
  createLabel?(query: string): string;    // new — default "create new"
  onDelete?(item: PickerItem): void;      // new
}
```

**Create row.** While `onCreate` is set:

- Append a selectable pseudo-row to the SelectList whenever the filter is
  non-empty **and no item label equals it** (case-insensitive).
  Value sentinel `"__create__"`, label `+ create new <title-term> "<query>"`
  (e.g. `+ create new layout "mydebug"`), styled with `colors.accent`.
- Selection rules:
  - Filter has an exact match → that row is highlighted; create row is either
    absent or shown dimmed below (prefer: show it, one `↓` away — same as
    VS Code palette / Telescope).
  - Filter has **zero** fuzzy matches → auto-select the create row so Enter
    creates immediately (the fast path for "I know the name I want").
  - `onPick` routes the sentinel to `onCreate(filter)` instead of `onPick`.
- **Empty-list guard changes**: today `openPicker` cancels immediately when
  `items.length === 0`. With `onCreate` set, it must open anyway (empty list +
  typed name = pure create flow, e.g. first-ever layout).

**Filter case.** Today the filter is lowercased character-by-character, so a
created name would be force-lowercased. Keep the raw typed filter for
`onCreate`/label; pass a lowercased copy into `fuzzyFilter` matching. Names
preserve user casing.

**Footer hints.** A muted bottom row advertising the keys:
`↑/↓ move · Enter pick · ctrl+d delete · Esc cancel` (delete hint only when
`onDelete` set).

### 2. Deletion

Options (the open question):

- **A. In-picker, with inline confirm (recommended).** `ctrl+d` on a
  highlighted existing item enters a confirm state inside the overlay: footer
  becomes `delete "mydebug"? Enter to confirm · Esc to cancel`; Enter →
  `onDelete(item)` + close; Esc → back to browsing. Nothing else about the
  picker changes. Risk of accidental deletion is bounded by the confirm step;
  the key is already fully owned by the picker while open, so no new input
  plumbing.
- **B. Delete-on-key, no confirm.** `ctrl+d` deletes immediately. Fastest, but
  one mis-key destroys a profile — reject unless the user wants it.
- **C. No delete in picker; keep explicit subcommands only.** Safest, but
  leaves the core annoyance (`delete` still needs `/layout delete <name>` with
  its own arity/tab-completion quirks) and fails the "one surface for lists"
  goal.

Also decide, per collection:
- Delete is **only offered for saved items**; on the create row `ctrl+d` is a
  no-op.
- Deleting an in-use profile (a layout referenced by sessions) keeps current
  semantics (`JsonStore.remove` just drops the file; referrers go stale). The
  confirm state can show `(used by 2 sessions)` as a soft warning — nice, and
  cheap since `list()` metadata already carries target/layout refs.
- Deleting the **active/current** profile is allowed, matching today's
  `/layout delete` parity.

### 3. `repl.ts` — one generic collection picker

Replace the three hand-rolled pickers (`openSessionPicker`, `openLayoutPicker`,
`openTargetPicker`) with one table-driven helper:

```ts
interface CollectionSpec {
  command: string;                       // "/layout"
  title: string;                         // "switch layout"
  term: string;                          // "layout" — for the create label
  items(ctx: ReplContext): PickerItem[]; // label w/ " ✳" + description
  onPick(ctx: ReplContext, item: PickerItem): void;      // restore/switch/load
  canCreate?(ctx: ReplContext): boolean;                 // e.g. target needs a live target
  onCreate(ctx: ReplContext, name: string): void;        // save | new | name
  canDelete?(ctx: ReplContext, item: PickerItem): boolean; // false when item is implicit
  onDelete(ctx: ReplContext, item: PickerItem): void;
  echo(pickedLine: string): void;        // the `› /layout switch <name>` transcript line
}
```

- **`/layout` bare** → `openCollectionPicker(LAYOUTS)`.
  - create = save the current split-tree + watch panes under the typed name
    (`hooks.layouts.save(name)`), echoing `› /layout save <name>`.
    Rationale: you're *in* a layout you want to keep; "create" = "make a
    profile of what I have". (Alternative: "create" = collapsed single-pane
    `default`, the old `/layout new` semantics — recommend save-current but
    flag it for the user.)
  - delete = `hooks.layouts.remove(name)`.
- **`/session` bare** → `openCollectionPicker(SESSIONS)`.
  - create = `hooks.startNew(name)` (same as `/session new <name>` / `/new`),
    echoing `› /session new <name>`.
  - delete = `hooks.remove(name)`.
- **`/target` bare** → `openCollectionPicker(TARGETS)`.
  - create = `hooks.targets.save(name)` (name the *live* target; gate
    `canCreate` on a live target existing) — echoing `› /target name <name>`.
  - delete = `hooks.targets.remove(name)`.
- `openPanePicker` stays as a non-creatable instance of the same helper.

**Bare-command dispatch** in `handleSlashCommand`: the `!first ||
first === "status"` branches of `handleLayout` / `handleSession` / `handleTarget`
change so **bare** (no sub) opens the picker; `status` keeps the old inline
status as an explicit subcommand. `list` subcommand unchanged.

**`isBarePickerCommand`** (main.ts — controls transcript echo + history rules)
grows: `/layout`, `/session`, `/target` (bare), keeping `/resume`, `/win
switch`, and the existing `* switch`/`* resume` forms (they can all bottom out
in the same collection picker — `/layout switch` bare == `/layout` bare).

### 4. `slash.ts` + help text

- Keep the subcommand completers as-is (`layoutCompletion`, `sessionCompletion`,
  `targetCompletion` — subcommands still valid). Optional, deferred: complete
  profile *names* as a first token too; skip for now to avoid ambiguity with
  subcommand words (`/layout save ⏎` would be ambiguous between "layout named
  save" and "subcommand save").
- Update help strings in `repl.ts` (`HELP`, the `/session`/`/target`/
  `/layout` doc comments, and `/workspace` blurb) to describe the picker-first
  flow: *"bare `/layout` opens a fuzzy picker — pick to switch, type a new
  name to create, ctrl+d to delete."*

## Implementation steps

**Phase 1 — `picker.ts`**
1. `PickerOptions` gets `onCreate` / `createLabel` / `onDelete`.
2. Create-row logic: sentinel item, exact-match suppression, auto-select on
   zero matches, accent styling, footer hints.
3. Empty-list guard: open when `onCreate` is set.
4. Preserve filter case for create names (lowercase only for fuzzy matching).
5. ctrl+d delete flow with inline confirm state (footer swap, Enter/Esc).
6. Extend `picker.test.ts` (below).

**Phase 2 — `repl.ts` + `main.ts`**
7. `CollectionSpec` + `openCollectionPicker`; migrate the three pickers.
8. Bare `/layout`, `/session`, `/target` → picker; keep `status`/`list` subs.
9. `isBarePickerCommand` additions.
10. Update help text + doc comments.

**Phase 3 — tests & verification**
11. `npm test` (debugger-core), `npm run typecheck --workspace aidb-tui`,
    `npm run build`.
12. Manual: `npm run dev` → `/layout` switch/create/delete, `/session`,
    `/target`, Esc at each stage, history/echo sanity.

## Tests

`tui/test/picker.test.ts` (unit — fake host, as today):
- create row renders as `+ create new layout "<query>"` when filter is
  non-empty and no exact match; absent on exact match.
- zero fuzzy matches → create row auto-selected; Enter → `onCreate(query)`.
- fuzzy matches + no exact match → first match highlighted, `↓`+Enter →
  `onCreate` (or `onPick` for the match).
- empty item list **with** `onCreate` opens; empty without still cancels.
- ctrl+d → confirm state shows; Enter deletes selected + closes; Esc returns
  to browsing without deleting; ctrl+d on create row is a no-op.
- case: typed `MyLayout` (capital) reaches `onCreate("MyLayout")` while the
  filter still narrows case-insensitively.

`tui/test/picker.test.ts` (integration, `/resume`-style harness):
- bare `/layout` opens the picker; pick restores (`layouts.load` spy);
  type `newone` + Enter → `layouts.save("newone")` + echo `› /layout save newone`;
  ctrl+d+Enter deletes the selected layout.
- bare `/session` picks `/session switch <name>`; bare `/target` on a live
  target names it. `slash.test.ts` keeps passing (completers untouched).

## Open questions for the user

1. **Deletion** — confirm option A (ctrl+d + inline confirm) vs B/C.
2. **Layout "create"** — save-current-under-name (recommended) vs fresh
   single-pane `default` (old `/layout new` semantics).
3. **Session "create"** — fresh session (`/session new`) vs save-current-session
   snapshot under a new name (`/session save <name>`). `new` resets the live
   target, which may surprise; `save` is non-destructive.
4. Delete confirm soft-warning "(used by N sessions)" — include or not?