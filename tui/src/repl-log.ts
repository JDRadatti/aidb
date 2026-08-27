/**
 * Scrollable REPL transcript.
 *
 * The repl pane is the one pane that is not a `View` — its content is an
 * unbounded, ever-growing log of `Text` children (including the activity
 * spinner's `Loader`), and it must default to following the *bottom* like a
 * terminal, not a cursor. This component adds follow-end scrollback on top of
 * the plain `Container` semantics, so `addLine`/`addChild` and the spinner's
 * loader injection keep working unchanged.
 *
 * Scroll protocol mirrors `View` (TODO P1 "Scrollback everywhere"):
 *   - follow the latest output by default
 *   - Ctrl+Up / Ctrl+U scroll back (pins away from the live tail)
 *   - Ctrl+Down / Ctrl+D / End returns to the live tail (and re-follows)
 *   - Home jumps to the top of the history
 * When scrolled away from the live tail a one-line footer indicator is shown
 * so it is obvious you are not looking at the latest output.
 */

import { Container, Text, matchesKey, type Component } from "@earendil-works/pi-tui";
import { colors } from "./theme.ts";

export class ReplTranscript extends Container {
	/** Pane height (rows of the repl viewport), set by the window manager. */
	private viewport = 24;
	/** Offset from the top of the full history at which the window starts. */
	private scrollTop = 0;
	/** True while pegged to the bottom; new output keeps us at the tail. */
	private followingEnd = true;
	/** Width used by the last render, reused for scroll-bounds maths. */
	private lastWidth = 80;

	invalidate(): void {
		for (const child of this.children) (child as Component).invalidate?.();
	}

	/** Append one line to the history and follow it (unless pinned back). */
	addLine(text: string): void {
		if (!text) return;
		this.addChild(new Text(text.replace(/\n$/, "")));
	}

	clear(): void {
		super.clear();
		this.scrollTop = 0;
		this.followingEnd = true;
	}

	/** Set the pane height (rows). */
	setViewportHeight(rows: number): void {
		this.viewport = Math.max(1, Math.floor(rows));
		const maxScroll = this.maxScroll();
		this.scrollTop = this.followingEnd ? maxScroll : Math.min(this.scrollTop, maxScroll);
	}

	/**
	 * Scroll the transcript; negative moves toward older output (up), positive
	 * toward the live tail. Returns lines not consumed when clamped at an edge.
	 */
	scrollBy(delta: number): number {
		if (!Number.isFinite(delta) || delta === 0) return 0;
		const maxScroll = this.maxScroll();
		if (delta < 0) {
			// Scroll up: leave the live tail, starting from the end.
			this.followingEnd = false;
			this.scrollTop = maxScroll;
		} else {
			this.scrollTop = this.followingEnd ? maxScroll : this.scrollTop;
		}
		const base = this.scrollTop;
		const next = Math.max(0, Math.min(maxScroll, base + Math.trunc(delta)));
		this.scrollTop = next;
		this.followingEnd = next >= maxScroll;
		return Math.trunc(delta) - (next - base);
	}

	scrollToStart(): void {
		this.followingEnd = false;
		this.scrollTop = 0;
	}

	scrollToEnd(): void {
		this.followingEnd = true;
		this.scrollTop = this.maxScroll();
	}

	get isScrolledBack(): boolean {
		return !this.followingEnd;
	}

	handleInput(data: string): void {
		const halfPage = Math.max(1, Math.floor(this.viewport / 2));
		if (matchesKey(data, "ctrl+up")) this.scrollBy(-halfPage);
		else if (matchesKey(data, "ctrl+b")) this.scrollBy(-halfPage);
		else if (matchesKey(data, "ctrl+down")) this.scrollBy(halfPage);
		else if (matchesKey(data, "ctrl+f")) this.scrollBy(halfPage);
		else if (matchesKey(data, "ctrl+u")) this.scrollBy(-halfPage);
		else if (matchesKey(data, "ctrl+d")) this.scrollBy(halfPage);
		else if (matchesKey(data, "home") || matchesKey(data, "ctrl+home")) this.scrollToStart();
		else if (matchesKey(data, "end") || matchesKey(data, "ctrl+end")) this.scrollToEnd();
	}

	render(width: number): string[] {
		this.lastWidth = Math.max(1, width);
		const all = this.renderChildren(this.lastWidth);
		const maxScroll = Math.max(0, all.length - this.viewport);
		this.scrollTop = this.followingEnd ? maxScroll : Math.min(this.scrollTop, maxScroll);

		const footer = !this.followingEnd;
		const bodyRows = footer ? Math.max(1, this.viewport - 1) : this.viewport;
		let from = Math.min(this.scrollTop, Math.max(0, all.length - bodyRows));
		const slice = all.slice(from, from + bodyRows);
		while (slice.length < bodyRows) slice.push("");
		if (footer) {
			slice.push(colors.muted(`⮕ ${all.length} lines · End/Ctrl+D to resume live`));
		}
		return slice.slice(0, this.viewport);
	}

	/** Total height of the full (unclipped) history. */
	private allHeight(): number {
		return this.renderChildren(this.lastWidth).length;
	}

	private maxScroll(): number {
		return Math.max(0, this.allHeight() - this.viewport);
	}

	/** Concatenate every child's rendered lines at the given width. */
	private renderChildren(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			for (const line of child.render(width)) lines.push(line);
		}
		return lines;
	}
}