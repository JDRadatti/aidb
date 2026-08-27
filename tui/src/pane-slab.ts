/**
 * Visual scaffolding for isolated window testing: panes carry no background
 * fill — only a border outline (accent/white when active, subtle gray when
 * not). Blank panes show their index as a giant block-digit numeral so
 * splits/closes/switches stay verifiable at a glance.
 */

import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { colors } from "./theme.ts";

const RESET = "\x1b[0m";

/**
 * Pad a line (which may contain ANSI) to exactly `width` columns with spaces.
 * Adds no background, so each pane's own content colour scheme (e.g. the REPL
 * log) is preserved and border glyphs stay flush against the pane edge.
 */
export function padTo(line: string, width: number): string {
	const trimmed = truncateToWidth(line, width, "");
	return trimmed + " ".repeat(Math.max(0, width - visibleWidth(trimmed)));
}

/** Components the window manager can resize vertically (besides Views). */
export interface BodyRowsAware {
	setBodyRows(rows: number): void;
}

/** 5-row, 3-column block digits for the slab numeral. */
const DIGITS: Record<string, string[]> = {
	"0": ["███", "█ █", "█ █", "█ █", "███"],
	"1": [".█.", "██.", ".█.", ".█.", "███"],
	"2": ["███", "..█", "███", "█..", "███"],
	"3": ["███", "..█", "███", "..█", "███"],
	"4": ["█.█", "█.█", "███", "..█", "..█"],
	"5": ["███", "█..", "███", "..█", "███"],
	"6": ["███", "█..", "███", "█.█", "███"],
	"7": ["███", "..█", "..█", "..█", "..█"],
	"8": ["███", "█.█", "███", "█.█", "███"],
	"9": ["███", "█.█", "███", "..█", "███"],
	"?": ["███", "..█", ".██", "..█", ".██"],
};

function bigNumber(n: number): string[] {
	const rows = ["", "", "", "", ""];
	for (const ch of String(n)) {
		const glyph = DIGITS[ch] ?? DIGITS["?"];
		for (let r = 0; r < 5; r++) rows[r] += glyph[r] + " ";
	}
	return rows;
}

/**
 * A blank pane: shared pane-coloured background (applied by the window
 * chrome), giant index numeral centred in the middle. Exists purely so
 * splits, closes and switches are verifiable at a glance.
 */
export class IndexSlab implements Component {
	private bodyRows = 12;
	private readonly getIndex: () => number;

	constructor(getIndex: () => number) {
		this.getIndex = getIndex;
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(1, rows);
	}

	render(width: number): string[] {
		const idx = this.getIndex();
		const art = bigNumber(idx).map((row) => {
			const text = row.replaceAll(".", " ");
			const left = Math.max(0, Math.floor((width - text.length) / 2));
			return " ".repeat(left) + colors.muted(text) + RESET;
		});
		const padTop = Math.max(0, Math.floor((this.bodyRows - art.length) / 2));
		const lines: string[] = [];
		for (let i = 0; i < padTop; i++) lines.push("");
		lines.push(...art);
		while (lines.length < this.bodyRows) lines.push("");
		return lines.slice(0, this.bodyRows);
	}

	invalidate(): void {}
}