/**
 * Byte-oriented renderers: plain bytes, characters, numeric tuples, and
 * terminal bitmaps. Pure functions over BindingSnapshot memory fields.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { ViewFlags } from "./types.ts";
import type {
	BitmapOptions,
	BindingSnapshot,
	BytesOptions,
	CharsOptions,
	Interpreter,
	OptionDescriptor,
	Rect,
	TupleOptions,
} from "./types.ts";

export const CHANGED = "\x1b[33m";
export const RESET = "\x1b[0m";

export function mark(changed: boolean, text: string): string {
	return changed ? CHANGED + text + RESET : text;
}

/** `mark`, disabled when the render spec asks to hide changes. */
export function markWith(flags: ViewFlags | undefined, changed: boolean, text: string): string {
	return (flags ?? 0) & ViewFlags.HIDE_CHANGES ? text : mark(changed, text);
}

/** Whether a flags value has a given bit set. */
export function hasFlag(flags: ViewFlags | undefined, bit: ViewFlags): boolean {
	return ((flags ?? 0) & bit) !== 0;
}

function errorLines(snap: BindingSnapshot): string[] {
	return [`✗ ${snap.error}`];
}

function memoryHeader(snap: BindingSnapshot, changedCount: number, shownBytes?: number, flags?: ViewFlags, typeLabel?: string): string {
	const base = snap.address ?? "?";
	const total = snap.bytes!.length;
	const sizeLabel = shownBytes !== undefined && shownBytes < total ? `${shownBytes}B of ${total}B` : `${total}B`;
	const type = flags !== undefined && (flags & ViewFlags.TYPES) !== 0 ? ` : ${typeLabel ?? snap.type ?? ""}` : "";
	return `${base}${type} · ${sizeLabel}` + (changedCount > 0 ? ` · ${changedCount} changed` : "");
}

/** Shrink column count until rows fit the pane width. */
export function colsForWidth(rect: Rect, cellWidth: number, maxCols: number, minCols = 1): number {
	let cols = maxCols;
	while (cols > minCols && cols * cellWidth > rect.width) cols = Math.max(minCols, Math.floor(cols / 2));
	return cols;
}

function rowLabel(base: string, offset: number): string {
	const numeric = /^0x[0-9a-fA-F]+$/.exec(base);
	if (!numeric) return offset === 0 ? base : `+${offset}`;
	const value = BigInt(base) + BigInt(offset);
	return "0x" + value.toString(16);
}

/** Truncate to `width` visible columns, then pad with spaces, ANSI-aware. */
export function padVisible(line: string, width: number): string {
	const trimmed = truncateToWidth(line, width, "");
	return trimmed + " ".repeat(Math.max(0, width - visibleWidth(trimmed)));
}

/** Read a little-endian integer or float from raw bytes. */
export function readNumber(
	bytes: Uint8Array,
	offset: number,
	width: 1 | 2 | 4 | 8,
	signed: boolean,
	format: "dec" | "hex" | "float",
): number | null {
	if (offset + width > bytes.length) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (format === "float") {
		if (width === 4) return view.getFloat32(offset, true);
		if (width === 8) return view.getFloat64(offset, true);
		return null;
	}
	if (width === 1) return signed ? view.getInt8(offset) : view.getUint8(offset);
	if (width === 2) return signed ? view.getInt16(offset, true) : view.getUint16(offset, true);
	if (width === 4) return signed ? view.getInt32(offset, true) : view.getUint32(offset, true);
	return Number(view.getBigUint64(offset, true));
}

function formatElement(value: number, format: "dec" | "hex" | "float"): string {
	if (format === "hex") return `0x${Math.trunc(value).toString(16)}`;
	if (format === "float") return Number(value.toFixed(4)).toString();
	return String(value);
}

function prevBytes(prev: BindingSnapshot | undefined): Uint8Array | undefined {
	return prev?.error === undefined ? prev?.bytes : undefined;
}

