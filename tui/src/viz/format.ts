/**
 * Per-type value formatting for watch values.
 *
 * gdb's raw to-string is fine for ints but noisy elsewhere: `char` prints as
 * a bare number, `_Bool` as 1/0, char arrays carry their nul padding, and
 * padded table-ish values (enums) land with trailing whitespace. These
 * helpers turn one `value` + `type` pair into a display string. They are
 * pure, so golden tests cover them without a debugger (TESTING STRATEGY).
 */

const CHAR_ESCAPES: Record<number, string> = {
	0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r",
};

/** C escape for a control char, or the printable glyph itself. */
export function charGlyph(code: number): string {
	const escaped = CHAR_ESCAPES[code];
	if (escaped !== undefined) return escaped;
	if (code >= 32 && code < 127) return String.fromCharCode(code);
	return "";
}

/** `char` scalar (NOT `char [N]` / `char *`, which are C strings). */
export function isCharScalar(type: string | undefined): boolean {
	const t = (type ?? "").trim().toLowerCase();
	return t === "char" || t === "signed char" || t === "unsigned char";
}

/** `char *` / `char [N]` / `const char *` / `unsigned char [4]` … C strings.
 * The value of such an expression is already a quoted literal, so we keep
 * the string form rather than treating it as one scalar char. */
export function isStringType(type: string | undefined): boolean {
	const t = (type ?? "").trim().toLowerCase();
	return /^(?:(?:const|volatile)\s+)?char\s*(\[\d*\]|\*)/.test(t) ||
		/^(?:(?:const|volatile)\s+)?(?:signed|unsigned)\s+char\s*(\[\d*\]|\*)/.test(t);
}

/** `99 'c'` for a char code, with C escapes for control characters. */
export function formatCharCode(code: number): string {
	const glyph = charGlyph(code);
	return `${code} '${glyph === "" ? `\\x${code.toString(16)}` : glyph}'`;
}

/** Collapse runs of whitespace (gdb pads table-ish values) and trim. */
export function collapseValue(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Cut gdb's char-array padding and repeat-elision: `"hello\000\000\377"` →
 * `"hello"`; `"hey", '\000' <repeats 12 times>` → `"hey"`. The first quoted
 * literal is the payload; a trailing `\000` inside it is a C-string
 * terminator, and everything after the literal is gdb's tail elision. */
export function cleanupStringResult(value: string): string {
	const literal = /^("(?:\\.|[^"\\])*")/.exec(value);
	if (!literal) return value;
	let text = literal[1]!;
	const nul = text.indexOf("\\000");
	if (nul >= 0) text = `${text.slice(0, nul)}"`;
	return text;
}

/** Truncate plain text, appending an ellipsis when cut. */
export function truncateText(text: string, maxLength: number): string {
	if (maxLength <= 0 || text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).replace(/\s+$/, "")}…`;
}

const FLOAT_TYPES = new Set(["float", "double", "long double"]);

/** Round noisy gdb float to-strings (`3.1400000000000001` → `3.14`). */
function formatFloat(text: string): string {
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) return text;
	return String(Number(parsed.toFixed(4)));
}

/**
 * Format one scalar / string / aggregate-summary gdb value for display. Pure:
 * the whole call is (value, type) → string, so renderers and tests share
 * exactly one rulebook.
 *
 *  - `char` scalars get a glyph (`104 'h'`); gdb's own `99 'c'` is kept.
 *  - `_Bool` / `bool` 0|1 becomes true/false.
 *  - floats are rounded down to a sane precision.
 *  - `char [N]` / `char *` values (already quoted) lose their nul padding.
 *  - everything else is whitespace-collapsed and length-capped.
 */
export function formatValue(value: string | undefined, type?: string, maxLength = 120): string {
	if (value === undefined || value === "") return value ?? "—";
	let text = value.trim();
	if (text === "") return text;
	const t = (type ?? "").trim().toLowerCase();

	if (isCharScalar(type) && !/^\d+\s+'/.test(text)) {
		const code = Number.parseInt(text, 10);
		if (Number.isInteger(code)) text = formatCharCode(code);
	}
	if (isStringType(type) && text.startsWith('"')) {
		return truncateText(cleanupStringResult(text), maxLength);
	}
	if ((t === "bool" || t === "_bool") && (text === "0" || text === "1")) {
		text = text === "1" ? "true" : "false";
	}
	if (FLOAT_TYPES.has(t) && /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(text)) {
		text = formatFloat(text);
	}
	return truncateText(collapseValue(text), maxLength);
}

/**
 * Short label for an aggregate root: `int [4]` stays, `std::vector<int,
 * std::allocator<int> >` becomes `std::vector<…>`, and unknown types keep
 * their name plus an element count when one is known.
 */
export function arrayTypeLabel(type: string | undefined, countHint?: number): string {
	const t = (type ?? "").trim();
	let label: string;
	if (!t) label = "array";
	else if (/\[\d*\]/.test(t)) label = t;
	else if (t.includes("<") && t.endsWith(">")) label = `${t.slice(0, t.indexOf("<") + 1)}…>`;
	else label = t;
	if (countHint !== undefined && !/\[\d*\]/.test(label)) label = `${label} · ${countHint} elements`;
	return label;
}