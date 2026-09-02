/**
 * The blank watch window: the default pane a /win split creates.
 *
 * Each entry is an ExpressionBinding observation rendered through a RenderSpec.
 * `o` adds an expression, Enter refreshes the entry under the cursor, `d` deletes.
 *
 * Two presentation layers sit on top of the viz renderers:
 *  - AUTO-DISPATCH: a fresh entry with no explicit renderer is assigned one
 *    from the snapshot's type — structs→`struct-tree`, arrays→`array`, while
 *    C strings and scalars keep the default `lines` renderer (which now
 *    formats per type: char glyphs, bool names, float rounding, nul-padding
 *    cleanup). The first manual `/watch cycle`/`flag`/`setRenderSpec` pins the
 *    choice (`WatchEntry.pinned`), so explicit renderers are never clobbered.
 *  - MULTI-LINE BLOCKS: an entry renders as many rows as its interpreter
 *    produces (a struct tree indents under its root line, an array element
 *    list wraps at the pane width), so aggregates are pretty-printed in place
 *    instead of a single mangled to-string. Cursor keys still select the
 *    whole ENTRY (row→entry mapping in `content()`), so `d`/Enter keep working
 *    across blocks.
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { View, type ViewOptions } from "../view.ts";
import { ExpressionBinding } from "../viz/bindings.ts";
import { INTERPRETERS, dispatchRenderer, missingRequirements, renderInterpreter } from "../viz/interpreters.ts";
import { canReuseObservation, cycleAllowed, DEFAULT_RENDER_SPEC, RENDERER_ORDER, requiredBytes, withFlagToggle, type RenderSpec } from "../viz/render-spec.ts";
import type { BindingSnapshot, FetchCtx, LivePane, Rect, ViewFlags } from "../viz/types.ts";

export interface WatchEntry {
	expr: string;
	renderSpec: RenderSpec;
	byteCount: number;
	snap?: BindingSnapshot;
	prevSnap?: BindingSnapshot;
	/** Compact single-line display derived from the renderer output. */
	value?: string;
	error?: boolean;
	pending?: boolean;
	/** False while the renderer may still auto-dispatch from the snapshot type. */
	pinned?: boolean;
}

const HINT_LINES = [
	"watch is empty",
	"",
	"add: /watch <expr> — structs auto-render as trees, arrays as element lists",
	"renderer: /watch cycle [n] · flags: /watch flag <name> [n] · delete: /watch del <n>",
	"all: /watch list (first manual cycle pins the renderer)",
];

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A TreeBinding-style root renders `expr: type = value`; the watch row already
 * shows `expr =`, so drop the redundant `expr: ` prefix from the first line. */
function stripExprPrefix(line: string, expr: string): string {
	const prefix = new RegExp(`^${escapeRegExp(expr)}\\s*:\\s*`);
	return prefix.test(line) ? line.replace(prefix, "") : line;
}

/** Render one entry through its RenderSpec at the pane's inner size. Empty for
 * pending entries (the row shows `…` until the first snapshot lands). */
function renderEntryLines(entry: WatchEntry, width: number, height: number): string[] {
	if (entry.pending || !entry.snap) return [];
	const rect: Rect = { width: Math.max(8, width - 2), height };
	const interpreter = INTERPRETERS[entry.renderSpec.rendererId];
	if (!interpreter) return [`✗ unknown renderer '${entry.renderSpec.rendererId}'`];
	return renderInterpreter(interpreter, entry.snap, entry.prevSnap, rect, entry.renderSpec.flags);
}

export class WatchListView extends View implements LivePane {
	private entries: WatchEntry[] = [];
	private fetchCtx: FetchCtx;
	/** Non-empty while the inline add-prompt captures keys. */
	private prompt: string | null = null;
	/** Row → entry-index mapping from the last content() build (cursor ops). */
	private rowToEntry: number[] = [];
	/** First row of each entry from the last content() build (cursor landing). */
	private rowStarts: number[] = [];
	private lastRenderWidth = 80;

	constructor(fetchCtx: FetchCtx, options: ViewOptions = {}) {
		super(options.id ?? "watch", { ...options, title: options.title ?? options.id ?? "watch" });
		this.fetchCtx = fetchCtx;
	}

	getEntries(): readonly WatchEntry[] {
		return this.entries;
	}

	isPrompting(): boolean {
		return this.prompt !== null;
	}

	getPrompt(): string {
		return this.prompt ?? "";
	}