function countChanged(bytes: Uint8Array, previous: Uint8Array | undefined): number {
	if (!previous) return 0;
	let count = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (i < previous.length && previous[i] !== bytes[i]) count++;
	}
	return count;
}

function byteChanged(index: number, bytes: Uint8Array, previous: Uint8Array | undefined): boolean {
	return previous !== undefined && index < previous.length && previous[index] !== bytes[index];
}

function rangeChanged(start: number, length: number, bytes: Uint8Array, previous: Uint8Array | undefined): boolean {
	for (let i = start; i < start + length; i++) {
		if (byteChanged(i, bytes, previous)) return true;
	}
	return false;
}

function formatChar(byte: number, opts: Required<Pick<CharsOptions, "nonPrintable">>): string {
	if (byte >= 32 && byte < 127) return String.fromCharCode(byte);
	switch (opts.nonPrintable) {
		case "hex": return `\\x${byte.toString(16).padStart(2, "0")}`;
		case "escape":
			if (byte === 9) return "\\t";
			if (byte === 10) return "\\n";
			if (byte === 13) return "\\r";
			return `\\x${byte.toString(16).padStart(2, "0")}`;
		default: return ".";
	}
}

function decodeChars(bytes: Uint8Array, encoding: CharsOptions["encoding"]): string[] {
	if (encoding === "utf8") {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		return [...text];
	}
	return Array.from(bytes, (byte) => String.fromCharCode(byte));
}

function channelsFromTuple(
	bytes: Uint8Array,
	index: number,
	tupleWidth: number,
	order: NonNullable<BitmapOptions["channelOrder"]>,
): [number, number, number] | null {
	if (index + tupleWidth > bytes.length) return null;
	const parts = Array.from({ length: tupleWidth }, (_, i) => bytes[index + i]!);
	if (order === "gray") {
		const gray = parts[0]!;
		return [gray, gray, gray];
	}
	const map = order === "bgr"
		? { r: parts[2] ?? 0, g: parts[1] ?? 0, b: parts[0] ?? 0 }
		: order === "rgba"
			? { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 }
			: { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 };
	return [map.r, map.g, map.b];
}

function trueColorCell(r: number, g: number, b: number, changed: boolean, flags?: ViewFlags): string {
	const cell = ` \x1b[38;2;${r};${g};${b}m${RESET}`;
	return hasFlag(flags, ViewFlags.HIDE_CHANGES) ? cell : changed ? CHANGED + "▲" + RESET + cell : cell;
}

function missingBitmapOptions(options: BitmapOptions): string | undefined {
	const missing: string[] = [];
	if (options.width === undefined || options.width <= 0) missing.push("width");
	if (options.height === undefined || options.height <= 0) missing.push("height");
	if (options.tupleWidth === undefined || options.tupleWidth <= 0) missing.push("tupleWidth");
	if (missing.length === 0) return undefined;
	return `renderer 'bitmap' requires options: ${missing.join(", ")} (Phase 6 will wire these through /win pick)`;
}

/**
 * Classic hex+ascii dump. Column count adapts to pane width (16 → 8 → 4);
 * bytes that differ from the previous stop are marked in hex and ascii.
 * Flags gate the address gutter (ADDRESSES), the ASCII column (ASCII),
 * the type in the header (TYPES), and change marking (HIDE_CHANGES).
 */
