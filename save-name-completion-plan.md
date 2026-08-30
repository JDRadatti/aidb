# Plan: never retarget a `save` onto a fuzzy-similar profile

> ✅ Implemented: `exactSaveItems` in `tui/src/slash.ts` (save-branch routing),
> `shouldAutoSelectCreate` in `tui/src/picker.ts` (create-row bias). Both
> behaviors covered by `tui/test/slash.test.ts` + `tui/test/picker.test.ts`
> (362 tui tests pass, typecheck clean).

## The bug

```
/ layout save asm    ← user wants a NEW layout named "asm"
```

with a saved layout `iasm` on disk. Pressing Enter silently runs
`/layout save iasm` and overwrites **iasm** instead of creating **asm**.

The same coercion hits `/session save` and `/target save`, and the bare
`/layout` picker (Enter on the highlighted fuzzy lookalike loads `iasm`
instead of saving `asm` one row down on the `+ create` row).

## Root cause (traced)

The save argument is a **name to be created**, but its completer treats it
like a **name to be referenced** — it fuzzy-matches the existing collection.
Fuzzy matching is subsequence-based and case-insensitive, so `asm` is a valid
(if poor) match for `iasm`:

`tui/src/slash.ts:182` `layoutNameItems` → `fuzzyItems` → pi-tui
`fuzzyMatch("asm","iasm")` matches (a·s·m in order).

Complete trace of the reported repro (`tui/src/slash.ts`, `tui/src/completion-overlay.ts`,
pi-tui `dist/components/editor.js`):

1. Typing `/layout save asm` → `AidbCompletionProvider.getSuggestions`
   (slash.ts:283) → `commandArgumentSuggestions` (slash.ts:336) →
   `layoutCompletion` (slash.ts:174) returns `[{ value: "iasm" }]`.
2. pi-tui shows the dropdown. `getBestAutocompleteMatchIndex(items, "asm")`
   finds no exact and no prefix match (`"iasm".startsWith("asm")` is false),
   so it keeps the default selection = first item = **iasm**.
3. Enter (`tui.select.confirm`) → `applyCompletion` replaces prefix `asm`
   with `iasm` → line becomes `/layout save iasm`. Because the prefix
   `"asm"` doesn't start with `/`, stock pi-tui applies-but-does-not-submit.
4. `AidbEditor.handleInput`'s post-check (completion-overlay.ts:126-129) sees
   "applied, line still starts with /" → `submitForSlash()` →
   `/layout save iasm` executes via `handleLayout` (repl.ts) → saves into
   **iasm**. Silent, one-keypress, irreversible overwrite.

