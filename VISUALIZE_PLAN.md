# AI-Creatable Visualizations Plan

## Goal

Make visualization creation simple enough that an AI can add a new visualization for a user's C/C++ data type without creating a new pane class, duplicating debugger refresh logic, or parsing DAP messages directly.

The desired interaction is:

> Create a visualization for this data type. Render it as X, using Y semantics and Z interaction.

The normal implementation result should be a renderer, renderer descriptor, fixture, and tests.

## Status against actual code (keep this in sync; code is the golden truth)

> Last updated mid–Phase 6. All of the below is verified against the tree on
> branch `feature/ai-creatable-visualizations` and the test suite (134 tests,
> build + typecheck clean). Options/structures below supersede any earlier
> wording in this doc that the code has drifted from.

- [x] **Phase 0** — fixtures (`test/fixtures/view-data.c`, `tui/test/fixtures/bytes.ts`) and
  `DapClient` support for `type`, `memoryReference`, `variablesReference`, base64 `readMemory`.
- [x] **Phase 1/2** — `EvalInfo`, `VarNode` (evaluateName/memoryReference/variablesReference/presentationHint),
  `evaluateDetailed`, `readMemory` in `FetchCtx`, `ExpressionBinding`, `TreeBinding` in `tui/src/viz/bindings.ts`;
  `enableView` preserves type/references.
- [x] **Phase 3** — `BindingSnapshot` retains capabilities; `ObservationCapability` type + `requires`/
  `requiresAny` declared on every `Interpreter`; `missingRequirements()` + `renderPath()` explain
  incompatible observations instead of rendering empty.
- [x] **Phase 4** — `tui/src/viz/byte-renderers.ts`: `renderHexdump`, `renderBytes`, `renderChars`, `renderTuple`,
  `renderBitmap` (8-bit truecolor + changed-cell marking), width-adaptive columns.
- [x] **Phase 5** — `WatchListView` (`tui/src/views/watch.ts`) entries are `ExpressionBinding` + a `RenderSpec`,
  rendering through `renderInterpreter`; `setRenderSpec` reuses cached bytes when the budget allows.
- [x] **Phase 6 (first half)** — `render-spec.ts` gives `RenderSpec { rendererId, options? }`, `requiredBytes()`,
  `canReuseObservation()`; `OptionDescriptor` + `optionSchema` per renderer; `INTERPRETERS` registry back /win pick.
- [x] **Phase 6 (flags + keybinding + AI metadata)** — `ViewFlags` (const-object, `erasableSyntaxOnly` safe)
  threaded into `RenderSpec` and every byte renderer/render path; `ViewFlags` stays render-time only so toggling
  never refetches; `VIEW_FLAG_META` machine-readable flag metadata; `Interpreter.examples`;
  renderer cycling (`cycleRenderer`) + per-flag toggling in `WatchListView` keys and `LivePaneView.toggleFlag`;
  `/win pick <ref> <interpreter> | +flag` toggles live-pane flags from the console.
- [ ] **Phase 7** — safe AI creation tools and plugin boundary (next).

### Phase 6 remainder: ViewFlags, renderer-loop flag toggling, and AI-facing metadata

The Observation has drifted from the plan's original split: today `RenderSpec` carries renderer id + typed
options but **no bitflags** (`render-spec.ts` header still says "Phase 6 will add bitflags"). The concrete
remaining work, grounded in the real code:

1. **Add `ViewFlags` to `RenderSpec`** in `render-spec.ts`:

   ```ts
   export enum ViewFlags {
     None = 0,
     // Show the address gutter in memory rows.
     ADDRESSES     = 1 << 0,
     // Show a type/annotation line in the pane header.
     TYPES         = 1 << 1,
     // Turn *off* changed-byte/changed-cell highlighting.
     HIDE_CHANGES  = 1 << 2,
     // Show the ASCII column in `hexdump` even in narrow panes.
     ASCII         = 1 << 3,
   }
   ```

   Extend `RenderSpec` to `{ rendererId, flags: ViewFlags, options? }`.

2. **Thread flags through renderers.** Add a `flags` argument to the render path and to the byte
   renderers (`renderHexdump` already has a gutter; gate it behind `ADDRESSES`, `TYPES` adds the
   memory-header type, `HIDE_CHANGES` drops the changed-cell 0x-mark). **Flags must be render-time
   only** — `requiredBytes()` ignores them, so toggling a flag never refetches (same contract the
   existing "switch without a new fetch" tests enforce).

