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
	/** The prompt zone's frame (divider above the band, left rail). */
	inputBorder(s: string): string;
	/** Focused pane outline (white). */
	borderActive(s: string): string;
	/** Non-focused pane outline (subtle gray). */
	borderInactive(s: string): string;
	/** Shared pane fill (all panes the same colour). */
	paneBg(s: string): string;

	/* Semantic token roles (source + assembly share the same palette).
 * Named to match nvim's standard treesitter highlight groups so a theme
 * ported from nvim (e.g. ``{ "@keyword": … }`` in a lua config) maps onto
 * the same keys here: keyword→@keyword, string→@string, number→@number,
 * comment→@comment, function→@function, type→@type, preproc→@preproc,
 * label→@label. The asm-only roles keep nvim's legacy asm syntax names
 * (`asmMnemonic` / `asmRegister`). */
	keyword(s: string): string;
	string(s: string): string;
	number(s: string): string;
	comment(s: string): string;
	/** C builtin types (int, char, void, …) — nvim `@type`/`@type.builtin`. */
	type(s: string): string;
	/** `#include`/`#define` and asm directives (`.section`) — nvim `@preproc`. */
	preproc(s: string): string;
	mnemonic(s: string): string;
	register(s: string): string;
	/** Function/symbol labels in assembly columns (`<main+4>`). */
	function(s: string): string;
	/** Assembly jump-target suffixes (`<main+77>` at the end of a branch) — nvim `@label`; deliberately dim. */
	label(s: string): string;
	/** Placeholder args (`<name>`) in command help / dropdown hints. */
	placeholder(s: string): string;

	/* Token-kind → role resolution (the single place that decides what a
	 * token gets coloured with; used by the source/asm highlighters in viz). */
	syntaxRole(kind: SyntaxKind): ColorWrap;
	asmRole(kind: AsmTokenKind): ColorWrap;
}

/** A text wrapper: the colour fn or null to leave the terminal foreground. */
export type ColorWrap = ((s: string) => string) | null;

import type { SyntaxKind, AsmTokenKind } from "./viz/types.ts";

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
		inputBorder: fg(theme.inputBorder),
		borderActive: fg(theme.borderActive),
		borderInactive: fg(theme.borderInactive),
		paneBg: bg(theme.paneBg),
		keyword: fg(theme.keyword),
		string: fg(theme.string),
		number: fg(theme.number),
		comment: fg(theme.comment),
		type: fg(theme.type),
		preproc: fg(theme.preproc),
		mnemonic: fg(theme.mnemonic),
		register: fg(theme.register),
		function: fg(theme.function),
		label: fg(theme.label),
		placeholder: fg(theme.placeholder),
		/* Token-kind → role resolutions. Identifiers, punctuation and
		 * whitespace stay terminal-default (null) so code reads naturally;
		 * every other kind is pinned to a role. These closures read the live
		 * `colors` object at call time, so /config reload re-colours existing
		 * panes without a re-render trigger. */
		syntaxRole: (kind) => {
			switch (kind) {
				case "comment": return colors.comment;
				case "string":
				case "char": return colors.string;
				case "number": return colors.number;
				case "keyword": return colors.keyword;
				case "type": return colors.type;
				case "preprocessor": return colors.preproc;
				default: return null;
			}
		},
		asmRole: (kind) => {
			switch (kind) {
				case "mnemonic": return colors.mnemonic;
				case "register": return colors.register;
				case "immediate":
				case "number": return colors.number;
				case "directive": return colors.preproc;
				case "symbol": return colors.function;
				case "label": return colors.label;
				case "comment": return colors.comment;
				default: return null;
			}
		},
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
	inputBorder: 240,
	keyword: 36,
	string: 32,
	number: 33,
	comment: 90,
	type: 36,
	preproc: 96,
	mnemonic: 93,
	register: 94,
	function: 95,
	/** Jump-target suffixes stay quiet: a mid gray, far less loud than `function`. */
	label: 102,
	placeholder: 245,
};

/** Live role set. Reassigned by `applyTheme`; imported by value by callers. */
export const colors: ColorRoles = buildColors(DEFAULT_THEME);

/**
 * The default palette is deliberately NOT one of the presets (they live in
 * config.ts and are opt-in via `theme: "<name>"` / `/theme`): this ANSI
 * set is the zero-config baseline that the golden render tests pin. The
 * token→role mapping above is what makes the same palette read coherently
 * across source, asm and UI — every kind has ONE role and every role has a
 * reason.
 */

/** Swap the live colour roles in place (idempotent; used by /config reload). */
export function applyTheme(theme: ThemeConfig): void {
	Object.assign(colors, buildColors(theme));
}

/** The live muted run's opening escape (`\x1b[90m`), so a nested token can
 * re-open the surrounding muted colour after its own reset. */
const mutedOpen = colors.muted("").slice(0, -4);

/**
 * Tint `<placeholder>` tokens (e.g. `<name>`, `<idx|name>`, `<expr>`) in the
 * lighter `placeholder` colour so they read as "you fill this in" rather than
 * literal text. With `restoreMuted`, each tinted token re-opens the muted run
 * that a wrapping theme (the dropdown's `description` role) applied, instead
 * of the token's reset killing the wrap for the rest of the line.
 */
export function dimPlaceholders(text: string, restoreMuted = false): string {
	return text.replace(/<[^>]+>/g, (token) => `${colors.placeholder(token)}${restoreMuted ? mutedOpen : ""}`);
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