The identical shape exists in the picker (`tui/src/picker.ts:232`): the
`+ create` row is auto-selected only when the filter has **zero** fuzzy
matches. With matches (but no exact match — which is exactly the "new name
that resembles an old one" case) Enter picks the fuzzy match instead.

## Fix principle

> A `save <name>` argument means "this literal string is the name".
> Completion may only **confirm** what was typed (exact name, or the active
> profile), never **guess** a similar saved name.

When the completer returns nothing, no dropdown opens and Enter submits the
line verbatim — so `/layout save asm` creates `asm`. The coercion
disappears by construction, not by heuristic.

The **apply** paths (`/layout <name>`, `/session <name>`, `/open`, bare
picker browsing) intentionally keep fuzzy matching: there the user *is*
referencing saved names and fuzzy-Enter is the standard picker convention.

## Change 1 — `tui/src/slash.ts`: exact-only completion for the `save` verb

New pure helper (exported so it is unit-testable):

```ts
/**
 * Save-subcommand completions: existing profiles are offered ONLY on an exact
 * (case-insensitive) name match, so Enter can never coerce a fresh name into
 * a fuzzy-similar saved one (`/layout save asm` must create "asm", not
 * re-target "iasm"). An empty token completes only the active profile — the
 * `/layout save <Tab>` update path — because bare `save` updates the active
 * one; anything else would be guessing.
 */
export function exactSaveItems(
	names: AutocompleteItem[],
	current: string,
	active: string | null,
): AutocompleteItem[] {
	if (!current) return active ? names.filter((n) => n.value === active) : [];
	const lower = current.toLowerCase();
	return names.filter((n) => n.value.toLowerCase() === lower);
}
```

Wire it into the three save branches, replacing the `*NameItems` fuzzy call
there (apply branches at `pos === 0` unchanged):

```ts
// slash.ts:174 layoutCompletion — save branch
if (first === "save")
	return exactSaveItems(layoutNameItems(ctx, ""), current, ctx.sessions?.layouts.current() ?? null);
// slash.ts:146 sessionCompletion and slash.ts:155 targetCompletion — same shape,
// using sessionNameItems(ctx, "") / targetNameItems(ctx, "") and the matching
// `.sessions.activeName()` / `.targets.current()`.
```

Behavior matrix (before → after):

| typed (saved: `iasm`) | before | after |
|---|---|---|
| `/layout save asm` | dropdown `[iasm]`, Enter → saves **iasm** ✗ | no dropdown, creates **asm** ✓ |
| `/layout save iasm` | updates iasm | dropdown `[iasm]`, updates iasm — unchanged ✓ |
| `/layout save IASM` | case-insensitive apply — updates iasm | ci-exact item, applies `iasm`, updates iasm ✓ |
| `/layout save ias` | dropdown `[iasm]`, Enter updates iasm | no dropdown, creates `ias` — typed text wins ✓ |
| `/layout save `<Tab> (active=iasc) | dropdown of *all* names, first highlighted | dropdown `[iasc]` only (Tab fast-path inserts it) ✓ |
| `/layout asm` (apply) | fuzzy → loads iasm | unchanged — intended browse behavior ✓ |

Notes:

- With no exact match the completer returns `[]`; `commandArgumentSuggestions`
  (slash.ts:343) already turns `items.length === 0` into `null`, and stock
  `CombinedAutocompleteProvider` returns `null` for slash lines with a space
  (no `getArgumentCompletions`) — so no file/path fallback can re-open a
  dropdown. Enter then submits the literal line. Nothing else to change.
- Empty-token completion = active profile only, deliberately NOT all names:
  a first-item-Enter on a full list would re-introduce the same trap in the
  `/layout save <Tab>` path.

## Change 2 — `tui/src/picker.ts:232`: bias the `+ create` row to non-prefix filters

In `buildList`, auto-select the create row not just on zero matches, but also
when the filter has fuzzy matches yet is **not a prefix** of any saved name.
Prefix filters are how you steer *toward* an existing name (browse intent);
non-prefix fuzzy hits are overwhelmingly new names (create intent — the
reported case: `asm` vs saved `iasm`).

```ts
const itemText = (item: PickerItem) => (item.search ?? item.label).replace(/\x1b\[[0-9;]*m/g, "");
const filtered = filter ? fuzzyFilter(items, filter, (i) => itemText(i)) : items;
const exactMatch = filter.length > 0 && items.some((i) => i.value.toLowerCase() === filter.toLowerCase());
const showCreate = options.onCreate !== undefined && filter.length > 0 && !exactMatch;
// Browse-mode signal: the filter is steering at an existing name...
const isBrowsePrefix = filter.length > 0 && items.some((i) => itemText(i).toLowerCase().startsWith(filter.toLowerCase()));
// ...otherwise the typed text is a NEW name — make Enter create it.
if (showCreate && (filtered.length === 0 || !isBrowsePrefix)) list.setSelectedIndex(rows.length - 1);
```

Matrix (bare `/layout` picker, saved `iasm`):

| filter | before | after |
|---|---|---|
| `asm` | `iasm` highlighted, Enter loads iasm ✗ | `+ save current layout "asm"` highlighted, Enter saves ✓ |
| `ias` | `iasm` highlighted, Enter loads iasm ✓ | unchanged — prefix = browse ✓ |
| `xyz` | create row auto-selected (zero matches) ✓ | unchanged ✓ |

Trade-off, documented: typing a deliberate *short* new name that happens to be
a prefix of something saved (e.g. create `asm`, saved `asm2`) stays in browse
mode — one `↓` to the create row. Prefix ⇒ browse is the stronger signal.

Only pickers with `onCreate` are affected (the three collections). `/open`,
`/theme` and `/win switch` have no create row — untouched.

## Out of scope (deliberate)

- **Apply-path fuzzy completion** (`/layout <partial>`, `/session <partial>`,
  `/open`, picker browsing): referencing saved names; fuzzy-Enter is intended.
- **Exact-name overwrite protection**: `/layout save iasm` (exact) may still
  overwrite `iasm` — that is the documented "update existing" flow. The
  picker's existing `exactMatch` rule (create row hidden when the name exists)
  already guards the picker side.
- `/win load`, `/watch <expr>`, `run`/`file` file completion: unrelated
  contexts, no coerced names.

## Testing

Unit (`tui/test/slash.test.ts`, `node --test` — no new deps; tests
import `../src/*.ts` directly per existing pattern):

- `exactSaveItems(["iasm"], "asm", null)` → `[]` (the repro);
- `exactSaveItems(["iasm"], "iasm", null)` → `["iasm"]`;
- `exactSaveItems(["iasm"], "IASM", "iasm")` → `["iasm"]` (ci-exact);
- `exactSaveItems(["iasm"], "", "iasm")` → `["iasm"]` (active only);
- `exactSaveItems(["iasm", "iasc"], "", "iasm")` → `["iasm"]` — never all names;
- provider-level: `new AidbCompletionProvider(buildCommandRegistry(), stubCtx,
  cwd).getSuggestions(["/layout save asm"], 0, col, { signal, force: false })`
  → `null` while the apply form `/layout asm` still yields the `iasm` item.

Picker (`tui/test/picker.test.ts` if created, or manual): `buildList` is
module-private — cover via a tiny exported harness or the existing picker
flows; minimal unit here, see manual below.

Manual (`npm run dev`):

1. `/win vsplit 0 asmview` → `/layout save iasm`; then `/layout save asm` —
   echo must read `Layout 'asm' saved.`; `/layout` bare shows both; `iasm`
   untouched (`/layout iasm` restores the old pane set).
2. `/layout save iasm` again — still updates iasm.
3. `/layout asm` — still fuzzy-loads iasm (apply path unchanged).
4. `/session save asm` and `/target save asm` with fuzzy-similar saved
   profiles — same guarantees.
5. Bare `/layout`, type `asm` — the `+ save current layout "asm"` row must be
   highlighted; Enter saves. Type `ias` — `iasm` stays highlighted; Enter loads.
6. `/layout save <Tab>` with an active saved layout — inserts the active name
   (single-item fast path), never a random one.

## Files touched

| file | change |
|---|---|
| `tui/src/slash.ts` | add `exactSaveItems` (exported); route `save` branches of `layoutCompletion`/`sessionCompletion`/`targetCompletion` through it |
| `tui/src/picker.ts` | `buildList`: create-row auto-select on non-prefix filters (`!isBrowsePrefix`) |
| `tui/test/slash.test.ts` (new) | unit + provider-level regression tests |