import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INTERPRETERS, renderBitmap, renderBytes, renderChars, renderCode, renderHexdump, renderInterleaved, renderInterpreter, renderSparkline, renderTable, renderTree, renderTuple, makeBitmapInterpreter } from "../src/viz/interpreters.ts";
import { ViewFlags } from "../src/viz/types.ts";
import type { BindingSnapshot, Rect, VarNode } from "../src/viz/types.ts";
import { FRAME_RGB_BYTES, MESSAGE_BYTES } from "./fixtures/bytes.ts";

const WIDE: Rect = { width: 100, height: 24 };
const NARROW: Rect = { width: 30, height: 10 };

function memorySnap(bytes: number[] | Uint8Array, address = "0x4000"): BindingSnapshot {
	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return { kind: "memory", address, bytes: data };
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderHexdump", () => {
	it("renders a header, hex columns and an ascii gutter", () => {
		const lines = renderHexdump(memorySnap([0x41, 0x42, 0x00]), undefined, WIDE);

		assert.equal(lines[0], "0x4000 · 3B");
		assert.match(lines[1]!, /0x4000\s+41 42 00/);
		assert.match(lines[1]!, /\|AB\.\|\s*$/);
	});

	it("shrinks column count on narrow panes", () => {
		const bytes = Array.from({ length: 16 }, (_, i) => i);
		const lines = renderHexdump(memorySnap(bytes), undefined, NARROW);

		assert.equal(lines.length, 1 + 4); // header + four rows of four bytes
	});

	it("marks bytes that changed since the previous stop", () => {
		const prev = memorySnap([0x01, 0x02]);
		const snap = memorySnap([0x01, 0x03]);

		const lines = renderHexdump(snap, prev, WIDE);

		assert.ok(lines[0]!.includes("· 1 changed"));
		assert.ok(lines[1]!.includes("\x1b[33m03\x1b[0m"), "changed hex byte not marked");
	});

	it("regression: marks changed bytes without losing hex cells", () => {
		// Marking 16 bytes all different from the previous stop wraps each cell in
		// ANSI codes; the row must still render all 16 hex columns (a raw-length
		// slice used to chop real cells once escape codes inflated the string).
		const prev = memorySnap(new Array(16).fill(0), "0x4000");
		const snap = memorySnap(new Array(16).fill(7), "0x4000");

		const lines = renderHexdump(snap, prev, WIDE);
		const hex = stripAnsi(lines[1]!).split("|")[0]!;
		const pairs = hex.split(/\s+/).filter(t => /^[0-9a-f]{2}$/i.test(t));
		assert.equal(pairs.length, 16);
	});

	it("continues addresses from a numeric base and offsets from a symbolic one", () => {
		const numeric = renderHexdump(memorySnap(new Array(20).fill(7)), undefined, NARROW);
		assert.ok(numeric[2]!.trimStart().startsWith("0x4004"));

		const symbolic = renderHexdump(memorySnap(new Array(20).fill(7), "&player"), undefined, NARROW);
		assert.ok(symbolic[2]!.trimStart().startsWith("+4"));
	});
});

