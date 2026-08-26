/**
 * Shared base for pane content: every visualization is a list of lines plus
 * a cursor, and this class owns scrolling, cursor movement and the default
 * vim navigation keys. Concrete views implement `content()` and optionally
 * `handleViewKey()` — they never reimplement scrolling, which is why the same
 * j/k/g/G/Ctrl+d/Ctrl+u work identically over source, asm, registers, watches.
 *
 * Rendering happens in pi-tui's flow mode, where components receive width but
 * not height; the window manager supplies a per-pane viewport height so each
 * pane can slice its own content instead of pushing hundreds of lines.
 */

import { matchesKey, sliceByColumn, visibleWidth, type Component } from "@earendil-works/pi-tui";

export interface ViewOptions {
	id?: string;
	title?: string;
	viewportHeight?: number;
	/** Called after any mutation that changes rendered output. */
	onChange?: () => void;
}

export abstract class View implements Component {
	readonly id: string;
	title: string;
	protected onChange?: () => void;

	protected scrollRow = 0;
	protected scrollColumn = 0;
	protected cursorLine = 0;
	private viewportHeight: number;
	private lastWidth = -1;
	private cachedContent: string[] | null = null;

	constructor(id: string, options: ViewOptions = {}) {
		this.id = id;
		this.title = options.title ?? id;
		this.viewportHeight = options.viewportHeight ?? 24;
		this.onChange = options.onChange;
	}

	/** Content for the given width; recomputed only after invalidate(). */
	protected abstract content(width: number): string[];

	/** Call after any state change that affects content(). */
	protected touch(): void {
		this.cachedContent = null;
		this.lastWidth = -1;
		// Clamp eagerly so cursor/scroll getters are truthful between renders
		// even when the underlying content shrank.
		this.revealCursor();
		this.changed();
	}

	protected changed(): void {
		this.onChange?.();
	}

	invalidate(): void {
		this.touch();
	}

	setViewportHeight(rows: number): void {
		const next = Math.max(1, Math.floor(rows));
		if (next === this.viewportHeight) return;
		this.viewportHeight = next;
		this.clamp();
		this.changed();
	}

	getViewportHeight(): number {
		return this.viewportHeight;
	}

	private lines(width: number): string[] {
		if (!this.cachedContent || this.lastWidth !== width) {
			this.cachedContent = this.content(width);
			this.lastWidth = width;
			this.clamp();
		}
		return this.cachedContent;
	}

	render(width: number): string[] {
		const all = this.lines(width);
		this.clampHorizontal(width, all);
		const from = Math.min(this.scrollRow, Math.max(0, all.length - this.viewportHeight));
		const slice = all.slice(from, from + this.viewportHeight).map((line) => sliceByColumn(line, this.scrollColumn, width, true));
		while (slice.length < this.viewportHeight) slice.push("");
		return slice;
	}

	/**
	 * Default navigation keymap. Returns true when consumed; unhandled
	 * keys reach handleViewKey().
	 */
	handleInput(data: string): void {
		if (!this.capturingInput() && this.handleKey(data)) return;
		this.handleViewKey(data);
	}

	/**
	 * While a view captures raw input (inline prompts), the default vim
	 * keymap is suspended so letters like "j" become text instead of motion.
	 */
	protected capturingInput(): boolean {
		return false;
	}

	/** True while an inline prompt owns the keyboard (window manager routing). */
	isPrompting(): boolean {
		return false;
	}

	protected handleKey(data: string): boolean {
		const halfPage = Math.max(1, Math.floor(this.viewportHeight / 2));
		if (matchesKey(data, "g") || matchesKey(data, "home")) {
			this.setCursor(0);
			return true;
		}
		if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
			this.setCursor(Math.max(0, this.ensureLines().length - 1));
			return true;
		}
		if (matchesKey(data, "ctrl+d")) {
			this.scrollBy(halfPage);
			return true;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.scrollBy(-halfPage);
			return true;
		}
		if (matchesKey(data, "ctrl+down")) {
			this.scrollBy(halfPage);
			return true;
		}
		if (matchesKey(data, "ctrl+up")) {
			this.scrollBy(-halfPage);
			return true;
		}
		return false;
	}

	/** Extension point for view-specific keys (o/d/Enter on watch lists...). */
	protected handleViewKey(_data: string): void {}

	protected moveCursor(delta: number): void {
		this.setCursor(this.cursorLine + delta);
	}

	protected setCursor(line: number): void {
		const count = this.lineCount();
		this.cursorLine = Math.max(0, Math.min(count - 1, line));
		this.revealCursor();
		this.changed();
	}

	/** Place a newly selected cursor near the middle of the viewport. */
	protected centerCursor(line: number): void {
		const count = this.lineCount();
		this.cursorLine = Math.max(0, Math.min(count - 1, line));
		const maxScroll = Math.max(0, count - this.viewportHeight);
		this.scrollRow = Math.max(0, Math.min(maxScroll, this.cursorLine - Math.floor(this.viewportHeight / 2)));
		this.changed();
	}

	/**
	 * Half-page scroll: the viewport moves by `rows` and the cursor rides
	 * along, keeping its screen position where possible (vim Ctrl+d/Ctrl+u).
	 */
	protected scrollBy(rows: number): void {
		const count = this.lineCount();
		const maxScroll = Math.max(0, count - this.viewportHeight);
		this.scrollRow = Math.max(0, Math.min(maxScroll, this.scrollRow + rows));
		this.cursorLine = Math.max(0, Math.min(count - 1, this.cursorLine + rows));
		if (this.cursorLine < this.scrollRow) this.cursorLine = this.scrollRow;
		else if (this.cursorLine >= this.scrollRow + this.viewportHeight) {
			this.cursorLine = this.scrollRow + this.viewportHeight - 1;
		}
		this.changed();
	}

	protected scrollHorizontally(columns: number): void {
		this.scrollColumn = Math.max(0, this.scrollColumn + columns);
		this.changed();
	}

	getHorizontalScroll(): number {
		return this.scrollColumn;
	}

	private revealCursor(): void {
		const count = this.lineCount();
		const maxScroll = Math.max(0, count - this.viewportHeight);
		this.cursorLine = Math.max(0, Math.min(count - 1, this.cursorLine));
		if (this.cursorLine < this.scrollRow) this.scrollRow = this.cursorLine;
		if (this.cursorLine >= this.scrollRow + this.viewportHeight) {
			this.scrollRow = this.cursorLine - this.viewportHeight + 1;
		}
		this.scrollRow = Math.max(0, Math.min(maxScroll, this.scrollRow));
	}

	private clamp(): void {
		this.revealCursor();
	}

	private clampHorizontal(width: number, lines: string[]): void {
		const maxColumn = Math.max(0, ...lines.map((line) => visibleWidth(line) - width));
		this.scrollColumn = Math.min(this.scrollColumn, maxColumn);
	}

	private ensureLines(): string[] {
		return this.lines(this.lastWidth < 1 ? 80 : this.lastWidth);
	}

	private lineCount(): number {
		return this.ensureLines().length;
	}
}
