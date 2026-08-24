/**
 * Visual scaffolding for isolated window testing: every pane gets a stable
 * background color derived from its INDEX, and blank panes show that index as
 * a giant block-digit numeral. Once the window mechanics are trusted, real
 * views replace slabs without touching layout code.
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { applyBackgroundToLine } from "@earendil-works/pi-tui/dist/utils.js";

const RESET = "\x1b[0m";

interface PaneColor {
	/** truecolor background escape */
	bg: string;
	/** truecolor foreground escape */
	fg: string;
	label: string;
}

export const PANE_PALETTE: PaneColor[] = [
	{ bg: "\x1b[48;2;22;50;74m", fg: "\x1b[38;2;127;212;255m", label: "blue" },
	{ bg: "\x1b[48;2;44;32;68m", fg: "\x1b[38;2;201;166;255m", label: "plum" },
	{ bg: "\x1b[48;2;20;53;42m", fg: "\x1b[38;2;127;224;184m", label: "pine" },
	{ bg: "\x1b[48;2;58;42;20m", fg: "\x1b[38;2;255;212;127m", label: "amber" },
	{ bg: "\x1b[48;2;58;20;32m", fg: "\x1b[38;2;255;159;176m", label: "rose" },
	{ bg: "\x1b[48;2;18;51;58m", fg: "\x1b[38;2;134;230;242m", label: "cyan" },
];

export function paneColor(idx: number): PaneColor {
	return PANE_PALETTE[((idx % PANE_PALETTE.length) + PANE_PALETTE.length) % PANE_PALETTE.length];
}

/**
 * Pad to `width` and paint the pane background. Inner SGR resets are re-opened
 * with the background so colored content doesn't leave patchwork stripes.
 */
export function tint(line: string, width: number, idx: number): string {
	const color = paneColor(idx);
	// Empty ellipsis: clip hard, never spend pane columns on "...".
	return applyBackgroundToLine(truncateToWidth(line, width, ""), width, (text: string) =>
		color.bg + text.replaceAll(RESET, RESET + color.bg) + RESET,
	);
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
	"9": ["███", "█.█", "███", "..█", "..█"],
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
 * A blank pane: pane-colored background (applied by the window chrome),
 * giant index numeral centered in the middle. Exists purely so splits,
 * closes and switches are verifiable at a glance.
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
			return " ".repeat(left) + paneColor(idx).fg + text + RESET;
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