export function renderHexdump(
	snap: BindingSnapshot,
	prev: BindingSnapshot | undefined,
	rect: Rect,
	flags: ViewFlags = ViewFlags.ADDRESSES | ViewFlags.ASCII,
): string[] {
	if (snap.error) return errorLines(snap);
	const bytes = snap.bytes ?? new Uint8Array(0);
	const base = snap.address ?? "?";
	const showGutter = hasFlag(flags, ViewFlags.ADDRESSES);
	const showAscii = hasFlag(flags, ViewFlags.ASCII);
	const addrWidth = Math.max(base.length, 10);

	let cols = 16;
	while (cols > 4 && addrWidth + cols * 3 + 6 > rect.width) cols /= 2;
	const previous = prevBytes(prev);
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
			const changed = byteChanged(index, bytes, previous);
			if (changed) changedCount++;
			if (i === cols / 2 && i > 0) hex += "  ";
			hex += markWith(flags, changed, byte.toString(16).padStart(2, "0")) + " ";
			ascii += markWith(flags, changed, byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".");
		}
		const gutter = showGutter ? `${rowLabel(base, offset).padEnd(addrWidth)}  ` : "";
		const hexWidth = cols * 3 + 2;
		const body = `${padVisible(hex, hexWidth)}${showAscii ? `|${ascii}|` : ""}`;
		rows.push(`${gutter}${body}`);
	}
	rows.unshift(memoryHeader(snap, changedCount, undefined, flags));
	return rows;
}

/** Space-separated hex pairs without an address gutter. */
export function renderBytes(
	snap: BindingSnapshot,
	prev: BindingSnapshot | undefined,
	rect: Rect,
	options: BytesOptions = {},
	flags?: ViewFlags,
): string[] {
	if (snap.error) return errorLines(snap);
	const bytes = snap.bytes ?? new Uint8Array(0);
	const previous = prevBytes(prev);
	const cols = options.columns ?? colsForWidth(rect, 3, 32, 4);
	let changedCount = 0;
	const rows: string[] = [];

	for (let offset = 0; offset < bytes.length; offset += cols) {
		const cells: string[] = [];
		for (let i = 0; i < cols; i++) {
			const index = offset + i;
			if (index >= bytes.length) break;
			const byte = bytes[index]!;
			const changed = byteChanged(index, bytes, previous);
			if (changed) changedCount++;
			cells.push(markWith(flags, changed, byte.toString(16).padStart(2, "0")));
		}
		rows.push(cells.join(" "));
	}
	rows.unshift(memoryHeader(snap, changedCount, undefined, flags));
	return rows;
}

/** Character-oriented memory view with configurable non-printable policy. */
export function renderChars(
	snap: BindingSnapshot,
	prev: BindingSnapshot | undefined,
	rect: Rect,
	options: CharsOptions = {},
	flags?: ViewFlags,
): string[] {
	if (snap.error) return errorLines(snap);
	const bytes = snap.bytes ?? new Uint8Array(0);
	const previous = prevBytes(prev);
	const encoding = options.encoding ?? "latin1";
	const nonPrintable = options.nonPrintable ?? "dot";
	const stopAtNull = options.stopAtNull ?? true;
	let end = bytes.length;
	if (stopAtNull) {
		const zero = bytes.indexOf(0);
		if (zero >= 0) end = zero;
	}
	let changedCount = 0;
	const rows: string[] = [];
	let line = "";

	for (let index = 0; index < end; index++) {
		const byte = bytes[index]!;
		const changed = byteChanged(index, bytes, previous);
		if (changed) changedCount++;
		const glyph = formatChar(byte, { nonPrintable });
		const rendered = encoding === "latin1" ? markWith(flags, changed, glyph) : markWith(flags, changed, decodeChars(new Uint8Array([byte]), encoding)[0] ?? glyph);
		if (line.length + glyph.length > rect.width && line.length > 0) {
			rows.push(line);
			line = rendered;
		} else {
			line += rendered;
		}
	}
	if (line.length > 0) rows.push(line);
	rows.unshift(memoryHeader(snap, changedCount, end, flags));
	return rows;
}

