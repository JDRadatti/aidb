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

import type { BindingSnapshot, InterleavedRow, Interpreter, Rect, VarNode } from "./types.ts";
import { colors } from "../theme.ts";

const CHANGED = "\x1b[33m";
const RESET = "\x1b[0m";
const KEYWORDS = new Set([
	"alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr", "continue", "default", "delete", "do", "double", "else", "enum", "explicit", "export", "extern", "false", "float", "for", "friend", "goto", "if", "inline", "int", "long", "namespace", "new", "noexcept", "not", "nullptr", "operator", "or", "private", "protected", "public", "register", "reinterpret_cast", "return", "short", "signed", "sizeof", "static", "static_cast", "struct", "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual", "void", "volatile", "wchar_t", "while", "xor",
]);

function mark(changed: boolean, text: string): string {
	return changed ? CHANGED + text + RESET : text;
}

function highlightCode(line: string): string {
	if (/^\s*#/.test(line)) return colors.bold(colors.accent(line));
	const token = /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
	let result = "";
	let offset = 0;
	for (const match of line.matchAll(token)) {
		const value = match[0];
		const index = match.index ?? 0;
		result += line.slice(offset, index);
		if (value.startsWith("//") || value.startsWith("/*")) result += colors.muted(value);
		else if (value.startsWith('"') || value.startsWith("'")) result += colors.success(value);
		else if (/^\d/.test(value)) result += colors.warning(value);
		else if (KEYWORDS.has(value)) result += colors.accent(value);
		else result += value;
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
			return `${marker} ${breakpointMarker} ${sourceLine} ${instruction.address.padEnd(18)}${symbol.padEnd(20)} ${instruction.instruction}`;
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
		return `${marker}       │ ${instruction.address.padEnd(18)}${symbol.padEnd(20)} ${instruction.instruction}`;
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

/**
 * Classic hex+ascii dump. Column count adapts to pane width (16 → 8 → 4);
 * bytes that differ from the previous stop are marked in hex and ascii.
 */
export function renderHexdump(snap: BindingSnapshot, prev: BindingSnapshot | undefined, rect: Rect): string[] {
	if (snap.error) return errorLines(snap);
	const bytes = snap.bytes ?? new Uint8Array(0);
	const base = snap.address ?? "?";
	const addrWidth = Math.max(base.length, 10);

	let cols = 16;
	while (cols > 4 && addrWidth + cols * 3 + 6 > rect.width) cols /= 2;

	const prevBytes = prev?.error === undefined ? prev?.bytes : undefined;
	let changedCount = 0;
	const rows: string[] = [];

	for (let offset = 0; offset < bytes.length; offset += cols) {
		let hex = "";
		let ascii = "";
		for (let i = 0; i < cols; i++) {
			const index = offset + i;
			if (index >= bytes.length) {
				hex += "   ";
				continue;
			}
			const byte = bytes[index]!;
			const changed = prevBytes !== undefined && index < prevBytes.length && prevBytes[index] !== byte;
			if (changed) changedCount++;
			if (i === cols / 2 && i > 0) hex += "  ";
			hex += mark(changed, byte.toString(16).padStart(2, "0")) + " ";
			ascii += mark(changed, byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".");
		}
		rows.push(`${rowLabel(base, offset).padEnd(addrWidth)}  ${hex.padEnd(cols * 3 + 2).slice(0, cols * 3 + 2)}|${ascii}|`);
	}
	rows.unshift(`${base} · ${bytes.length}B` + (changedCount > 0 ? ` · ${changedCount} changed` : ""));
	return rows;
}

function rowLabel(base: string, offset: number): string {
	const numeric = /^0x[0-9a-fA-F]+$/.exec(base);
	if (!numeric) return offset === 0 ? base : `+${offset}`;
	const value = BigInt(base) + BigInt(offset);
	return "0x" + value.toString(16);
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

/** Registry powering the `/win pick` menu and pane mounting. */
export const INTERPRETERS: Record<string, Interpreter> = {
	lines: { id: "lines", title: "value lines", render: guarded((snap) => renderValueLines(snap)) },
	text: { id: "text", title: "text", render: guarded((snap) => renderText(snap)) },
	code: { id: "code", title: "code", render: guarded(renderCode) },
	iasm: { id: "iasm", title: "interleaved assembly", render: guarded((snap) => renderInterleaved(snap)) },
	"struct-tree": { id: "struct-tree", title: "struct tree", render: guarded(renderTree) },
	sparkline: { id: "sparkline", title: "sparkline", render: guarded(renderSparkline) },
	hexdump: { id: "hexdump", title: "hexdump", render: guarded(renderHexdump) },
	table: { id: "table", title: "table", render: guarded(renderTable) },
};
