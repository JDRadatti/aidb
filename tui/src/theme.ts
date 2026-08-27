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
	return (s: string) => `\x1b[${code}m${s}${RESET}`;
}

export interface ColorRoles {
	accent(s: string): string;
	muted(s: string): string;
	success(s: string): string;
	warning(s: string): string;
	error(s: string): string;
	bold(s: string): string;
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
	};
}

/** Live role set. Reassigned by `applyTheme`; imported by value by callers. */
export const colors: ColorRoles = buildColors({
	accent: 36,
	muted: 90,
	success: 32,
	warning: 33,
	error: 31,
	border: 90,
});

/** Swap the live colour roles in place (idempotent; used by /config reload). */
export function applyTheme(theme: ThemeConfig): void {
	Object.assign(colors, buildColors(theme));
}

export function createEditorTheme(theme: ThemeConfig | undefined): EditorTheme {
	const c = buildColors(theme ?? { accent: 36, muted: 90, success: 32, warning: 33, error: 31, border: 90 });
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