import type { EditorTheme } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";

function fg(code: number): (s: string) => string {
	return (s: string) => `\x1b[${code}m${s}${RESET}`;
}

export const colors = {
	accent: fg(36),
	muted: fg(90),
	success: fg(32),
	error: fg(31),
	warning: fg(33),
	bold: (s: string) => `\x1b[1m${s}${RESET}`,
};

export function createEditorTheme(): EditorTheme {
	return {
		borderColor: (s) => fg(90)(s),
		selectList: {
			selectedPrefix: (s) => fg(36)(s),
			selectedText: (s) => `\x1b[36;1m${s}${RESET}`,
			description: (s) => fg(90)(s),
			scrollInfo: (s) => fg(90)(s),
			noMatch: (s) => fg(31)(s),
		},
	};
}
