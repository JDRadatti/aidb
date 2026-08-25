import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssemblyBinding, MemoryBinding, RegistersBinding, SeriesBinding, SourceBinding, TreeBinding, parseGdbNumber } from "../src/viz/bindings.ts";
import type { FetchCtx, VarNode } from "../src/viz/types.ts";

function makeCtx(over: Partial<FetchCtx> = {}): FetchCtx {
	return {
		evaluate: async () => "0",
		evaluateDetailed: async () => ({ result: "{}", variablesReference: 0 }),
		getVariableChildren: async () => [],
		readMemory: async () => ({ address: "0x4000", data: new Uint8Array(0) }),
		...over,
	};
}

describe("parseGdbNumber", () => {
	it("parses decimal, hex, floats and typed suffixes", () => {
		assert.equal(parseGdbNumber("42"), 42);
		assert.equal(parseGdbNumber("0x10"), 16);
		assert.equal(parseGdbNumber("-3.5e2"), -350);
		assert.equal(parseGdbNumber("100 'd'"), 100);
		assert.equal(parseGdbNumber("{...}"), null);
	});
});

describe("MemoryBinding", () => {
	it("reads the requested byte count through the fetch context", async () => {
		let requested: { expr: string; count: number } | null = null;
		const binding = new MemoryBinding("&player", 32);
		const snap = await binding.fetch(makeCtx({
			readMemory: async (expr, count) => {
				requested = { expr, count };
				return { address: "0x55f1a0", data: new Uint8Array([1, 2, 3]) };
			},
		}));

		assert.deepEqual(requested, { expr: "&player", count: 32 });
		assert.equal(snap.kind, "memory");
		assert.equal(snap.address, "0x55f1a0");
		assert.deepEqual(Array.from(snap.bytes!), [1, 2, 3]);
	});

	it("identity binds expression and size", () => {
		assert.equal(new MemoryBinding("&p", 64).identity(), "mem:&p:64");
	});
});

describe("SeriesBinding", () => {
	it("samples numeric values into the ring", async () => {
		const binding = new SeriesBinding("hp");
		await binding.fetch(makeCtx({ evaluate: async () => "10" }));
		const snap = await binding.fetch(makeCtx({ evaluate: async () => "0x20" }));

		assert.deepEqual(snap.samples, [10, 32]);
	});

	it("caps history at the configured size", async () => {
		const binding = new SeriesBinding("i", 3);
		for (let n = 0; n < 5; n++) {
			await binding.fetch(makeCtx({ evaluate: async () => String(n) }));
		}
		assert.deepEqual(binding.samples(), [2, 3, 4]);
	});

	it("records an error snapshot without corrupting the series", async () => {
		const binding = new SeriesBinding("name");
		await binding.fetch(makeCtx({ evaluate: async () => "7" }));
		const bad = await binding.fetch(makeCtx({ evaluate: async () => `"hello"` }));

		assert.match(bad.error!, /cannot plot/);
		const good = await binding.fetch(makeCtx({ evaluate: async () => "9" }));
		assert.deepEqual(good.samples, [7, 9]);
	});
});

