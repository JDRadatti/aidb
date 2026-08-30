/**
 * Built-in interpreters: the "how do we draw it" half of a watch window.
 * Pure functions from (snapshot, previous snapshot, rect) → lines. They
 * never touch gdb, which makes them golden-file testable and reusable for
 * the agent-facing snapshot exporter.
 *
 * Changed-value highlighting compares against `prev` and wraps cells in an
 * amber SGR run; pane tinting in pane-slab.ts re-opens backgrounds after
 * inner resets, so these escapes are safe inside panes.
 */

import type { BindingSnapshot, InterleavedRow, Interpreter, ObservationCapability, Rect, VarNode } from "./types.ts";
import { ViewFlags } from "./types.ts";
import type { RenderSpec } from "./render-spec.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	makeBitmapInterpreter,
	makeBytesInterpreter,
	makeCharsInterpreter,
	makeHexdumpInterpreter,
	makeTupleInterpreter,
	mark,
} from "./byte-renderers.ts";
import { colors } from "../theme.ts";

export {
	makeBitmapInterpreter,
	makeBytesInterpreter,
	makeCharsInterpreter,
	makeHexdumpInterpreter,
	makeTupleInterpreter,
	renderHexdump,
} from "./byte-renderers.ts";
export { renderBytes, renderChars, renderTuple, renderBitmap } from "./byte-renderers.ts";

/**
 * Per-line regex syntax highlighting — the same shape gdb uses via
 * source-highlight (regex + keyword sets, not a lexer). Kinds are resolved
 * through `colors.syntaxRole` so the kind→role map stays in one place
 * (theme.ts) and follows /config reload.
 *
 * Tokenization is per-line, so a block comment only colours on the line that
 * contains its terminator — acceptable for a debugger source pane (gdb's own
 * highlighter behaves the same without source-highlight installed); the
 * visible wins the lexer experiment brought are preserved here:
 *  - `#include`/`#define` become a `preprocessor` token (preproc role =
 *    nvim `@preproc`), not a whole-line bold-accent shortcut;
 *  - asm resolves the FIRST identifier as `mnemonic` and LATER ones as
 *    `symbol` (function role) — the old regex had those backwards;
 *  - numbers parse the full C/C++ literal (decimals `3.5`, exponents `1e-3`,
 *    hex `0x1F`, suffixes `42uL`) instead of stopping at the first dot;
 *  - angular jump-target suffixes (`<main+77>`) are ONE `label` token (nvim
 *    `@label`), deliberately dim so branch operands recede;
 *  - the current source line / instruction is wrapped like the fuzzy
 *    picker's selected row (bold + accent over the whole row, token colors
 *    re-opened inside) via `currentLineWrap`.
 */