/** Fixed-width numeric tuples such as RGB triples. */
export function renderTuple(
	snap: BindingSnapshot,
	prev: BindingSnapshot | undefined,
	rect: Rect,
	options: TupleOptions,
	flags?: ViewFlags,
): string[] {
	if (snap.error) return errorLines(snap);
	const bytes = snap.bytes ?? new Uint8Array(0);
	const previous = prevBytes(prev);
	const elementWidth = options.elementWidth;
	const signed = options.signed ?? false;
	const format = options.format ?? "dec";
	const tupleWidth = options.tupleWidth ?? 1;
	const stride = elementWidth * tupleWidth;
	const rows: string[] = [];
	let line = "";
	let partial = false;

	for (let offset = 0; offset < bytes.length; offset += stride) {
		const elements: string[] = [];
		let tupleChanged = false;
		for (let element = 0; element < tupleWidth; element++) {
			const index = offset + element * elementWidth;
			const value = readNumber(bytes, index, elementWidth, signed, format);
			if (value === null) {
				partial = true;
				elements.push("?");
				continue;
			}
			if (rangeChanged(index, elementWidth, bytes, previous)) tupleChanged = true;
			elements.push(formatElement(value, format));
		}
		const rendered = markWith(flags, tupleChanged, `(${elements.join(", ")})`);
		const separator = line.length === 0 ? "" : "  ";
		if (line.length + separator.length + rendered.length > rect.width && line.length > 0) {
			rows.push(line);
			line = rendered;
		} else {
			line += separator + rendered;
		}
	}

	if (line.length > 0) rows.push(line);
	const header = memoryHeader(snap, countChanged(bytes, previous), undefined, flags);
	if (partial) rows.unshift(`${header} · incomplete trailing tuple`);
	else rows.unshift(header);
	return rows;
}

/** Terminal bitmap using 24-bit foreground colors. */
export function renderBitmap(
	snap: BindingSnapshot,
	prev: BindingSnapshot | undefined,
	rect: Rect,
	options: BitmapOptions,
	flags?: ViewFlags,
): string[] {
	if (snap.error) return errorLines(snap);
	const optionError = missingBitmapOptions(options);
	if (optionError) return [`✗ ${optionError}`];

	const bytes = snap.bytes ?? new Uint8Array(0);
	const previous = prevBytes(prev);
	const width = options.width!;
	const height = options.height!;
	const tupleWidth = options.tupleWidth!;
	const channelOrder = options.channelOrder ?? "rgb";
	const scale = options.scale ?? "fit";
	const needed = width * height * tupleWidth;
	const bodyHeight = Math.max(1, rect.height - 1);
	const showChanges = !hasFlag(flags, ViewFlags.HIDE_CHANGES);

	let drawWidth = width;
	let drawHeight = height;
	if (scale === "fit") {
		drawWidth = Math.min(width, rect.width);
		drawHeight = Math.min(height, bodyHeight);
		if (width > drawWidth) drawWidth = Math.max(1, rect.width);
		if (height > drawHeight) drawHeight = Math.max(1, bodyHeight);
	} else {
		drawWidth = Math.min(width, rect.width);
		drawHeight = Math.min(height, bodyHeight);
	}

	const stepX = width / drawWidth;
	const stepY = height / drawHeight;
	let changedPixels = 0;
	const rows: string[] = [];

	for (let row = 0; row < drawHeight; row++) {
		let line = "";
		const sourceY = Math.min(height - 1, Math.floor(row * stepY));
		for (let col = 0; col < drawWidth; col++) {
			const sourceX = Math.min(width - 1, Math.floor(col * stepX));
			const index = (sourceY * width + sourceX) * tupleWidth;
			const rgb = channelsFromTuple(bytes, index, tupleWidth, channelOrder);
			if (!rgb) {
				line += " ";
				continue;
			}
			const changed = showChanges && rangeChanged(index, tupleWidth, bytes, previous);
			if (changed) changedPixels++;
			line += trueColorCell(rgb[0], rgb[1], rgb[2], changed, flags);
		}
		rows.push(line);
	}

	const footer = `${width}×${height} · ${channelOrder} · ${scale}` +
		(changedPixels > 0 ? ` · ${changedPixels} changed` : "") +
		(bytes.length < needed ? ` · ${needed - bytes.length}B short` : "");
	rows.push(footer);
	return rows;
}

