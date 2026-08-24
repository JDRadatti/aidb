/**
 * The blank watch window: the default pane a /win split creates.
 *
 * Entries are expressions re-evaluated after each refresh; `o` opens an
 * inline prompt to add one, Enter re-evaluates the entry under the cursor,
 * `d` deletes it. Navigation comes from the View base like every other pane.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { View, type ViewOptions } from "../view.ts";

export interface WatchEntry {
	expr: string;
	value?: string;
	error?: boolean;
	pending?: boolean;
}

/** Evaluates an expression in the current frame; rejects with gdb's error. */
export type WatchEvaluator = (expr: string) => Promise<string>;

const HINT_LINES = ["watch is empty", "", "o: add expression   d: delete   enter: refresh"];

export class WatchListView extends View {
	private entries: WatchEntry[] = [];
	private evaluator: WatchEvaluator;
	/** Non-empty while the inline add-prompt captures keys. */
	private prompt: string | null = null;

	constructor(evaluator: WatchEvaluator, options: ViewOptions = {}) {
		super(options.id ?? "watch", { ...options, title: options.title ?? options.id ?? "watch" });
		this.evaluator = evaluator;
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

	add(expr: string): void {
		const trimmed = expr.trim();
		if (!trimmed) return;
		this.entries.push({ expr: trimmed, pending: true });
		this.setCursor(this.entries.length - 1);
		this.touch();
		void this.refreshEntry(this.entries.length - 1);
	}

	removeAt(index: number): void {
		if (index < 0 || index >= this.entries.length) return;
		this.entries.splice(index, 1);
		this.touch();
	}

	async refreshAll(): Promise<void> {
		await Promise.all(this.entries.map((_, index) => this.refreshEntry(index)));
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
		// Printable characters arrive as bare runs; ignore control sequences.
		if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
			this.prompt = (this.prompt ?? "") + data;
			this.changed();
		}
	}

	private async refreshEntry(index: number): Promise<void> {
		const entry = this.entries[index];
		if (!entry) return;
		try {
			const value = await this.evaluator(entry.expr);
			// The entry may have been deleted or reordered while gdb ran.
			if (this.entries[index] === entry) {
				entry.value = value;
				entry.error = false;
				entry.pending = false;
				this.touch();
			}
		} catch (error) {
			if (this.entries[index] === entry) {
				entry.value = error instanceof Error ? error.message : String(error);
				entry.error = true;
				entry.pending = false;
				this.touch();
			}
		}
	}

	protected content(width: number): string[] {
		void width;
		if (this.entries.length === 0 && this.prompt === null) return [...HINT_LINES];
		const lines: string[] = [];
		this.entries.forEach((entry, index) => {
			const marker = index === this.cursorLine ? ">" : " ";
			const value = entry.pending ? "…" : entry.value ?? "?";
			lines.push(`${marker} ${entry.expr} = ${value}${entry.error ? "  ✗" : ""}`);
		});
		if (this.prompt !== null) lines.push(`o> ${this.prompt}_`);
		return lines;
	}
}