function highlightCode(line: string): string {
	const token = /(#[A-Za-z_]\w*|\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]+)?(?:[pP][+-]?\d+)?|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[fFlLuU]*\b|\b[A-Za-z_]\w*\b)/g;
	let result = "";
	let offset = 0;
	for (const match of line.matchAll(token)) {
		const value = match[0];
		const index = match.index ?? 0;
		result += line.slice(offset, index);
		let wrap: ((s: string) => string) | null = null;
		if (value.startsWith("//") || value.startsWith("/*")) wrap = colors.syntaxRole("comment");
		else if (value.startsWith('"') || value.startsWith("'")) wrap = colors.syntaxRole("string");
		else if (value.startsWith("#")) wrap = colors.syntaxRole("preprocessor");
		else if (/^\d/.test(value)) wrap = colors.syntaxRole("number");
		else if (TYPES.has(value)) wrap = colors.syntaxRole("type");
		else if (KEYWORDS.has(value)) wrap = colors.syntaxRole("keyword");
		result += wrap ? wrap(value) : value;
		offset = index + value.length;
	}
	return result + line.slice(offset);
}

/**
 * Colour the operands of one disassembled instruction: the FIRST bare
 * identifier is the mnemonic (`colors.mnemonic`); every later one is a
 * symbol/function name (`colors.function`) — the old regex had this
 * backwards (bold-accent on the mnemonic, magenta on operand symbols).
 * %-registers, $-immediates, numbers, directives and #-comments each
 * resolve through `colors.asmRole`.
 */
function highlightAsm(line: string): string {
	const token = /(#[^\n]*|\$(?:-?0[xX][0-9a-fA-F]+|-?\d+)|%\w+|<[^ \t,>]+>|\b\d+(?:[xX][0-9a-fA-F]+)?\b|\.\w+|\b[A-Za-z_.][\w.-]*\b)/g;
	let result = "";
	let offset = 0;
	let firstIdentifier = true;
	for (const match of line.matchAll(token)) {
		const value = match[0];
		const index = match.index ?? 0;
		result += line.slice(offset, index);
		let wrap: ((s: string) => string) | null;
		if (value.startsWith("#")) wrap = colors.asmRole("comment");
		else if (value.startsWith("$")) wrap = colors.asmRole("immediate");
		else if (value.startsWith("%")) wrap = colors.asmRole("register");
		else if (value.startsWith("<")) wrap = colors.asmRole("label");
		else if (/^\d/.test(value)) wrap = colors.asmRole("number");
		else if (value.startsWith(".") && /^\.[A-Za-z]/.test(value)) wrap = colors.asmRole("directive");
		else {
			wrap = firstIdentifier ? colors.asmRole("mnemonic") : colors.asmRole("symbol");
			firstIdentifier = false;
		}
		result += wrap ? wrap(value) : value;
		offset = index + value.length;
	}
	return result + line.slice(offset);
}

const KEYWORDS = new Set([
	"alignas", "alignof", "and", "asm", "auto", "break", "case", "catch", "class", "const", "constexpr", "continue", "default", "delete", "do", "else", "enum", "explicit", "export", "extern", "false", "for", "friend", "goto", "if", "inline", "namespace", "new", "noexcept", "not", "nullptr", "operator", "or", "private", "protected", "public", "register", "reinterpret_cast", "return", "sizeof", "static", "static_cast", "struct", "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union", "using", "virtual", "volatile", "while", "xor",
]);

/** C scalar builtin types — colored with the `type` role (nvim `@type`), so
 * themes can give them a colour distinct from statement keywords the way
 * nvim themes do (@type vs @keyword). */
const TYPES = new Set(["bool", "char", "double", "float", "int", "long", "short", "signed", "unsigned", "void", "wchar_t"]);

function errorLines(snap: BindingSnapshot): string[] {
	return [colors.error(`✗ ${snap.error}`)];
}

function formatNumber(value: number): string {
	return Number(value.toFixed(4)).toString();
}

/** Universal fallback: one value line per snapshot. */
export function renderValueLines(snap: BindingSnapshot): string[] {
	if (snap.error) return errorLines(snap);
	return [snap.value ?? "—"];
}

/** Render text lines without adding code-specific gutters or markers. */
export function renderText(snap: BindingSnapshot): string[] {
	if (snap.error) return errorLines(snap);
	return snap.lines ?? (snap.value === undefined ? ["waiting for data…"] : [snap.value]);
}

/**
 * Pad `text` to `width` columns of VISIBLE width. `.padEnd` counts SGR
 * escape bytes as characters, so a colored symbol (`<main>`) padded the naive
 * way collapses the gap to nothing while an empty symbol leaves a wide hole —
 * the instruction column wobbled between rows. `visibleWidth` strips the
 * escapes; the padding then lands after the reset, leaving a stable column.
 */
function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Wrap one rendered row the way the fuzzy picker draws its selected row:
 * bold + accent over the whole line (`colors.bold(colors.accent(…))` — the
 * picker's `selectedText` wrap), RE-OPENING the wrap after every inner SGR
 * reset so per-token colours survive inside the highlight instead of the
 * first token's reset killing it for the rest of the row.
 */
function currentLineWrap(text: string): string {
	// Build `\x1b[1m` + the accent opener WITHOUT composing the wrappers
	// (colors.bold(colors.accent("")) would embed a mid-string reset and
	// cancel the bold before any text).
	const open = `\x1b[1m${colors.accent("").slice(0, -4)}`;
	return open + text.replace(/\x1b\[0m/g, `\x1b[0m${open}`) + "\x1b[0m";
}

/** Render source or assembly with a compact current-location marker. */
export function renderCode(snap: BindingSnapshot, _prev: BindingSnapshot | undefined, rect: Rect): string[] {
	if (snap.error) return errorLines(snap);
	if (snap.kind === "assembly") {
		const instructions = snap.instructions ?? [];
		if (instructions.length === 0) return ["waiting for data…"];
		let currentSymbol: string | undefined;
		const lines = instructions.map((instruction) => {
			if (instruction.symbol) currentSymbol = instruction.symbol;
			const current = instruction.current || sameAddress(instruction.address, snap.currentAddress);
			const marker = current ? "▶" : " ";
			const breakpoint = instruction.line === undefined ? undefined : snap.breakpoints?.find((candidate) => candidate.line === instruction.line);
			const breakpointMarker = breakpoint ? (breakpoint.verified ? "●" : "○") : " ";
			const sourceLine = instruction.line === undefined ? "     " : String(instruction.line).padStart(5);
			const row = formatInstruction(
				`${marker} ${breakpointMarker} ${sourceLine} `,
				instruction.address,
				currentSymbol,
				instruction.instruction,
			);
			return current ? currentLineWrap(row) : row;
		});
		return snap.info ? [colors.muted(`i ${snap.info}`), ...lines] : lines;
	}
	const lines = snap.lines ?? [];
	if (lines.length === 0) return ["waiting for data…"];
	const start = snap.startLine ?? 1;
	return lines.map((line, index) => {
		const number = start + index;
		const current = number === snap.currentLine;
		const breakpoint = snap.breakpoints?.find((candidate) => candidate.line === number);
		const executionMarker = current ? "▶" : " ";
		const breakpointMarker = breakpoint ? (breakpoint.verified ? "●" : "○") : " ";
		const numberAndCode = `${String(number).padStart(5)} │ `;
		if (current) return currentLineWrap(`${executionMarker} ${breakpointMarker} ${numberAndCode}${highlightCode(line)}`);
		const gutter = breakpoint ? `${executionMarker} ${colors.error(breakpointMarker)} ${numberAndCode}` : `${executionMarker} ${breakpointMarker} ${numberAndCode}`;
		return gutter + highlightCode(line);
	});
}

/** One instruction row: gutter · address · function symbol · instruction. */
function formatInstruction(gutter: string, address: string, symbol: string | undefined, instruction: string): string {
	const symbolTag = symbol ? `<${symbol}>` : "";
	// Address and symbol are padded to a fixed VISIBLE column footprint, so
	// rows with and without a symbol line up (_that_ is the "gdb makes a clear
	// distinction between src and func name" gap — the old padEnd counted
	// escape bytes as characters and drifted by (18 - len) per row). The
	// symbol gets its own color role (`function`); the mnemonic gets the
	// `mnemonic` role and operands resolve register/immediate/number/function
	// via the asm regex.
	return `${gutter}${colors.muted(padVisible(address, 18))} ${colors.function(padVisible(symbolTag, 20))} ${highlightAsm(instruction)}`;
}

export function renderInterleaved(snap: BindingSnapshot): string[] {
	if (snap.error) return errorLines(snap);
	const rows = snap.interleaved ?? [];
	if (rows.length === 0) return ["waiting for data…"];
	const lines = rows.map((entry: InterleavedRow) => {
		if (entry.kind === "source") {
			const breakpoint = snap.breakpoints?.find((candidate) => candidate.line === entry.line);
			const marker = entry.current ? "▶" : " ";
			const breakpointMarker = breakpoint ? (breakpoint.verified ? "●" : "○") : " ";
			const prefix = `${marker} ${breakpointMarker} ${String(entry.line).padStart(5)} │ `;
			return entry.current ? currentLineWrap(prefix + highlightCode(entry.text)) : prefix + highlightCode(entry.text);
		}
		const instruction = entry.instruction;
		// The `│` gutter keeps the rail at the same column as the code renderer's
		// source rows (marker + breakpoint + 5-digit line column, pipe at index 10)
		// — both are the solid `│` so the rail reads as one continuous line. The
		// assembly content starts at the same column as the source code above it
		// (one space after the rail), so a mapped instruction recedes under its
		// source line without extra indentation.
		const marker = instruction.current ? "▶" : " ";
		const row = formatInstruction(`${marker}         │ `, instruction.address, instruction.symbol, instruction.instruction);
		return instruction.current ? currentLineWrap(row) : row;
	});
	return snap.info ? [colors.muted(`i ${snap.info}`), ...lines] : lines;
}

function sameAddress(left: string, right: string | undefined): boolean {
	if (!right) return false;
	const leftMatch = left.match(/0[xX][0-9a-fA-F]+/);
	const rightMatch = right.match(/0[xX][0-9a-fA-F]+/);
	if (!leftMatch || !rightMatch) return left.toLowerCase() === right.toLowerCase();
	try {
		return BigInt(leftMatch[0]) === BigInt(rightMatch[0]);
	} catch {
		return leftMatch[0].toLowerCase() === rightMatch[0].toLowerCase();
	}
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** One-stop-per-sample bar sparkline with a min/max/last footer. */
export function renderSparkline(snap: BindingSnapshot, _prev: BindingSnapshot | undefined, rect: Rect): string[] {
	if (snap.error) return errorLines(snap);
	const samples = snap.samples ?? [];
	if (samples.length === 0) return ["(no samples yet — refresh after a stop)"];

	const width = Math.max(1, Math.min(rect.width, samples.length));
	const bucketSize = Math.ceil(samples.length / width);
	const peaks = Array.from({ length: width }, () => -Infinity);
	samples.forEach((value, index) => {
		const bucket = Math.min(width - 1, Math.floor(index / bucketSize));
		if (value > peaks[bucket]) peaks[bucket] = value;
	});

	const min = Math.min(...samples);
	const max = Math.max(...samples);
	const span = max - min;
	const row = peaks
		.map((peak) => {
			if (peak === -Infinity) return " ";
			// A constant series would divide by zero and land on block 0
			// (invisible); pin it to the middle of the range instead.
			const level = span === 0 ? Math.floor((BLOCKS.length - 1) / 2) : Math.round(((peak - min) / span) * (BLOCKS.length - 1));
			return BLOCKS[level];
		})
		.join("");
	return [
		row,
		`min ${formatNumber(min)} · max ${formatNumber(max)} · last ${formatNumber(samples[samples.length - 1]!)} · ${samples.length} stops`,
	];
}

/** Struct tree with ├─/└─ guides; leaf values differing from `prev` get a ▲ marker. */
export function renderTree(snap: BindingSnapshot, prev: BindingSnapshot | undefined, _rect: Rect): string[] {
	if (snap.error) return errorLines(snap);
	const tree = snap.tree;
	if (!tree) return ["waiting for data…"];

	const previousValues = new Map<string, string>();
	const collect = (node: VarNode, path: string): void => {
		if (node.children?.length) {
			for (const child of node.children) collect(child, path ? `${path}/${child.name}` : child.name);
		} else {
			previousValues.set(path, node.value);
		}
	};
	if (prev?.tree) collect(prev.tree, prev.tree.name);

	const lines: string[] = [];
	const emit = (node: VarNode, path: string, prefix: string, isLast: boolean, isRoot: boolean): void => {
		const guide = isRoot ? "" : prefix + (isLast ? "└─ " : "├─ ");
		const label = node.type ? `${node.name}: ${node.type}` : node.name;
		const value = node.value;
		const changed = previousValues.has(path) && previousValues.get(path) !== value;
		const marker = node.hasChildren && !node.children?.length ? " …" : "";
		lines.push(`${guide}${label}${mark(changed, ` = ${value}${changed ? " ▲" : ""}`)}${marker}`);
		const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
		const children = node.children ?? [];
		children.forEach((child, index) => {
			emit(child, path ? `${path}/${child.name}` : child.name, childPrefix, index === children.length - 1, false);
		});
	};
	emit(tree, tree.name, "", true, true);
	return lines;
}

/** Aligned columns (registers etc.); cells differing from `prev` are marked. */
export function renderTable(snap: BindingSnapshot, prev: BindingSnapshot | undefined, _rect: Rect): string[] {
	if (snap.error) return errorLines(snap);
	const rows = snap.rows ?? [];
	if (rows.length === 0) return ["waiting for data…"];

	const columnCount = Math.max(...rows.map((row) => row.length));
	const widths: number[] = [];
	for (let c = 0; c < columnCount; c++) {
		widths.push(Math.min(48, Math.max(...rows.map((row) => (row[c] ?? "").length))));
	}

	return rows.map((row, r) =>
		row
			.map((cell, c) => {
			const changed = prev?.rows?.[r]?.[c] !== undefined && prev.rows[r][c] !== cell;
			// The last column is not padded but still gets change marking —
			// for register rows the value column is the one that moves.
			const padded = c === row.length - 1 ? cell : cell.padEnd(widths[c]!);
			return mark(changed, padded);
			})
			.join("  "),
	);
}

function guarded(render: (snap: BindingSnapshot, prev: BindingSnapshot | undefined, rect: Rect) => string[]) {
	return (snap: BindingSnapshot | undefined, prev: BindingSnapshot | undefined, rect: Rect): string[] => {
		if (!snap) return ["waiting for data…"];
		return render(snap, prev, rect);
	};
}

function hasCapability(snap: BindingSnapshot, capability: ObservationCapability): boolean {
	switch (capability) {
		case "value": return snap.value !== undefined;
		case "memory": return snap.bytes !== undefined;
		case "tree": return snap.tree !== undefined;
		case "rows": return snap.rows !== undefined;
		case "lines": return snap.lines !== undefined;
		case "assembly": return snap.instructions !== undefined;
		case "interleaved": return snap.interleaved !== undefined;
		case "samples": return snap.samples !== undefined;
	}
}

/** Return a stable explanation when a renderer cannot consume an observation. */
export function missingRequirements(interpreter: Interpreter, snap: BindingSnapshot | undefined): string | undefined {
	if (!snap) return undefined;
	const missing = (interpreter.requires ?? []).filter((capability) => !hasCapability(snap, capability));
	if (missing.length > 0) return `renderer '${interpreter.id}' requires: ${missing.join(", ")}`;
	if (interpreter.requiresAny && !interpreter.requiresAny.some((capability) => hasCapability(snap, capability))) {
		return `renderer '${interpreter.id}' requires one of: ${interpreter.requiresAny.join(", ")}`;
	}
	return undefined;
}

/** Render through the registry's capability contract. Explicit flags override `defaultFlags`. */
export function renderInterpreter(
	interpreter: Interpreter,
	snap: BindingSnapshot | undefined,
	prev: BindingSnapshot | undefined,
	rect: Rect,
	flags?: ViewFlags,
): string[] {
	// Preserve the binding's actual failure; requirements describe data
	// compatibility and should not hide the useful error message.
	if (snap?.error) return interpreter.render(snap, prev, rect, effectiveFlags(interpreter, flags));
	const requirementError = missingRequirements(interpreter, snap);
	if (requirementError) return [`✗ ${requirementError}`];
	return interpreter.render(snap, prev, rect, effectiveFlags(interpreter, flags));
}

/** Explicit flags win; otherwise use the interpreter's declared defaults (empty when none). */
function effectiveFlags(interpreter: Interpreter, flags?: ViewFlags): ViewFlags {
	return flags ?? (interpreter.defaultFlags ?? ViewFlags.None);
}

/** Registry powering the `/win pick` menu and pane mounting. */
export const INTERPRETERS: Record<string, Interpreter> = {
	lines: { id: "lines", title: "value lines", requires: ["value"], render: guarded((snap) => renderValueLines(snap)) },
	text: { id: "text", title: "text", render: guarded((snap) => renderText(snap)) },
	code: { id: "code", title: "code", requiresAny: ["lines", "assembly"], render: guarded(renderCode) },
	iasm: { id: "iasm", title: "interleaved assembly", requiresAny: ["interleaved", "assembly"], render: guarded((snap) => renderInterleaved(snap)) },
	"struct-tree": { id: "struct-tree", title: "struct tree", requires: ["tree"], render: guarded(renderTree) },
	sparkline: { id: "sparkline", title: "sparkline", requires: ["samples"], render: guarded(renderSparkline) },
	hexdump: makeHexdumpInterpreter(),
	bytes: makeBytesInterpreter(),
	chars: makeCharsInterpreter(),
	tuple: makeTupleInterpreter({ elementWidth: 1, signed: false, format: "dec", tupleWidth: 3 }),
	bitmap: makeBitmapInterpreter(),
	table: { id: "table", title: "table", requires: ["rows"], render: guarded(renderTable) },
};

/** Filter a RenderSpec through an interpreter: flags default to the interpreter's defaults. */
export function specFlags(interpreter: Interpreter, spec: RenderSpec): ViewFlags {
	return spec.flags ?? (interpreter.defaultFlags ?? ViewFlags.None);
}
