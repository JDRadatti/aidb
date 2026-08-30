/**
 * Colour roles for aidb's TUI.
 *
 * The roles are seeded from the layered config (`Config["theme"]`, TODO P1)
 * rather than hard-coded literals. `colors` is a mutable object reassigned by
 * `applyTheme`, so every module that imports `colors` directly (interpreters,
 * byte-renderers, main, spinner) picks up a reloaded colour scheme without
 * threading a theme through call sites. `bold` is a format role, not a colour,
 * and stays constant.
 */

import type { EditorTheme } from "@earendil-works/pi-tui";
import type { ThemeConfig } from "./config.ts";

const RESET = "\x1b[0m";

function fg(code: number): (s: string) => string {
	// Codes <128 are legacy/vivid (0-15, 30-37, 90-97). Codes >=128 need the
	// explicit 256-colour foreground form, otherwise a bare \x1b[245m is invalid.
	const seq = code >= 128 ? `38;5;${code}` : String(code);
	return (s: string) => `\x1b[${seq}m${s}${RESET}`;
}

/** 256-colour background fill for panes (uses the `48;5` form, not fg `+30`). */
function bg(code: number): (s: string) => string {
	return (s: string) => `\x1b[48;5;${code}m${s}${RESET}`;
}

export interface ColorRoles {
	accent(s: string): string;
	muted(s: string): string;
	success(s: string): string;
	warning(s: string): string;
	error(s: string): string;
	bold(s: string): string;
	/** Edge colour for borders / scrollbars. */
	border(s: string): string;
	/** Focused pane outline (white). */
	borderActive(s: string): string;
	/** Non-focused pane outline (subtle gray). */
	borderInactive(s: string): string;
	/** Shared pane fill (all panes the same colour). */
	paneBg(s: string): string;

	/* Semantic token roles (source + assembly share the same palette). */
	keyword(s: string): string;
	string(s: string): string;
	number(s: string): string;
	comment(s: string): string;
	mnemonic(s: string): string;
	register(s: string): string;
	directive(s: string): string;
}

/** Build the role set from a colour-code theme. */
export function buildColors(theme: ThemeConfig): ColorRoles {
	return {
		accent: fg(theme.accent),
		muted: fg(theme.muted),
		success: fg(theme.success),
		warning: fg(theme.warning),
		error: fg(theme.error),
		bold: (s: string) => `\x1b[1m${s}${RESET}`,
		border: fg(theme.border),
		borderActive: fg(theme.borderActive),
		borderInactive: fg(theme.borderInactive),
		paneBg: bg(theme.paneBg),
		keyword: fg(theme.keyword),
		string: fg(theme.string),
		number: fg(theme.number),
		comment: fg(theme.comment),
		mnemonic: fg(theme.mnemonic),
		register: fg(theme.register),
		directive: fg(theme.directive),
	};
}

/** Default palette, shared by the live reset and the no-config editor theme. */
const DEFAULT_THEME: ThemeConfig = {
	accent: 36,
	muted: 90,
	success: 32,
	warning: 33,
	error: 31,
	border: 90,
	borderActive: 255,
	borderInactive: 234,
	paneBg: 235,
	inputBg: 237,
	keyword: 36,
	string: 32,
	number: 33,
	comment: 90,
	mnemonic: 93,
	register: 94,
	directive: 96,
};

/** Live role set. Reassigned by `applyTheme`; imported by value by callers. */
export const colors: ColorRoles = buildColors(DEFAULT_THEME);

/** The live input-band background code, kept in sync by `applyTheme`. */
let inputBandCode = DEFAULT_THEME.inputBg;

/**
 * Raw `48;5;Nm` background fill for the prompt/editor chrome band. The band's
 * rendered lines carry per-span ANSI resets, so callers re-assert this fill
 * after every `\x1b[0m` (see `tintBand` in completion-overlay.ts).
 */
export function inputBgFill(): string {
	return `\x1b[48;5;${inputBandCode}m`;
}

/** Swap the live colour roles in place (idempotent; used by /config reload). */
export function applyTheme(theme: ThemeConfig): void {
	Object.assign(colors, buildColors(theme));
	inputBandCode = theme.inputBg;
}

export function createEditorTheme(theme: ThemeConfig | undefined): EditorTheme {
	const c = buildColors(theme ?? DEFAULT_THEME);
	return {
		borderColor: (s) => fg(theme?.border ?? 90)(s),
		selectList: {
			selectedPrefix: (s) => c.accent(s),
			selectedText: (s) => `\x1b[${theme?.accent ?? 36};1m${s}${RESET}`,
			description: (s) => c.muted(s),
			scrollInfo: (s) => c.muted(s),
			noMatch: (s) => c.error(s),
		},
	};
}