3. **Keybinding/command to toggle flags and cycle renderers.** In `WatchListView` — which owns the
   `RenderSpec` per entry — add keys to cycle the renderer and toggle a flag per key. `LivePaneView`
   needs to hold a `RenderSpec` (not just `interpreterId`) so it hosts flags natively too.

4. **Expose AI-facing descriptor metadata.** Give interpreters an `examples?: string[]` field (the plan
   lists `examples` but no interpreter sets it yet) and a machine-readable map from each `ViewFlags`
   bit to its name/description so future tooling can generate a render spec given a sample
   observation.

5. **Tests** for: flag toggling does not refetch (bytes snapshot unchanged), the `hexdump` ASCII
   column and `HIDE_CHANGES` regressions, and descriptor emission for a `bitmap` generator.

Phase 7 then hardens the AI-facing tool surface against this registry
(inspect → scaffold → fixture → golden-test → register).

## Design Principles

1. Separate observation from presentation.
2. Preserve all useful DAP metadata instead of narrowing it away.
3. Read raw bytes once when a value is addressable, then reuse them across renderers.
4. Keep source, assembly, registers, and computed values as specialized observations where necessary.
5. Make renderer requirements explicit and machine-readable.
6. Keep pane layout, refresh, scrolling, and DAP transport out of generated visualizers.
7. Require explicit semantics when bytes are ambiguous: dimensions, tuple width, channel order, encoding, and units.

## Target Architecture

```text
Expression / location
        |
        v
ObservationBinding
        |
        +-- evaluateDetailed(): value, type, references
        +-- readMemory(): raw bytes when memoryReference exists
        +-- variables(): structured children when available
        |
        v
Observation
        |
        v
RendererRegistry -> renderer + flags + options -> LivePaneView
```

### Observation

The observation should preserve capabilities instead of using `kind` as a hard compatibility boundary.

```ts
interface Observation {
  identity: string;
  expression?: string;
  value?: string;
  type?: string;
  memory?: {
    address: string;
    bytes: Uint8Array;
    complete: boolean;
  };
  children?: VariableNode[];
  location?: SourceLocation;
  source?: SourceData;
  assembly?: AssemblyData;
  samples?: number[];
  info?: string;
  error?: string;
}
```

### Renderer

```ts
interface RendererDescriptor {
  id: string;
  title: string;
  requires: Array<"value" | "type" | "memory" | "children" | "source" | "assembly" | "samples">;
  options: Record<string, OptionDescriptor>;
  examples?: string[];
}

interface Renderer {
  descriptor: RendererDescriptor;
  render(
    observation: Observation,
    previous: Observation | undefined,
    spec: RenderSpec,
    rect: Rect,
  ): string[];
}
```

## Implementation Steps

### Phase 0: Establish behavior and fixtures

- Add a C fixture containing an RGB tuple array, a character buffer, a struct, and a computed expression.
- Add debugger-core tests for DAP `evaluate` responses containing `type`, `memoryReference`, and `variablesReference`.
- Add tests for DAP `readMemory` base64 decoding and resolved addresses.
- Document `x/Nxb` and `x/Nxc` as console fallbacks, not the canonical observation representation.
- Record expected behavior for non-addressable and optimized-out expressions.

### Phase 1: Preserve type and location metadata

- Add `type` to TUI `EvalInfo` in `tui/src/viz/types.ts`.
- Preserve the root expression type in `TreeBinding`.
- Extend `VarNode` with `evaluateName`, `memoryReference`, `variablesReference`, and relevant presentation metadata.
- Update `makeFetchCtx()` so core variable metadata is not dropped.
- Decide whether to advertise `supportsMemoryReferences` based on GDB behavior and add compatibility tests.
- Keep all new fields optional because DAP adapters may omit them.

### Phase 2: Implement the expression observation binding

- Add `ExpressionBinding` in `tui/src/viz/bindings.ts`.
- Evaluate the expression with `evaluateDetailed()`.
- Preserve the returned value, type, and references.
- If a usable `memoryReference` exists, call `readMemory()` with explicit byte count and offset options.
- If a `variablesReference` exists, optionally fetch children within a depth/node budget.
- Return one `Observation` containing all successful representations.
- Return partial observations with an explanatory `info` field when one representation is unavailable.
- Bound memory reads to prevent a large array from freezing the TUI.