function guarded(render: (snap: BindingSnapshot, prev: BindingSnapshot | undefined, rect: Rect, flags?: ViewFlags) => string[]) {
	return (snap: BindingSnapshot | undefined, prev: BindingSnapshot | undefined, rect: Rect, flags?: ViewFlags): string[] => {
		if (!snap) return ["waiting for data…"];
		return render(snap, prev, rect, flags);
	};
}

const BYTES_OPTION_SCHEMA: Record<string, OptionDescriptor> = {
	columns: { kind: "number", description: "Bytes per row before wrapping; auto when omitted." },
};

const CHARS_OPTION_SCHEMA: Record<string, OptionDescriptor> = {
	encoding: { kind: "enum", description: "Character decoding.", enum: ["latin1", "utf8"], default: "latin1" },
	nonPrintable: { kind: "enum", description: "How to render non-printable bytes.", enum: ["dot", "hex", "escape"], default: "dot" },
	stopAtNull: { kind: "boolean", description: "Stop at the first zero byte (C strings).", default: true },
};

const TUPLE_OPTION_SCHEMA: Record<string, OptionDescriptor> = {
	elementWidth: { kind: "enum", description: "Byte width of each numeric element.", enum: ["1", "2", "4", "8"], required: true },
	signed: { kind: "boolean", description: "Interpret elements as signed integers.", default: false },
	format: { kind: "enum", description: "Numeric formatting.", enum: ["dec", "hex", "float"], default: "dec" },
	tupleWidth: { kind: "number", description: "Elements grouped into one printed tuple.", default: 1 },
};

const BITMAP_OPTION_SCHEMA: Record<string, OptionDescriptor> = {
	width: { kind: "number", description: "Image width in pixels.", required: true },
	height: { kind: "number", description: "Image height in pixels.", required: true },
	tupleWidth: { kind: "number", description: "Bytes per pixel.", required: true },
	channelOrder: { kind: "enum", description: "Channel order within each pixel tuple.", enum: ["rgb", "bgr", "rgba", "gray"], default: "rgb" },
	scale: { kind: "enum", description: "Fit scales down to the pane; 1:1 uses one cell per pixel.", enum: ["fit", "1:1"], default: "fit" },
};

export function makeHexdumpInterpreter(): Interpreter {
	return {
		id: "hexdump",
		title: "hexdump",
		requires: ["memory"],
		// Preserve the classic full hex+ascii output when no flags are given.
		defaultFlags: ViewFlags.ADDRESSES | ViewFlags.ASCII,
		// Example spec options for tooling / AI; nothing consumes these at runtime.
		examples: [{}, { columns: 8 }],
		render: guarded(renderHexdump),
	};
}

export function makeBytesInterpreter(options: BytesOptions = {}): Interpreter {
	return {
		id: "bytes",
		title: "bytes",
		requires: ["memory"],
		options,
		optionSchema: BYTES_OPTION_SCHEMA,
		render: guarded((snap, prev, rect, flags) => renderBytes(snap, prev, rect, options, flags)),
	};
}

export function makeCharsInterpreter(options: CharsOptions = {}): Interpreter {
	return {
		id: "chars",
		title: "chars",
		requires: ["memory"],
		options,
		optionSchema: CHARS_OPTION_SCHEMA,
		render: guarded((snap, prev, rect, flags) => renderChars(snap, prev, rect, options, flags)),
	};
}

export function makeTupleInterpreter(options: TupleOptions): Interpreter {
	return {
		id: "tuple",
		title: "tuple",
		requires: ["memory"],
		options,
		optionSchema: TUPLE_OPTION_SCHEMA,
		render: guarded((snap, prev, rect, flags) => renderTuple(snap, prev, rect, options, flags)),
	};
}

export function makeBitmapInterpreter(options: BitmapOptions = {}): Interpreter {
	return {
		id: "bitmap",
		title: "bitmap",
		requires: ["memory"],
		options,
		optionSchema: BITMAP_OPTION_SCHEMA,
		render: guarded((snap, prev, rect, flags) => renderBitmap(snap, prev, rect, options, flags)),
	};
}
