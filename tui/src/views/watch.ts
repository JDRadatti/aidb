/**
 * The blank watch window: the default pane a /win split creates.
 *
 * Each entry is an ExpressionBinding observation rendered through a RenderSpec.
 * `o` adds an expression, Enter refreshes the entry under the cursor, `d` deletes.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { View, type ViewOptions } from "../view.ts";
import { ExpressionBinding } from "../viz/bindings.ts";
import { INTERPRETERS, renderInterpreter } from "../viz/interpreters.ts";
import { canReuseObservation, cycleRenderer, DEFAULT_RENDER_SPEC, requiredBytes, withFlagToggle, type RenderSpec } from "../viz/render-spec.ts";
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
}

const HINT_LINES = ["watch is empty", "", "o: add expression   d: delete   enter: refresh"];

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatWatchLine(entry: WatchEntry, width: number): { text: string; error: boolean } {
	if (entry.pending) return { text: "…", error: false };
	if (!entry.snap) return { text: "?", error: false };

	const rect: Rect = { width: Math.max(16, width - entry.expr.length - 5), height: 1 };
	const interpreter = INTERPRETERS[entry.renderSpec.rendererId];
	if (!interpreter) return { text: `✗ unknown renderer '${entry.renderSpec.rendererId}'`, error: true };

	const lines = renderInterpreter(interpreter, entry.snap, entry.prevSnap, rect, entry.renderSpec.flags);
	const text = stripAnsi(lines.join(" ")).trim() || "—";
	const error = !!entry.snap.error || text.startsWith("✗");
	return { text, error };
}

export class WatchListView extends View implements LivePane {
	private entries: WatchEntry[] = [];
	private fetchCtx: FetchCtx;
	/** Non-empty while the inline add-prompt captures keys. */
	private prompt: string | null = null;

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
			pending: true,
		});
		this.setCursor(this.entries.length - 1);
		this.touch();
		void this.refreshEntry(this.entries.length - 1);
	}

	removeAt(index: number): void {
		if (index < 0 || index >= this.entries.length) return;
		this.entries.splice(index, 1);
		this.touch();
	}

	/** Swap renderer/options; refetch only when the cached bytes are insufficient. */
	setRenderSpec(index: number, spec: RenderSpec): boolean {
		if (!INTERPRETERS[spec.rendererId]) return false;
		const entry = this.entries[index];
		if (!entry) return false;

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

	/** Cycle the renderer for an entry; refreshes only if the new renderer needs more bytes. */
	cycleRendererAt(index: number, back = false): void {
		const entry = this.entries[index];
		if (!entry) return;
		const next = cycleRenderer(entry.renderSpec.rendererId, back);
		this.setRenderSpec(index, { ...entry.renderSpec, rendererId: next });
	}

	/** Flip one render flag on an entry; render-only, so never refetches. */
	toggleFlagAt(index: number, flag: ViewFlags): void {
		const entry = this.entries[index];
		if (!entry) return;
		entry.renderSpec = withFlagToggle(entry.renderSpec, flag);
		this.updateDisplay(entry, 120);
		this.touch();
	}

	async refreshAll(): Promise<void> {
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
			this.removeAt(this.cursorLine);
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const entry = this.entries[this.cursorLine];
			if (entry) {
				entry.pending = true;
				this.touch();
				void this.refreshEntry(this.cursorLine);
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

	private updateDisplay(entry: WatchEntry, width: number): void {
		const formatted = formatWatchLine(entry, width);
		entry.value = formatted.text;
		entry.error = formatted.error;
	}

	private async refreshEntry(index: number): Promise<void> {
		const entry = this.entries[index];
		if (!entry) return;
		const binding = new ExpressionBinding(entry.expr, entry.byteCount);
		try {
			const snap = await binding.fetch(this.fetchCtx);
			if (this.entries[index] !== entry) return;
			entry.prevSnap = entry.snap;
			entry.snap = snap;
			entry.pending = false;
			this.updateDisplay(entry, 120);
			this.touch();
		} catch (error) {
			if (this.entries[index] !== entry) return;
			entry.snap = { kind: "expression", error: error instanceof Error ? error.message : String(error) };
			entry.pending = false;
			this.updateDisplay(entry, 120);
			this.touch();
		}
	}

	protected content(width: number): string[] {
		if (this.entries.length === 0 && this.prompt === null) return [...HINT_LINES];
		const lines: string[] = [];
		this.entries.forEach((entry, index) => {
			this.updateDisplay(entry, width);
			const marker = index === this.cursorLine ? ">" : " ";
			const value = entry.pending ? "…" : entry.value ?? "?";
			lines.push(`${marker} ${entry.expr} = ${value}${entry.error ? "  ✗" : ""}`);
		});
		if (this.prompt !== null) lines.push(`o> ${this.prompt}_`);
		return lines;
	}
}
