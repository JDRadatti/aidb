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

const KEYWORDS = new Set([
	"alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr", "continue", "default", "delete", "do", "double", "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend", "goto", "if", "inline", "int", "long", "namespace", "new", "noexcept", "not", "nullptr", "operator", "or", "private", "protected", "public", "register", "reinterpret_cast", "return", "short", "signed", "sizeof", "static", "static_cast", "struct", "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual", "void", "volatile", "wchar_t", "while", "xor",
]);

function highlightCode(line: string): string {
	if (/^\s*#/.test(line)) return colors.bold(colors.accent(line));
	const token = /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
	let result = "";
	let offset = 0;
	for (const match of line.matchAll(token)) {
		const value = match[0];
		const index = match.index ?? 0;
		result += line.slice(offset, index);
		if (value.startsWith("//") || value.startsWith("/*")) result += colors.comment(value);
		else if (value.startsWith('"') || value.startsWith("'")) result += colors.string(value);
		else if (/^\d/.test(value)) result += colors.number(value);
		else if (KEYWORDS.has(value)) result += colors.keyword(value);
		else result += value;
		offset = index + value.length;
	}
	return result + line.slice(offset);
}

/**
 * Colour the mnemonic (/AT&T) operands of a single disassembled instruction:
 * the first identifier is the mnemonic, then %-registers, $-immediates,
 * constant addresses, directives and #-comments each get a token role.
 */
function highlightAsm(line: string): string {
	const token = /(#[^\n]*|\$[^ \t,]|%\w+|\b\d+(?:[xX][0-9a-fA-F]+)?\b|\.\w+|\b[A-Za-z_.][\w.-]*\b)/g;
	let result = "";
	let offset = 0;
	let firstIdentifier = false;
	for (const match of line.matchAll(token)) {
		const value = match[0];
		const index = match.index ?? 0;
		result += line.slice(offset, index);
		let wrap: (s: string) => string;
		if (value.startsWith("#")) wrap = colors.comment;
		else if (value.startsWith("$")) wrap = colors.number;
		else if (value.startsWith("%")) wrap = colors.register;
		else if (/^\d/.test(value)) wrap = colors.number;
		else if (value.startsWith(".") && /^\.[A-Za-z]/.test(value)) wrap = colors.directive;
		else {
			wrap = firstIdentifier ? colors.mnemonic : (s: string) => colors.bold(colors.accent(s));
			firstIdentifier = true;
		}
		result += wrap(value);
		offset = index + value.length;
	}
	return result + line.slice(offset);
}

function errorLines(snap: BindingSnapshot): string[] {
	return [`✗ ${snap.error}`];
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
			const symbol = currentSymbol ? `<${currentSymbol}>` : "";
			return `${marker} ${breakpointMarker} ${sourceLine} ${colors.muted(instruction.address.padEnd(18))}${colors.bold(colors.accent(symbol)).padEnd(20)} ${highlightAsm(instruction.instruction)}`;
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
		const numberAndCode = `${String(number).padStart(5)} | `;
		if (current) return `${colors.accent(`${executionMarker} ${breakpointMarker} ${numberAndCode}`)}${highlightCode(line)}`;
		const gutter = breakpoint ? `${executionMarker} ${colors.error(breakpointMarker)} ${numberAndCode}` : `${executionMarker} ${breakpointMarker} ${numberAndCode}`;
		return gutter + highlightCode(line);
	});
}

export function renderInterleaved(snap: BindingSnapshot): string[] {
	if (snap.error) return errorLines(snap);
	const rows = snap.interleaved ?? [];
	if (rows.length === 0) return ["waiting for data…"];
	const lines = rows.map((row: InterleavedRow) => {
		if (row.kind === "source") {
			const breakpoint = snap.breakpoints?.find((candidate) => candidate.line === row.line);
			const marker = row.current ? "▶" : " ";
			const breakpointMarker = breakpoint ? (breakpoint.verified ? "●" : "○") : " ";
			const prefix = `${marker} ${breakpointMarker} ${String(row.line).padStart(5)} | `;
			return row.current ? colors.accent(prefix) + highlightCode(row.text) : prefix + highlightCode(row.text);
		}
		const instruction = row.instruction;
		const symbol = instruction.symbol ? `<${instruction.symbol}>` : "";
		const marker = instruction.current ? "▶" : " ";
		return `${marker}       │ ${colors.muted(instruction.address.padEnd(16))}${colors.bold(colors.accent(symbol)).padEnd(20)} ${highlightAsm(instruction.instruction)}`;
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