	add(expr: string, renderSpec: RenderSpec = DEFAULT_RENDER_SPEC): void {
		const trimmed = expr.trim();
		if (!trimmed) return;
		this.entries.push({
			expr: trimmed,
			renderSpec,
			byteCount: Math.max(requiredBytes(renderSpec), 192),
			pinned: false,
			pending: true,
		});
		this.touch();
		this.cursorToEntry(this.entries.length - 1);
		void this.refreshEntry(this.entries.length - 1);
	}

	removeAt(index: number): void {
		if (index < 0 || index >= this.entries.length) return;
		this.entries.splice(index, 1);
		this.touch();
	}

	/**
	 * Restore persisted entries on session resume. Snapshots are run-local
	 * and start empty (pending); they re-fetch on the next stop. Persisted
	 * renderers are treated as explicit choices (`pinned`), so auto-dispatch
	 * never surprises a returning session.
	 */
	restore(entries: Array<{ expr: string; renderSpec: RenderSpec; byteCount: number }>): void {
		for (const entry of entries) {
			if (!entry.expr) continue;
			this.entries.push({
				expr: entry.expr,
				renderSpec: entry.renderSpec,
				byteCount: Math.max(requiredBytes(entry.renderSpec), 192),
				pinned: true,
				pending: true,
			});
		}
		this.touch();
		this.cursorToEntry(this.entries.length - 1);
	}

	/** Swap renderer/options; refetch only when the cached bytes are insufficient. */
	setRenderSpec(index: number, spec: RenderSpec): boolean {
		if (!INTERPRETERS[spec.rendererId]) return false;
		const entry = this.entries[index];
		if (!entry) return false;

		entry.pinned = true;
		entry.renderSpec = spec;
		const needed = requiredBytes(spec);
		if (!canReuseObservation(entry.byteCount, entry.snap?.bytes?.length, spec)) {
			entry.byteCount = Math.max(entry.byteCount, needed, 192);
			entry.pending = true;
			void this.refreshEntry(index);
		} else {
			this.updateDisplay(entry, 120);
			this.touch();
		}
		return true;
	}

	/** Cycle the renderer for an entry, skipping renderers that can't consume the
	 * current observation; refreshes only if the new renderer needs more bytes. */
	cycleRendererAt(index: number, back = false): void {
		const entry = this.entries[index];
		if (!entry) return;
		const next = cycleAllowed(entry.renderSpec.rendererId, compatibleRenderers(entry.snap), back);
		this.setRenderSpec(index, { ...entry.renderSpec, rendererId: next });
	}

	/** Flip one render flag on an entry; render-only, so never refetches. An
	 * explicit flag choice also pins the renderer (stops auto-dispatch). */
	toggleFlagAt(index: number, flag: ViewFlags): void {
		const entry = this.entries[index];
		if (!entry) return;
		entry.pinned = true;
		entry.renderSpec = withFlagToggle(entry.renderSpec, flag);
		this.updateDisplay(entry, 120);
		this.touch();
	}

	async refreshAll(advance = false): Promise<void> {
		// Capture the previous stop's snapshots before any fetch so a redundant
		// second refresh for the same stop (stopped + location + breakpoints)
		// cannot overwrite prevSnap with the just-fetched identical snapshot and
		// erase the change highlight.
		if (advance) {
			for (const entry of this.entries) entry.prevSnap = entry.snap;
		}
		await Promise.all(this.entries.map((_, index) => this.refreshEntry(index)));
	}

	reset(): void {
		for (const entry of this.entries) {
			entry.snap = undefined;
			entry.prevSnap = undefined;
			entry.value = undefined;
			entry.error = false;
			entry.pending = true;
		}
		this.touch();
	}

	protected override capturingInput(): boolean {
		return this.prompt !== null;
	}

	protected override handleViewKey(data: string): void {
		if (this.prompt !== null) {
			this.handlePromptKey(data);
			return;
		}
		if (matchesKey(data, "o")) {
			this.prompt = "";
			this.changed();
			return;
		}
		if (matchesKey(data, "d")) {
			this.removeAt(this.entryAtCursor());
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const index = this.entryAtCursor();
			const entry = this.entries[index];
			if (entry) {
				entry.pending = true;
				this.touch();
				void this.refreshEntry(index);
			}
		}
	}