describe("byte renderers", () => {
	const frameSnap = memorySnap(FRAME_RGB_BYTES);
	const messageSnap = memorySnap(new Uint8Array([...MESSAGE_BYTES, 0, 0x40, 0x60]));

	it("renders the shared RGB fixture through bytes, chars, tuple, and bitmap", () => {
		const bytes = renderBytes(frameSnap, undefined, WIDE);
		assert.match(bytes[0]!, /12B/);
		assert.match(bytes[1]!, /ff 00 00 00 ff 00 00 00 ff ff ff ff/);

		const chars = stripAnsi(renderChars(messageSnap, undefined, WIDE).join("\n"));
		assert.ok(chars.includes("aidb views"));
		assert.match(chars, /10B of 13B/);

		const rawChars = stripAnsi(renderChars(messageSnap, undefined, WIDE, { stopAtNull: false }).join("\n"));
		assert.ok(rawChars.includes("."));

		const tuple = stripAnsi(renderTuple(frameSnap, undefined, WIDE, { elementWidth: 1, tupleWidth: 3 }).join("\n"));
		assert.match(tuple, /\(255, 0, 0\)/);
		assert.match(tuple, /\(0, 255, 0\)/);
		assert.match(tuple, /\(255, 255, 255\)/);

		const bitmap = renderBitmap(frameSnap, undefined, { width: 100, height: 8 }, {
			width: 2,
			height: 2,
			tupleWidth: 3,
			channelOrder: "rgb",
			scale: "1:1",
		});
		assert.match(bitmap.at(-1)!, /2×2 · rgb · 1:1/);
		assert.equal(bitmap.length, 3);
	});

	it("marks changed bytes across byte-oriented renderers", () => {
		const prev = memorySnap(FRAME_RGB_BYTES);
		const changed = memorySnap(new Uint8Array([255, 128, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));

		assert.ok(renderBytes(changed, prev, WIDE)[0]!.includes("1 changed"));
		assert.ok(renderHexdump(changed, prev, WIDE)[0]!.includes("1 changed"));
		assert.ok(stripAnsi(renderTuple(changed, prev, WIDE, { elementWidth: 1, tupleWidth: 3 }).join("\n")).includes("128"));
	});

	it("wraps bytes and chars on narrow panes", () => {
		const bytes = renderBytes(memorySnap(Array.from({ length: 32 }, (_, i) => i)), undefined, NARROW);
		assert.ok(bytes.length > 2);

		const chars = renderChars(messageSnap, undefined, { width: 6, height: 8 });
		assert.ok(chars.length > 2);
	});

	it("reports incomplete tuples and missing bitmap options", () => {
		const odd = memorySnap([1, 2, 3, 4, 5]);
		assert.match(renderTuple(odd, undefined, WIDE, { elementWidth: 1, tupleWidth: 3 })[0]!, /incomplete trailing tuple/);

		assert.deepEqual(renderInterpreter(INTERPRETERS.bitmap!, frameSnap, undefined, WIDE), [
			"✗ renderer 'bitmap' requires options: width, height, tupleWidth (Phase 6 will wire these through /win pick)",
		]);
	});

	it("uses a configured bitmap interpreter factory", () => {
		const interpreter = makeBitmapInterpreter({
			width: 2,
			height: 2,
			tupleWidth: 3,
			channelOrder: "rgb",
			scale: "fit",
		});
		const lines = renderInterpreter(interpreter, frameSnap, undefined, WIDE);
		assert.match(lines.at(-1)!, /2×2 · rgb · fit/);
	});

	it("exposes option schemas on byte renderers", () => {
		assert.ok(INTERPRETERS.bytes!.optionSchema?.columns);
		assert.ok(INTERPRETERS.chars!.optionSchema?.encoding);
		assert.ok(INTERPRETERS.tuple!.optionSchema?.elementWidth);
		assert.ok(INTERPRETERS.bitmap!.optionSchema?.width);
	});

	it("flags gate the hexdump gutter, ascii column, and change highlighting", () => {
		const snap = memorySnap([0x41, 0x42]);
		const prev = memorySnap([0x41, 0x00]);

		const full = renderHexdump(snap, prev, WIDE);
		assert.ok(full[1]!.startsWith("0x4000"), "gutter shown by default");
		assert.ok(stripAnsi(full[1]!).includes("|AB"), "ascii column shown by default");
		assert.ok(full[1]!.includes("\x1b[33m"), "change marking on by default");

		const noGutter = renderHexdump(snap, prev, WIDE, 0);
		assert.ok(!noGutter[1]!.trimStart().startsWith("0x4000"), "gutter hidden with flags=0");
		assert.ok(!stripAnsi(noGutter[1]!).includes("|"), "ascii column hidden with flags=0");

		const noChanges = renderBytes(snap, prev, WIDE, {}, ViewFlags.HIDE_CHANGES);
		assert.ok(!noChanges[1]!.includes("\x1b[33m"), "change marking disabled by HIDE_CHANGES");
	});
});

describe("renderCode", () => {
	it("renders source lines with a current-line marker", () => {
		const lines = renderCode({ kind: "source", file: "example.c", startLine: 9, currentLine: 10, lines: ["int main()", "return 0;"] }, undefined, WIDE);
		assert.match(lines[0]!, /^        9 \| \x1b\[36mint\x1b\[0m main\(\)$/);
		assert.match(lines[1]!, /^\x1b\[36m▶      10 \| \x1b\[0m\x1b\[36mreturn\x1b\[0m \x1b\[33m0\x1b\[0m;$/);
	});

	it("renders aligned verified and pending breakpoint markers", () => {
		const lines = renderCode({
			kind: "source",
			startLine: 9,
			lines: ["int main()", "return 0;", "done();"],
			breakpoints: [{ line: 9, verified: true }, { line: 11, verified: false }],
		}, undefined, WIDE);

		assert.match(lines[0]!, /\x1b\[31m●\x1b\[0m/);
		assert.match(lines[0]!, /●\x1b\[0m     9 \| \x1b\[36mint\x1b\[0m main\(\)/);
		assert.match(lines[2]!, /\x1b\[31m○\x1b\[0m/);
		assert.match(lines[2]!, /○\x1b\[0m    11 \| done\(\)/);
	});

	it("highlights conservative C/C++ syntax without changing source text", () => {
		const [line] = renderCode({
			kind: "source",
			startLine: 1,
			lines: ['int answer = 42; // return "unchanged"'],
		}, undefined, WIDE);

		assert.match(line!, /\x1b\[36mint\x1b\[0m answer = \x1b\[33m42\x1b\[0m;/);
		assert.match(line!, /\x1b\[90m\/\/ return "unchanged"\x1b\[0m/);
	});

	it("renders assembly instructions with a current-PC marker", () => {
		const lines = renderCode({
			kind: "assembly",
			currentAddress: "0x401126 <main+0>",
			instructions: [{ address: "0X401126", symbol: "main", instructionBytes: "55", instruction: "push %rbp", line: 12, current: false }],
		}, undefined, WIDE);
		assert.match(stripAnsi(lines[0]!), /^▶      12 0[Xx]401126\s+<main>\s+push %rbp/);
	});

	it("keeps the assembly source-line column aligned when debug info is missing", () => {
		const lines = renderCode({
			kind: "assembly",
			instructions: [
				{ address: "0x401126", instruction: "push %rbp", line: 12, current: true },
				{ address: "0x401127", instruction: "nop" },
			],
			breakpoints: [{ line: 12, verified: true }],
		}, undefined, WIDE);

		assert.match(stripAnsi(lines[0]!), /^▶ ●    12 0x401126/);
		assert.match(stripAnsi(lines[1]!), /^          0x401127/);
	});

	it("renders the function symbol across instructions in the same function", () => {
		const lines = renderCode({
			kind: "assembly",
			instructions: [
				{ address: "0x401126", symbol: "main", instructionBytes: "55", instruction: "push %rbp" },
				{ address: "0x401127", instructionBytes: "4889e5", instruction: "mov %rbp,%rsp" },
			],
		}, undefined, WIDE);

		assert.match(stripAnsi(lines[0]!), /<main>\s+push %rbp/);
		assert.match(stripAnsi(lines[1]!), /<main>\s+mov %rbp,%rsp/);
		assert.doesNotMatch(stripAnsi(lines[0]!), /55/);
	});

	it("renders source lines with mapped instructions beneath them", () => {
		const lines = renderInterleaved({
			kind: "interleaved",
			breakpoints: [{ line: 12, verified: true }],
			interleaved: [
				{ kind: "source", line: 11, text: "int x = 1;", current: false },
				{ kind: "instruction", instruction: { address: "0x401126", symbol: "main", instruction: "mov", current: false } },
				{ kind: "source", line: 12, text: "x++;", current: true },
				{ kind: "instruction", instruction: { address: "0x401127", symbol: "main", instruction: "inc", current: true } },
			],
		}, undefined, WIDE);

		assert.match(stripAnsi(lines[0]!), /11 \|/);
		assert.match(stripAnsi(lines[0]!), /int.*x.*=.*1/);
		assert.match(stripAnsi(lines[1]!), /│ 0x401126\s+<main>\s+mov/);
		assert.match(stripAnsi(lines[2]!), /▶ ●\s+12 \| x\+\+;/);
		assert.match(stripAnsi(lines[3]!), /▶\s+│ 0x401127/);
	});

	it("renders a notice above assembly when source is unavailable", () => {
		const lines = renderInterleaved({
			kind: "interleaved",
			info: "Source unavailable for ./stdio-common/printf.c; showing assembly only",
			interleaved: [{ kind: "instruction", instruction: { address: "0x401126", instruction: "push rbp", current: true } }],
		}, undefined, WIDE);

		assert.match(stripAnsi(lines[0]!), /^i Source unavailable/);
		assert.match(stripAnsi(lines[1]!), /▶\s+│ 0x401126/);
	});
});

describe("renderSparkline", () => {
	it("draws blocks scaled to the sample range plus a stats footer", () => {
		const [row, footer] = renderSparkline({ kind: "series", samples: [0, 2, 4, 6, 8] }, undefined, WIDE);

		assert.ok(row!.endsWith("█"));
		assert.equal(footer, "min 0 · max 8 · last 8 · 5 stops");
	});

	it("uses a mid block for constant series instead of dividing by zero", () => {
		const [row] = renderSparkline({ kind: "series", samples: [5, 5, 5] }, undefined, WIDE);
		assert.equal(row, "▄▄▄");
	});

	it("handles empty and error snapshots", () => {
		assert.match(renderSparkline({ kind: "series", samples: [] }, undefined, WIDE)[0]!, /no samples yet/);
		assert.match(renderSparkline({ kind: "series", error: "no symbol" }, undefined, WIDE)[0]!, /✗ no symbol/);
	});
});

describe("renderTree", () => {
	function node(name: string, value: string, over: Partial<VarNode> = {}): VarNode {
		return { name, value, hasChildren: false, ...over };
	}

	it("draws box guides with types and depth", () => {
		const tree = node("player", "{...}", {
			hasChildren: true,
			children: [
				node("hp", "100", { type: "int" }),
				node("pos", "{...}", { type: "Vec2", hasChildren: true, children: [node("x", "3")] }),
			],
		});

		const lines = renderTree({ kind: "tree", tree }, undefined, WIDE).join("\n");

		assert.match(lines, /^player = \{\.\.\.\}/);
		assert.match(lines, /├─ hp: int = 100/);
		assert.match(lines, /└─ pos: Vec2 = \{\.\.\.\}/);
		// pos is the root's last child, so its subtree aligns with spaces.
		assert.match(lines, /^ {3}└─ x = 3$/m);
	});

	it("marks leaves whose value changed since the previous snapshot", () => {
		const before = node("player", "{}", { hasChildren: true, children: [node("hp", "99")] });
		const after = node("player", "{}", { hasChildren: true, children: [node("hp", "100")] });

		const line = renderTree({ kind: "tree", tree: after }, { kind: "tree", tree: before }, WIDE)[1]!;

		assert.ok(line.includes("\x1b[33m = 100 ▲\x1b[0m"));
	});

	it("flags unexpanded children with an ellipsis", () => {
		const tree = node("arr", "[...]", { hasChildren: true });
		const [line] = renderTree({ kind: "tree", tree }, undefined, WIDE);
		assert.ok(line!.endsWith(" …"));
	});
});

describe("renderTable", () => {
	it("aligns columns and marks changed cells", () => {
		const snap: BindingSnapshot = { kind: "registers", rows: [["rax", "0x1"], ["rbx", "0x2"]] };
		const prev: BindingSnapshot = { kind: "registers", rows: [["rax", "0x9"], ["rbx", "0x2"]] };

		const lines = renderTable(snap, prev, WIDE);

		assert.match(lines[0]!, /\x1b\[33m0x1\x1b\[0m/);
		assert.ok(!lines[1]!.includes("\x1b[33m"));
		assert.equal(lines[0]!.replace(/\x1b\[\d+m/g, "").length, lines[1]!.length);
	});
});

describe("interpreter registry", () => {
	it("falls back to a placeholder before the first fetch", () => {
		for (const interpreter of Object.values(INTERPRETERS)) {
			assert.deepEqual(interpreter.render(undefined, undefined, WIDE), ["waiting for data…"]);
		}
	});

	it("exposes the built-in set for the /win pick menu", () => {
		assert.deepEqual(Object.keys(INTERPRETERS).sort(), [
			"bitmap", "bytes", "chars", "code", "hexdump", "iasm", "lines", "sparkline", "struct-tree", "table", "text", "tuple",
		]);
	});

	it("declares requirements and explains incompatible observations", () => {
		assert.deepEqual(INTERPRETERS.hexdump!.requires, ["memory"]);
		assert.deepEqual(INTERPRETERS["struct-tree"]!.requires, ["tree"]);
		assert.deepEqual(renderInterpreter(INTERPRETERS.hexdump!, { kind: "expression", value: "frame", type: "Pixel [4]" }, undefined, WIDE), [
			"✗ renderer 'hexdump' requires: memory",
		]);
	});
});