### Phase 3: Replace the snapshot compatibility boundary

- Introduce `Observation` and migrate `BindingSnapshot` incrementally or rename it if no compatibility value remains.
- Replace renderer checks such as `snap.kind === "memory"` with capability checks such as `observation.memory !== undefined`.
- Keep specialized source, assembly, register, series, and tree bindings while allowing them to produce the common observation shape.
- Make renderer descriptors declare required capabilities.
- Show a clear "renderer requires memory/type/children" error instead of silently rendering an empty view.

### Phase 4: Add core byte-oriented renderers

- Extract or add a plain byte renderer.
- Add a character renderer with configurable encoding and printable-character policy.
- Add a tuple renderer with explicit element width and numeric interpretation.
- Add a bitmap renderer with explicit width, height, tuple width, channel order, scaling, and changed-pixel behavior.
- Keep `hexdump` as a useful diagnostic renderer.
- Add width-aware fallback behavior for small terminal panes.

### Phase 5: Unify watch expressions

- Replace `WatchListView`'s private evaluator/render path with expression observations.
- Represent each watch entry as an expression binding plus a `RenderSpec`.
- Preserve existing watch-list interaction, but let entries choose text, tree, bytes, chars, tuple, or bitmap renderers.
- Allow renderer changes without refetching when the cached observation satisfies the new renderer.
- Refetch only when the renderer changes required data, such as increasing the requested byte count.

### Phase 6: Add flags, commands, and AI-facing registry metadata

- Define a `RenderSpec` containing renderer ID, bitflags, and typed options.
- Use flags for orthogonal behavior such as addresses, types, change highlighting, and character columns.
- Use renderer IDs for primary presentation modes such as `hex`, `chars`, `bitmap`, `source`, and `tree`.
- Keep `/win pick` as the explicit command interface.
- Add a fast keybinding to cycle renderers and toggle common flags.
- Expose renderer descriptors, option schemas, examples, and required capabilities to future AI tools.

### Phase 7: Add safe AI creation tools

- Add a tool to inspect an expression's observation: type, size if known, addressability, bytes available, children, and capabilities.
- Add a tool to scaffold a renderer from a descriptor.
- Add a tool to create deterministic byte fixtures and golden tests.
- Add a tool to run typecheck and renderer tests.
- Validate generated renderers against declared requirements before registration.
- Require generated code to use the renderer API rather than importing DAP or GDB internals.
- Consider a plugin directory or generated module boundary once the renderer contract is stable.

## Example AI Workflow

User request:

> Create a visualization for `frame`. It is a 640x480 array of RGB tuples. Render it as a fitted bitmap and highlight pixels changed since the last stop.

Expected AI actions:

1. Call the observation-inspection tool for `frame`.
2. Confirm `type`, `memoryReference`, and the expected byte count.
3. Ask a clarification question if tuple width, dimensions, or channel order are ambiguous.
4. Generate a `bitmap` renderer or reuse the built-in renderer with a `RenderSpec`.
5. Generate a known-byte fixture and golden output.
6. Run typecheck and tests.
7. Register the renderer or render spec.
8. Mount it in the existing live pane.

Example specification:

```ts
{
  renderer: "bitmap",
  flags: ViewFlags.CHANGES,
  options: {
    expression: "frame",
    width: 640,
    height: 480,
    tupleWidth: 3,
    channelOrder: "rgb",
    scale: "fit",
  },
}
```

## Verification

- `npm run build`
- `npm test`
- `npm run typecheck --workspace aidb-tui`
- Unit-test the same byte fixture through bytes, chars, tuples, and bitmap renderers.
- Test renderer switching without a new fetch.
- Test byte-count expansion when a renderer requests more data.
- Test missing `memoryReference`, missing type metadata, incomplete reads, and optimized-out values.
- Test narrow pane widths, empty data, odd tuple lengths, and changed-byte highlighting.
- Run a manual end-to-end fixture with a breakpoint and multiple stops.

## Success Criteria

- A new visualization normally requires no new `View` subclass.
- A renderer can be tested with an observation fixture and no running debugger.
- An AI can discover renderer requirements and options from machine-readable descriptors.
- The same expression can be rendered through multiple modes without changing its binding.
- Raw bytes and type metadata are available whenever GDB exposes them.
- Source and assembly remain accurate specialized observations rather than forced byte representations.
- Existing DAP fallbacks and current pane behavior continue to work.