	private handlePromptKey(data: string): void {
		if (matchesKey(data, "escape")) {
			this.prompt = null;
			this.changed();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const expr = this.prompt ?? "";
			this.prompt = null;
			this.add(expr);
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
			this.prompt = (this.prompt ?? "").slice(0, -1);
			this.changed();
			return;
		}
		if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
			this.prompt = (this.prompt ?? "") + data;
			this.changed();
		}
	}

	/** The entry whose block contains the cursor row (defaults to 0 before the
	 * first render, when the row map is still empty). */
	private entryAtCursor(): number {
		const rows = this.rowToEntry;
		if (rows.length === 0) return 0;
		let index = 0;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i]! <= this.cursorLine) index = i;
			else break;
		}
		return index;
	}

	/** Land the cursor on an entry's FIRST row; rebuilds the row map (a fresh
	 * entry isn't in the cached map until content() runs again). */
	private cursorToEntry(index: number): void {
		this.render(this.lastRenderWidth);
		const start = this.rowStarts[Math.max(0, Math.min(this.entries.length - 1, index))] ?? 0;
		this.setCursor(start);
	}

	/** Compact single-line summary + error flag, derived from the renderer output. */
	private updateEntry(entry: WatchEntry, rendered: string[]): void {
		const joined = rendered.length > 0 ? stripAnsi(rendered.join(" ")).trim() : "";
		entry.value = truncateToWidth(joined || "—", 120, "…");
		entry.error = !!entry.snap?.error || entry.value.startsWith("✗");
	}

	/** Refresh the cached summary without re-fetching (renderer/flag changes). */
	private updateDisplay(entry: WatchEntry, width: number): void {
		if (!entry.snap) return;
		this.updateEntry(entry, renderEntryLines(entry, width, this.getViewportHeight()));
	}

	private async refreshEntry(index: number): Promise<void> {
		const entry = this.entries[index];
		if (!entry) return;
		// Remember whether the cursor was on this entry BEFORE the fetch resolves
		// (row map from the last render, pre-geometry-change): when a pending
		// entry grows into a multi-line block, the cursor row would otherwise
		// drift into a neighbouring block.
		const wasSelected = this.entryAtCursor() === index;
		const binding = new ExpressionBinding(entry.expr, entry.byteCount);
		try {
			const snap = await binding.fetch(this.fetchCtx);
			if (this.entries[index] !== entry) return;
			entry.snap = snap;
			entry.pending = false;
			this.autoDispatch(entry);
			this.updateDisplay(entry, 120);
			this.touch();
			if (wasSelected) this.cursorToEntry(index);
		} catch (error) {
			if (this.entries[index] !== entry) return;
			entry.snap = { kind: "expression", error: error instanceof Error ? error.message : String(error) };
			entry.pending = false;
			this.updateDisplay(entry, 120);
			this.touch();
			if (wasSelected) this.cursorToEntry(index);
		}
	}

	/** First successful snapshot of an unpinned entry picks a renderer from the
	 * snapshot type; later stops only re-dispatch onto the same renderer. */
	private autoDispatch(entry: WatchEntry): void {
		if (entry.pinned) return;
		const best = dispatchRenderer(entry.snap);
		if (best && best !== entry.renderSpec.rendererId) {
			entry.renderSpec = { ...entry.renderSpec, rendererId: best };
		}
	}

	protected override content(width: number): string[] {
		this.lastRenderWidth = width;
		if (this.entries.length === 0 && this.prompt === null) return [...HINT_LINES];
		const lines: string[] = [];
		const starts: number[] = [];
		const rows: number[] = [];
		const height = this.getViewportHeight();
		this.entries.forEach((entry, index) => {
			starts.push(lines.length);
			const selected = index === this.entryAtCursor();
			const marker = selected ? ">" : " ";
			const rendered = renderEntryLines(entry, width, height);
			if (rendered.length === 0) {
				lines.push(`${marker} ${entry.expr} = …`);
				rows.push(lines.length - 1);
				return;
			}
			const first = stripExprPrefix(rendered[0]!, entry.expr);
			const error = !!entry.snap?.error || stripAnsi(first).startsWith("✗");
			const value = truncateToWidth(stripAnsi(first), Math.max(4, width - Math.min(entry.expr.length, width - 4) - 5), "…");
			lines.push(`${marker} ${entry.expr} = ${value}${error && !stripAnsi(first).startsWith("✗") ? "  ✗" : ""}`);
			rows.push(lines.length - 1);
			for (const line of rendered.slice(1)) lines.push(`  ${line}`);
			this.updateEntry(entry, rendered);
		});
		if (this.prompt !== null) lines.push(`o> ${this.prompt}_`);
		this.rowStarts = starts;
		this.rowToEntry = rows;
		return lines;
	}
}

/**
 * Renderers (in display order) that can consume `snap`. When there's no
 * snapshot yet we can't judge requirements, so return the full catalog so a
 * pending entry still has a sensible cycle target.
 */
function compatibleRenderers(snap: BindingSnapshot | undefined): readonly string[] {
	if (!snap) return RENDERER_ORDER;
	return RENDERER_ORDER.filter((id) => {
		const interpreter = INTERPRETERS[id];
		if (!interpreter) return false;
		return missingRequirements(interpreter, snap) === undefined;
	});
}