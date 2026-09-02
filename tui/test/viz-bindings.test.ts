import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssemblyBinding, ExpressionBinding, InterleavedBinding, LocalsBinding, MemoryBinding, RegistersBinding, SeriesBinding, SourceBinding, TreeBinding, MAX_SOURCE_BUFFER, parseGdbNumber } from "../src/viz/bindings.ts";
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

describe("ExpressionBinding", () => {
	it("evaluates once and reads bytes through the returned memoryReference", async () => {
		const requests: Array<{ expression: string; count: number; offset?: number }> = [];
		const binding = new ExpressionBinding("frame", 12, 3);
		const snap = await binding.fetch(makeCtx({
			evaluateDetailed: async () => ({
				result: "{...}",
				type: "struct Pixel [4]",
				variablesReference: 4,
				memoryReference: "0x601000",
			}),
			readMemory: async (expression, count, offset) => {
				requests.push({ expression, count, offset });
				return { address: "0x601003", data: new Uint8Array([1, 2, 3]) };
			},
		}));

		assert.deepEqual(requests, [{ expression: "0x601000", count: 12, offset: 3 }]);
		assert.equal(snap.kind, "expression");
		assert.equal(snap.type, "struct Pixel [4]");
		assert.equal(snap.memoryReference, "0x601000");
		assert.equal(snap.address, "0x601003");
		assert.deepEqual(Array.from(snap.bytes!), [1, 2, 3]);
	});

	it("keeps value and type when the expression is not addressable", async () => {
		const snap = await new ExpressionBinding("1 + 2").fetch(makeCtx({
			evaluateDetailed: async () => ({ result: "3", type: "int", variablesReference: 0 }),
		}));

		assert.equal(snap.value, "3");
		assert.equal(snap.type, "int");
		assert.equal(snap.bytes, undefined);
		assert.match(snap.info!, /raw memory unavailable/);
	});

	it("keeps metadata when a raw memory read fails", async () => {
		const snap = await new ExpressionBinding("frame", 8).fetch(makeCtx({
			evaluateDetailed: async () => ({ result: "{...}", type: "Pixel [4]", variablesReference: 2, memoryReference: "0x601000" }),
			readMemory: async () => { throw new Error("unmapped"); },
		}));

		assert.equal(snap.type, "Pixel [4]");
		assert.equal(snap.memoryReference, "0x601000");
		assert.match(snap.info!, /unmapped/);
		assert.equal(snap.error, undefined);
	});

	it("expands an aggregate's children into the snapshot tree", async () => {
		const snap = await new ExpressionBinding("player").fetch(makeCtx({
			evaluateDetailed: async () => ({
				result: "{...}",
				type: "struct Player",
				variablesReference: 100,
				namedVariables: 2,
				memoryReference: "0x55f1a0",
			}),
			getVariableChildren: async (ref) =>
				ref === 100
					? [
							{ name: "hp", value: "99", type: "int", hasChildren: false, evaluateName: "player.hp", memoryReference: "0x55f1a0" },
							{ name: "pos", value: "{...}", type: "Vec2", hasChildren: true, ref: 200, variablesReference: 200, evaluateName: "player.pos", memoryReference: "0x55f1a4", namedVariables: 2 },
						]
					: [{ name: "x", value: "1", hasChildren: false }],
		}));

		assert.equal(snap.tree!.value, "{...}");
		assert.equal(snap.tree!.type, "struct Player");
		assert.equal(snap.tree!.ref, 100);
		const [, pos] = snap.tree!.children!;
		assert.equal(pos.type, "Vec2");
		assert.equal(pos.evaluateName, "player.pos");
		assert.equal(pos.children![0].name, "x");
	});

	it("does not build a tree for scalars without a variablesReference", async () => {
		const snap = await new ExpressionBinding("hp").fetch(makeCtx({
			evaluateDetailed: async () => ({ result: "100", type: "int", variablesReference: 0 }),
		}));

		assert.equal(snap.tree, undefined);
	});

	it("caps the eager watch tree (depth and node budget)", async () => {
		let requests = 0;
		const wide = makeCtx({
			evaluateDetailed: async () => ({ result: "[...]", type: "int [1000]", variablesReference: 1, indexedVariables: 1000 }),
			getVariableChildren: async () => {
				requests++;
				return Array.from({ length: 40 }, (_, i) => ({ name: `[${i}]`, value: String(i), hasChildren: false }));
			},
		});

		const snap = await new ExpressionBinding("big", 192).fetch(wide);

		// 64-node budget minus the root caps children at 63.
		assert.ok((snap.tree!.children?.length ?? 0) <= 63);
		assert.ok(requests >= 1);
	});

	it("falls back to &expr when the evaluate lacks an address (gdb arrays)", async () => {
		const calls: string[] = [];
		const snap = await new ExpressionBinding("frame", 12).fetch(makeCtx({
			evaluateDetailed: async (expr) => {
				calls.push(expr);
				if (expr === "frame") return { result: "", type: "struct Pixel [4]", variablesReference: 4 };
				return { result: "0x601000 <frame>", type: "struct Pixel (*)[4]", variablesReference: 10, memoryReference: "0x601000" };
			},
			readMemory: async (expression, count, offset) => {
				calls.push(`read:${expression}:${count}:${offset ?? 0}`);
				return { address: "0x601000", data: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]) };
			},
		}));

		assert.deepEqual(calls, ["frame", "&frame", "read:0x601000:12:0"]);
		assert.equal(snap.value, "0x601000 <frame>");
		assert.equal(snap.type, "struct Pixel [4]");
		assert.equal(snap.memoryReference, "0x601000");
		assert.deepEqual(Array.from(snap.bytes!), [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
		assert.equal(snap.error, undefined);
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
			evaluateDetailed: async () => ({
				result: "{...}",
				type: "struct Player",
				variablesReference: 100,
				namedVariables: 2,
				memoryReference: "0x55f1a0",
			}),
			getVariableChildren: async (ref) =>
				ref === 100
					? [
							{ name: "hp", value: "99", type: "int", hasChildren: false, evaluateName: "player.hp", memoryReference: "0x55f1a0" },
							{ name: "pos", value: "{...}", type: "Vec2", hasChildren: true, ref: 200, variablesReference: 200, evaluateName: "player.pos", memoryReference: "0x55f1a4", namedVariables: 2 },
						]
					: [posChild],
		});
	}

	it("expands children up to the configured depth", async () => {
		const snap = await new TreeBinding("player", 2).fetch(ctx());

		assert.equal(snap.tree!.value, "{...}");
		assert.equal(snap.tree!.type, "struct Player");
		assert.equal(snap.tree!.memoryReference, "0x55f1a0");
		assert.equal(snap.tree!.ref, 100);
		const [, pos] = snap.tree!.children!;
		assert.equal(pos.type, "Vec2");
		assert.equal(pos.evaluateName, "player.pos");
		assert.equal(pos.memoryReference, "0x55f1a4");
		assert.equal(pos.namedVariables, 2);
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

describe("LocalsBinding", () => {
	function localCtx(over: Partial<FetchCtx> = {}): FetchCtx {
		return makeCtx({
			getFrameVariables: async (scope) =>
				scope === "args"
					? [{ name: "argc", value: "1", type: "int", hasChildren: false }]
					: [
							{ name: "flag", value: "true", type: "_Bool", hasChildren: false },
							{ name: "pos", value: "{...}", type: "Vec2", hasChildren: true, ref: 7, variablesReference: 7 },
						],
			getVariableChildren: async (ref) =>
				ref === 7
					? [
							{ name: "x", value: "3", hasChildren: false },
							{ name: "y", value: "4", hasChildren: false },
						]
					: [],
			...over,
		});
	}

	it("merges args (grouped) with locals into one tree", async () => {
		const snap = await new LocalsBinding().fetch(localCtx());

		const tree = snap.tree!;
		assert.equal(tree.name, "locals");
		assert.equal(tree.children!.length, 3); // args group + flag + pos
		const [argsGroup] = tree.children!;
		assert.equal(argsGroup.name, "args");
		assert.equal(argsGroup.hasChildren, true);
		assert.equal(argsGroup.children![0].name, "argc");
		// Locals sit flat under the root, no extra group.
		assert.equal(tree.children![1]!.name, "flag");
		assert.equal(tree.children![2]!.name, "pos");
	});

	it("expands nested aggregates through the shared budget", async () => {
		const snap = await new LocalsBinding().fetch(localCtx());
		const pos = snap.tree!.children![2]!;
		assert.deepEqual(pos.children?.map((c) => c.name), ["x", "y"]);
	});

	it("reports an empty frame as (none)", async () => {
		const snap = await new LocalsBinding().fetch(makeCtx({ getFrameVariables: async () => [] }));
		assert.equal(snap.tree!.value, "(none)");
		assert.equal(snap.tree!.hasChildren, false);
	});

	it("handles a missing fetch hook", async () => {
		const snap = await new LocalsBinding().fetch(makeCtx({}));
		assert.match(snap.error!, /unavailable/);
	});

	it("wraps stop-state failures in a friendly hint", async () => {
		const snap = await new LocalsBinding().fetch(makeCtx({
			getFrameVariables: async () => {
				throw new Error('DAP request "stackTrace" failed: notStopped');
			},
		}));
		assert.match(snap.error!, /stop the program/);
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
	it("reads a wide scrollable buffer centered around the current line", async () => {
		let request: { file: string; start: number; count: number } | undefined;
		const snap = await new SourceBinding(5).fetch(makeCtx({
			getLocation: () => ({ file: "/tmp/example.c", line: 10 }),
			readSource: async (file, start, count) => {
				request = { file, start, count };
				return ["line 8", "line 9", "line 10", "line 11", "line 12"];
			},
		}));

		assert.deepEqual(request, { file: "/tmp/example.c", start: 1, count: MAX_SOURCE_BUFFER });
		assert.equal(snap.kind, "source");
		assert.equal(snap.currentLine, 10);
		assert.equal(snap.startLine, 1);
		assert.deepEqual(snap.lines, ["line 8", "line 9", "line 10", "line 11", "line 12"]);
	});

	it("includes only breakpoints inside the fetched source window", async () => {
		const snap = await new SourceBinding().fetch(makeCtx({
			getLocation: () => ({ file: "/tmp/example.c", line: 10 }),
			readSource: async (file, start, count) => Array.from({ length: 20 }, (_, i) => `line ${start + i}`),
			getBreakpoints: () => [
				{ line: 8, verified: true },
				{ line: 10, verified: true },
				{ line: 12, verified: false },
				{ line: 99, verified: true },
			],
		}));

		assert.deepEqual(snap.breakpoints, [
			{ line: 8, verified: true },
			{ line: 10, verified: true },
			{ line: 12, verified: false },
		]);
	});

	 it("reports missing source location", async () => {
		const snap = await new SourceBinding().fetch(makeCtx({ getLocation: () => ({ file: null, line: 0 }) }));
		assert.equal(snap.error, "no source location");
	});

	it("grows the fetched window to the pane's viewport height", async () => {
		const binding = new SourceBinding();
		assert.equal(binding.setViewportHeight(40), true);
		assert.equal(binding.setViewportHeight(40), false);
		assert.equal(binding.identity(), "source:40");
		let request: { file: string; start: number; count: number } | undefined;
		const snap = await binding.fetch(makeCtx({
			getLocation: () => ({ file: "/tmp/example.c", line: 30 }),
			readSource: async (file, start, count) => {
				request = { file, start, count };
				return Array.from({ length: count }, (_, i) => `line ${start + i}`);
			},
		}));

		assert.deepEqual(request, { file: "/tmp/example.c", start: 1, count: MAX_SOURCE_BUFFER });
		assert.equal(snap.lines?.length, MAX_SOURCE_BUFFER);
	});

	it("falls back to assembly when source is unavailable", async () => {
		const snap = await new SourceBinding(3).fetch(makeCtx({
			getLocation: () => ({ file: "./stdio-common/printf.c", line: 32 }),
			readSource: async () => { throw new Error("ENOENT"); },
			evaluateDetailed: async () => ({ result: "0x401126 <__printf+0>", variablesReference: 0, memoryReference: "0x401126" }),
			disassemble: async () => [{ address: "0x401126", instruction: "push rbp", current: true }],
		}));

		assert.equal(snap.kind, "assembly");
		assert.match(snap.info!, /Source unavailable/);
		assert.equal(snap.instructions?.[0]?.instruction, "push rbp");
	});
});

describe("AssemblyBinding", () => {
	it("centers the window around the program counter", async () => {
		let request: { reference: string; count: number; offset?: number } | undefined;
		const snap = await new AssemblyBinding(3).fetch(makeCtx({
			evaluateDetailed: async () => ({ result: "0x401126 <main+0>", variablesReference: 0, memoryReference: "0x401126 <main+0>" }),
			disassemble: async (reference, count, offset) => {
				request = { reference, count, offset };
				return Array.from({ length: count }, (_, index) => ({
					address: `0x${(0x401076 + index * 16).toString(16)}`,
					instruction: index === 11 ? "push %rbp" : "nop",
				}));
			},
		}));

		assert.deepEqual(request, { reference: "0x4010ea", count: 97, offset: undefined });
		assert.equal(snap.kind, "assembly");
		assert.equal(snap.currentAddress, "0x401126");
		assert.equal(snap.instructions?.[10]?.current, true);
	});

	it("retains recent instructions from the previous window", async () => {
		const snap = await new AssemblyBinding(3).fetch(makeCtx({
			evaluateDetailed: async () => ({ result: "0x401126 <main+0>", variablesReference: 0, memoryReference: "0x401126" }),
			disassemble: async () => [
				{ address: "0x401126", instruction: "current" },
				{ address: "0x401127", instruction: "next" },
			],
		}), {
			kind: "assembly",
			instructions: [
				{ address: "0x401116", instruction: "previous" },
				{ address: "0x401126", instruction: "old current" },
			],
		});

		assert.deepEqual(snap.instructions?.map((instruction) => instruction.instruction), ["previous", "current", "next"]);
		assert.equal(snap.instructions?.[1]?.current, true);
	});

	it("grows the instruction window to the pane's viewport height", async () => {
		const binding = new AssemblyBinding();
		assert.equal(binding.setViewportHeight(40), true);
		assert.equal(binding.setViewportHeight(40), false);
		assert.equal(binding.identity(), "asm:40");
		const snap = await binding.fetch(makeCtx({
			evaluateDetailed: async () => ({ result: "0x401126 <main+0>", variablesReference: 0, memoryReference: "0x401126" }),
			disassemble: async (_reference, count) =>
				Array.from({ length: count }, (_, index) => ({
					address: `0x${(0x400000 + index).toString(16)}`,
					instruction: index === 12 ? "push %rbp" : "nop",
				})),
		}));

		assert.ok((snap.instructions?.length ?? 0) >= 40);
	});
});

describe("InterleavedBinding", () => {
	it("groups mapped instructions beneath their source lines", async () => {
		const snap = await new InterleavedBinding(3, 3).fetch(makeCtx({
			getLocation: () => ({ file: "/tmp/example.c", line: 12 }),
			readSource: async () => ["line 11", "line 12", "line 13"],
			evaluateDetailed: async () => ({ result: "0x401127", variablesReference: 0, memoryReference: "0x401127" }),
			disassemble: async () => [
				{ address: "0x401126", symbol: "main", instruction: "mov", line: 11 },
				{ address: "0x401127", symbol: "main", instruction: "inc", line: 12, current: false },
				{ address: "0x401128", symbol: "main", instruction: "ret", line: 13 },
			],
		}));

		assert.equal(snap.kind, "interleaved");
		assert.deepEqual(snap.interleaved?.map((row) => row.kind), ["source", "instruction", "source", "instruction", "source", "instruction"]);
		assert.equal(snap.interleaved?.[1]?.kind, "instruction");
	});

	it("falls back to assembly rows when source is unavailable", async () => {
		const snap = await new InterleavedBinding(3, 3).fetch(makeCtx({
			getLocation: () => ({ file: "./stdio-common/printf.c", line: 32 }),
			readSource: async () => { throw new Error("ENOENT"); },
			evaluateDetailed: async () => ({ result: "0x401126 <__printf+0>", variablesReference: 0, memoryReference: "0x401126" }),
			disassemble: async () => [{ address: "0x401126", instruction: "push rbp", current: true }],
		}));

		assert.equal(snap.kind, "interleaved");
		assert.match(snap.info!, /showing assembly only/);
		assert.deepEqual(snap.interleaved?.map((row) => row.kind), ["instruction"]);
	});

});
