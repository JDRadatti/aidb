import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INTERPRETERS, renderCode, renderHexdump, renderSparkline, renderTable, renderTree } from "../src/viz/interpreters.ts";
import type { BindingSnapshot, Rect, VarNode } from "../src/viz/types.ts";

const WIDE: Rect = { width: 100, height: 24 };
const NARROW: Rect = { width: 30, height: 10 };

function memorySnap(bytes: number[], address = "0x4000"): BindingSnapshot {
	return { kind: "memory", address, bytes: new Uint8Array(bytes) };
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

	it("continues addresses from a numeric base and offsets from a symbolic one", () => {
		const numeric = renderHexdump(memorySnap(new Array(20).fill(7)), undefined, NARROW);
		assert.ok(numeric[2]!.trimStart().startsWith("0x4004"));

		const symbolic = renderHexdump(memorySnap(new Array(20).fill(7), "&player"), undefined, NARROW);
		assert.ok(symbolic[2]!.trimStart().startsWith("+4"));
	});
});

describe("renderCode", () => {
	it("renders source lines with a current-line marker", () => {
		const lines = renderCode({ kind: "source", file: "example.c", startLine: 9, currentLine: 10, lines: ["int main()", "return 0;"] }, undefined, WIDE);
		assert.deepEqual(lines, ["      9 | int main()", ">    10 | return 0;"]);
	});

	it("renders assembly instructions with a current-PC marker", () => {
		const lines = renderCode({
			kind: "assembly",
			currentAddress: "0x401126 <main+0>",
			instructions: [{ address: "0X401126", instruction: "push %rbp", current: false }],
		}, undefined, WIDE);
		assert.match(lines[0]!, /^> 0[Xx]401126\s+push %rbp/);
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
		assert.deepEqual(Object.keys(INTERPRETERS).sort(), ["code", "hexdump", "lines", "sparkline", "struct-tree", "table", "text"]);
	});
});