describe("TreeBinding", () => {
	const posChild: VarNode = { name: "x", value: "1", hasChildren: false };

	function ctx(): FetchCtx {
		return makeCtx({
			evaluateDetailed: async () => ({ result: "{...}", variablesReference: 100 }),
			getVariableChildren: async (ref) =>
				ref === 100
					? [
							{ name: "hp", value: "99", hasChildren: false },
							{ name: "pos", value: "{...}", type: "Vec2", hasChildren: true, ref: 200 },
						]
					: [posChild],
		});
	}

	it("expands children up to the configured depth", async () => {
		const snap = await new TreeBinding("player", 2).fetch(ctx());

		assert.equal(snap.tree!.value, "{...}");
		const [, pos] = snap.tree!.children!;
		assert.equal(pos.type, "Vec2");
		assert.equal(pos.children![0].name, "x");
	});

	it("stops at depth zero leaving expandable markers", async () => {
		let childRequests = 0;
		const counting = makeCtx({
			evaluateDetailed: async () => ({ result: "{...}", variablesReference: 100 }),
			getVariableChildren: async (ref) => {
				childRequests++;
				return ref === 100
					? [{ name: "pos", value: "{...}", hasChildren: true, ref: 200 }]
					: [{ name: "x", value: "1", hasChildren: false }];
			},
		});

		const snap = await new TreeBinding("player", 1).fetch(counting);

		assert.equal(childRequests, 1);
		assert.equal(snap.tree!.children![0].children, undefined);
		assert.ok(snap.tree!.children![0].hasChildren);
	});

	it("respects the node budget on huge containers", async () => {
		const wide = makeCtx({
			evaluateDetailed: async () => ({ result: "[...]", variablesReference: 1 }),
			getVariableChildren: async () =>
				Array.from({ length: 50 }, (_, i) => ({ name: `[${i}]`, value: "0", hasChildren: false })),
		});

		const snap = await new TreeBinding("big", 3, 10).fetch(wide);

		assert.equal(snap.tree!.children!.length, 9); // budget minus root
	});

	it("reports evaluation failures as error snapshots", async () => {
		const snap = await new TreeBinding("zzz").fetch(makeCtx({
			evaluateDetailed: async () => {
				throw new Error('No symbol "zzz"');
			},
		}));
		assert.match(snap.error!, /No symbol/);
	});
});

describe("RegistersBinding", () => {
	it("splits gdb register rows into cells", async () => {
		const snap = await new RegistersBinding().fetch(makeCtx({
			evaluate: async (_expr, context) => {
				assert.equal(context, "repl");
				return "rax            0x55f1a000    1441798144\nrbx           0x0\t0";
			},
		}));

		assert.deepEqual(snap.rows, [
			["rax", "0x55f1a000", "1441798144"],
			["rbx", "0x0", "0"],
		]);
	});
});

describe("SourceBinding", () => {
	it("reads a centered source window around the current line", async () => {
		let request: { file: string; start: number; count: number } | undefined;
		const snap = await new SourceBinding(5).fetch(makeCtx({
			getLocation: () => ({ file: "/tmp/example.c", line: 10 }),
			readSource: async (file, start, count) => {
				request = { file, start, count };
				return ["line 8", "line 9", "line 10", "line 11", "line 12"];
			},
		}));

		assert.deepEqual(request, { file: "/tmp/example.c", start: 8, count: 5 });
		assert.equal(snap.kind, "source");
		assert.equal(snap.currentLine, 10);
		assert.deepEqual(snap.lines, ["line 8", "line 9", "line 10", "line 11", "line 12"]);
	});

	it("reports missing source location", async () => {
		const snap = await new SourceBinding().fetch(makeCtx({ getLocation: () => ({ file: null, line: 0 }) }));
		assert.equal(snap.error, "no source location");
	});
});

describe("AssemblyBinding", () => {
	it("centers the window around the program counter", async () => {
		let request: { reference: string; count: number } | undefined;
		const snap = await new AssemblyBinding(3).fetch(makeCtx({
			evaluateDetailed: async () => ({ result: "0x401126 <main+0>", variablesReference: 0, memoryReference: "0x401126 <main+0>" }),
			disassemble: async (reference, count) => {
				request = { reference, count };
				return Array.from({ length: count }, (_, index) => ({
					address: `0x${(0x401076 + index * 16).toString(16)}`,
					instruction: index === 11 ? "push %rbp" : "nop",
				}));
			},
		}));

		assert.deepEqual(request, { reference: "0x401056", count: 87 });
		assert.equal(snap.kind, "assembly");
		assert.equal(snap.currentAddress, "0x401126");
		assert.equal(snap.instructions?.[0]?.current, false);
		assert.equal(snap.instructions?.[11]?.current, true);
	});
});
