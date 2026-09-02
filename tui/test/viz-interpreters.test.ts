import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INTERPRETERS, renderArray, renderBitmap, renderBytes, renderChars, renderCode, renderHexdump, renderInterleaved, renderInterpreter, renderSparkline, renderTable, renderTree, renderTuple, makeBitmapInterpreter } from "../src/viz/interpreters.ts";
import { applyTheme } from "../src/theme.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
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
		assert.ok(lines[1]!.includes("\x1b[38;5;33m03\x1b[0m"), "changed hex byte not marked");
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
		assert.ok(full[1]!.includes("\x1b[38;5;33m"), "change marking on by default");

		const noGutter = renderHexdump(snap, prev, WIDE, 0);
		assert.ok(!noGutter[1]!.trimStart().startsWith("0x4000"), "gutter hidden with flags=0");
		assert.ok(!stripAnsi(noGutter[1]!).includes("|"), "ascii column hidden with flags=0");

		const noChanges = renderBytes(snap, prev, WIDE, {}, ViewFlags.HIDE_CHANGES);
		assert.ok(!noChanges[1]!.includes("\x1b[38;5;33m"), "change marking disabled by HIDE_CHANGES");
	});
});

describe("renderCode", () => {
	it("renders source lines with a current-line marker", () => {
		const lines = renderCode({ kind: "source", file: "example.c", startLine: 9, currentLine: 10, lines: ["int main()", "return 0;"] }, undefined, WIDE);
		assert.match(lines[0]!, /^        9 \x1b\[38;5;90m│\x1b\[0m \x1b\[38;5;36mint\x1b\[0m main\(\)$/);
		// The current row is wrapped like the fuzzy picker's selected row:
		// bold + accent over the WHOLE line, re-opened after each token reset
		// so token colours survive inside the highlight; the muted rail is
		// re-opened too, staying dim inside the wrap.
		assert.match(lines[1]!, /^\x1b\[1m\x1b\[38;5;36m▶      10 \x1b\[38;5;90m│\x1b\[0m\x1b\[1m\x1b\[38;5;36m \x1b\[38;5;36mreturn\x1b\[0m\x1b\[1m\x1b\[38;5;36m \x1b\[38;5;33m0\x1b\[0m\x1b\[1m\x1b\[38;5;36m;\x1b\[0m$/);
	});

	it("renders aligned verified and pending breakpoint markers", () => {
		const lines = renderCode({
			kind: "source",
			startLine: 9,
			lines: ["int main()", "return 0;", "done();"],
			breakpoints: [{ line: 9, verified: true }, { line: 11, verified: false }],
		}, undefined, WIDE);

		assert.match(lines[0]!, /\x1b\[38;5;31m●\x1b\[0m/);
		assert.match(lines[0]!, /●\x1b\[0m     9 \x1b\[38;5;90m│\x1b\[0m \x1b\[38;5;36mint\x1b\[0m main\(\)/);
		assert.match(lines[2]!, /\x1b\[38;5;31m○\x1b\[0m/);
		assert.match(lines[2]!, /○\x1b\[0m    11 \x1b\[38;5;90m│\x1b\[0m done\(\)/);
	});

	it("highlights conservative C/C++ syntax without changing source text", () => {
		const [line] = renderCode({
			kind: "source",
			startLine: 1,
			lines: ['int answer = 42; // return "unchanged"'],
		}, undefined, WIDE);

		assert.match(line!, /\x1b\[38;5;36mint\x1b\[0m answer = \x1b\[38;5;33m42\x1b\[0m;/);
		assert.match(line!, /\x1b\[38;5;90m\/\/ return "unchanged"\x1b\[0m/);
	});

	it("parses full numeric literals as ONE number token (decimals, exponents, hex, suffixes)", () => {
		const [line] = renderCode({
			kind: "source",
			startLine: 1,
			lines: ["double a = 3.5f; double b = 1.5e-3; int c = 0x1F; unsigned long d = 42uL; float e = 3.5;"],
		}, undefined, WIDE);
		// Each literal is a single `number`-role token (default code 33): the
		// old regex stopped at the first dot (`3.5f` -> `3` + stray `5f`) and
		// left `0x1F`/`1e3`/`42uL` completely uncolored.
		assert.match(line!, /\x1b\[38;5;33m3\.5f\x1b\[0m/);
		assert.match(line!, /\x1b\[38;5;33m1\.5e-3\x1b\[0m/);
		assert.match(line!, /\x1b\[38;5;33m0x1F\x1b\[0m/);
		assert.match(line!, /\x1b\[38;5;33m42uL\x1b\[0m/);
		assert.match(line!, /\x1b\[38;5;33m3\.5\x1b\[0m/);
		assert.equal((line!.match(/\x1b\[38;5;33m/g) ?? []).length, 5);
	});

	it("colors C builtin types with the type role (nvim @type), distinct from keywords", () => {
		applyTheme({ ...DEFAULT_CONFIG.theme, keyword: 31, type: 22 });
		try {
			const [line] = renderCode({
				kind: "source",
				startLine: 1,
				lines: ["int main() { return sizeof(int); }"],
			}, undefined, WIDE);
			assert.match(line!, /\x1b\[38;5;90m│\x1b\[0m \x1b\[38;5;22mint\x1b\[0m main\(\) \{ \x1b\[38;5;31mreturn\x1b\[0m \x1b\[38;5;31msizeof\x1b\[0m\(\x1b\[38;5;22mint\x1b\[0m\); \}/);

			// `struct`/`union` are statement keywords, not type names: keyword role.
			const [structLine] = renderCode({
				kind: "source",
				startLine: 1,
				lines: ["struct Point { int x; };"],
			}, undefined, WIDE);
			assert.match(structLine!, /\x1b\[38;5;90m│\x1b\[0m \x1b\[38;5;31mstruct\x1b\[0m Point \{ \x1b\[38;5;22mint\x1b\[0m x; \}/);
		} finally {
			applyTheme(DEFAULT_CONFIG.theme);
		}
	});

	it("dims assembly jump-target suffixes (<main+77>) with the label role, distinct from function", () => {
		applyTheme({ ...DEFAULT_CONFIG.theme, function: 95, label: 245 });
		try {
			const [line] = renderCode({
				kind: "assembly",
				instructions: [{ address: "0x555555555160", symbol: "main", instruction: "ne 0x555555555176 <main+77>", current: true }],
			}, undefined, WIDE);
			// The whole `<main+77>` is ONE label-role token (dim gray by default),
			// while the symbol COLUMN keeps the `function` role; the address and
			// mnemonic are untouched. Every role uses the 256-colour `38;5;` form.
			assert.match(line!, /\x1b\[38;5;95m<main>[ ]+\x1b\[0m/);
			assert.match(line!, /\x1b\[38;5;245m<main\+77>\x1b\[0m/);
			assert.match(line!, /\x1b\[38;5;93mne\x1b\[0m/);
			assert.match(line!, /\x1b\[38;5;33m0x555555555176\x1b\[0m/);
		} finally {
			applyTheme(DEFAULT_CONFIG.theme);
		}
	});

	it("wraps the current assembly row like the picker's selected row (bold + accent)", () => {
		const [line] = renderCode({
			kind: "assembly",
			instructions: [{ address: "0x401126", symbol: "main", instruction: "push %rbp", current: true }],
		}, undefined, WIDE);
		assert.ok(line!.startsWith("\x1b[1m\x1b[38;5;36m▶"), `expected a bold-accent wrap: ${JSON.stringify(line)}`);
		assert.ok(/\x1b\[1m\x1b\[38;5;36m \x1b\[38;5;93mpush\x1b\[0m\x1b\[1m\x1b\[38;5;36m \x1b\[38;5;94m%rbp\x1b\[0m\x1b\[1m\x1b\[38;5;36m\x1b\[0m$/.test(line!), `expected token re-open inside the wrap: ${JSON.stringify(line)}`);
	});

	it("renders assembly instructions with a current-PC marker", () => {
		const lines = renderCode({
			kind: "assembly",
			currentAddress: "0x401126 <main+0>",
			instructions: [{ address: "0X401126", symbol: "main", instructionBytes: "55", instruction: "push %rbp", line: 12, current: false }],
		}, undefined, WIDE);
		assert.match(stripAnsi(lines[0]!), /^▶      12 │ 0[Xx]401126\s+<main>\s+push %rbp/);
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

		assert.match(stripAnsi(lines[0]!), /^▶ ●    12 │ 0x401126/);
		assert.match(stripAnsi(lines[1]!), /^ {10}│ 0x401127/);
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

	it("keeps the instruction column pinned when symbols come and go (ANSI-aware pad)", () => {
		// The old `.padEnd(20)` counted SGR escape bytes as characters: a row
		// WITH `<main>` (escape-heavy) got zero padding while a row without a
		// symbol got ~10 spaces, so the instruction column wobbled per row.
		const lines = renderCode({
			kind: "assembly",
			instructions: [
				{ address: "0x401126", symbol: "main", instruction: "push %rbp" },
				{ address: "0x401127", instruction: "nop" },
				{ address: "0x401128", symbol: "long_function_name", instruction: "ret" },
			],
		}, undefined, WIDE);

		const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		const instrStart = (row: string): number => row.indexOf("push %rbp") >= 0
			? row.indexOf("push %rbp")
			: row.indexOf("nop") >= 0 ? row.indexOf("nop") : row.indexOf("ret");
		const starts = plain.map(instrStart);
		assert.equal(starts[0], starts[1], `rows align despite the missing symbol: ${JSON.stringify(plain)}`);
		assert.equal(starts[0], starts[2], `rows align despite the long symbol: ${JSON.stringify(plain)}`);
	});

	it("colors the symbol with its own role, distinct from the mnemonic", () => {
		const [line] = renderCode({
			kind: "assembly",
			instructions: [{ address: "0x401126", symbol: "main", instruction: "push %rbp" }],
		}, undefined, WIDE);
		// The mnemonic gets the `mnemonic` role (\x1b[38;5;93m) and `<main>` the
		// `function` role (\x1b[38;5;95m); operands resolve via the asm lexer
		// (registers \x1b[38;5;94m, immediates/numbers \x1b[38;5;33m) — no more bold-accent
		// on the mnemonic nor the operand symbols.
		assert.match(line!, /\x1b\[38;5;95m<main>[ ]+\x1b\[0m/);
		assert.match(line!, /\x1b\[38;5;93mpush\x1b\[0m/);
		assert.match(line!, /\x1b\[38;5;94m%rbp\x1b\[0m/);
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

		assert.match(stripAnsi(lines[0]!), /11 │/);
		assert.match(stripAnsi(lines[0]!), /int.*x.*=.*1/);
		assert.match(stripAnsi(lines[1]!), /│\s+0x401126\s+<main>\s+mov/);
		assert.match(stripAnsi(lines[2]!), /▶ ●\s+12 │ x\+\+;/);
		assert.match(stripAnsi(lines[3]!), /▶\s+│\s+0x401127/);
	});

	it("renders a notice above assembly when source is unavailable", () => {
		const lines = renderInterleaved({
			kind: "interleaved",
			info: "Source unavailable for ./stdio-common/printf.c; showing assembly only",
			interleaved: [{ kind: "instruction", instruction: { address: "0x401126", instruction: "push rbp", current: true } }],
		}, undefined, WIDE);

		assert.match(stripAnsi(lines[0]!), /^i Source unavailable/);
		assert.match(stripAnsi(lines[1]!), /▶\s+│\s+0x401126/);
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

		assert.ok(line.includes("\x1b[38;5;33m = 100 ▲\x1b[0m"));
	});

	it("flags unexpanded children with an ellipsis", () => {
		const tree = node("arr", "[...]", { hasChildren: true });
		const [line] = renderTree({ kind: "tree", tree }, undefined, WIDE);
		assert.ok(line!.endsWith(" …"));
	});

	it("synthesizes summaries for aggregates gdb left empty", () => {
		const tree = node("p", "0x7fffffffdba0", {
			type: "struct Point",
			hasChildren: true,
			children: [
				node("hp", "99", { type: "int" }),
				node("pos", "", { type: "struct Point", hasChildren: true }),
				node("name", '"hey", \'\\000\' <repeats 12 times>', { type: "char [16]" }),
				node("x", "65", { type: "char" }),
			],
		});
		const [line] = renderTree({ kind: "tree", tree }, undefined, WIDE);
		// Address prefix stays; scalar children format; aggregate/undecodable
		// children collapse to {…}.
		assert.equal(stripAnsi(line), "p: struct Point = 0x7fffffffdba0 {hp = 99, pos = {…}, name = \"hey\", x = 65 'A'}");
	});
});

describe("renderArray", () => {
	function arraySnap(type: string, values: string[], total?: number): BindingSnapshot {
		return {
			kind: "expression",
			type,
			tree: {
				name: "arr",
				value: "",
				type,
				hasChildren: true,
				indexedVariables: total,
				children: values.map((value, i) => ({ name: `[${i}]`, value, type: "int", hasChildren: false })),
			},
		};
	}

	it("renders a one-line element list with the type prefix", () => {
		const [line] = renderArray(arraySnap("int [4]", ["10", "20", "30", "40"]), undefined, WIDE);
		assert.equal(stripAnsi(line), "int [4] {10, 20, 30, 40}");
	});

	it("marks elements that changed since the previous stop", () => {
		const after = arraySnap("int [4]", ["10", "99", "30", "40"]);
		const lines = renderArray(after, arraySnap("int [4]", ["10", "20", "30", "40"]), WIDE);
		assert.ok(lines[0]!.includes("\x1b[38;5;33m99\x1b[0m"));
		assert.ok(!lines[0]!.includes("\x1b[38;5;33m20\x1b[0m"), "unchanged element must not be marked");
	});

	it("wraps long arrays at the pane width and truncates by height", () => {
		const snap = arraySnap("int [60]", Array.from({ length: 60 }, (_, i) => String(i)), 60);
		const lines = renderArray(snap, undefined, { width: 30, height: 3 });
		assert.ok(lines.length > 1, "long arrays wrap");
		const last = stripAnsi(lines.at(-1)!);
		assert.match(last, /^… \d+ more$/);
	});

	it("renders an empty array with the type prefix", () => {
		const [line] = renderArray({ kind: "expression", type: "int [0]", tree: { name: "arr", value: "", type: "int [0]", hasChildren: true, children: [] } }, undefined, WIDE);
		assert.equal(stripAnsi(line), "int [0] {}");
	});

	it("shortens template containers with an element count", () => {
		const [line] = renderArray(arraySnap("std::vector<int, std::allocator<int> >", ["7", "8"], 2), undefined, WIDE);
		assert.equal(stripAnsi(line), "std::vector<…> · 2 elements {7, 8}");
	});
});

describe("renderTable", () => {
	it("aligns columns and marks changed cells", () => {
		const snap: BindingSnapshot = { kind: "registers", rows: [["rax", "0x1"], ["rbx", "0x2"]] };
		const prev: BindingSnapshot = { kind: "registers", rows: [["rax", "0x9"], ["rbx", "0x2"]] };

		const lines = renderTable(snap, prev, WIDE);

		assert.match(lines[0]!, /\x1b\[38;5;33m0x1\x1b\[0m/);
		assert.ok(!lines[1]!.includes("\x1b[38;5;33m"));
		assert.equal(lines[0]!.replace(/\x1b\[\d+(;5;\d+)?m/g, "").length, lines[1]!.length);
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
			"array", "bitmap", "bytes", "chars", "code", "hexdump", "iasm", "lines", "sparkline", "struct-tree", "table", "text", "tuple",
		]);
	});

	it("formats scalar values through the lines renderer", () => {
		assert.deepEqual(
			renderInterpreter(INTERPRETERS.lines!, { kind: "expression", value: "65", type: "char" }, undefined, WIDE),
			["65 'A'"],
		);
		assert.deepEqual(
			renderInterpreter(INTERPRETERS.lines!, { kind: "expression", value: "1", type: "_Bool" }, undefined, WIDE),
			["true"],
		);
	});

	it("declares requirements and explains incompatible observations", () => {
		assert.deepEqual(INTERPRETERS.hexdump!.requires, ["memory"]);
		assert.deepEqual(INTERPRETERS["struct-tree"]!.requires, ["tree"]);
		assert.deepEqual(INTERPRETERS.array!.requires, ["tree"]);
		assert.deepEqual(renderInterpreter(INTERPRETERS.hexdump!, { kind: "expression", value: "frame", type: "Pixel [4]" }, undefined, WIDE), [
			"✗ renderer 'hexdump' requires: memory",
		]);
	});
});
