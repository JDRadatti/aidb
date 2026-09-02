import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WatchListView } from "../src/views/watch.ts";
import { ViewFlags } from "../src/viz/types.ts";
import type { FetchCtx } from "../src/viz/types.ts";

const flush = async (): Promise<void> => {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
};

function makeFetchCtx(over: Partial<FetchCtx> = {}): FetchCtx {
	return {
		evaluate: async (expr) => `val:${expr}`,
		evaluateDetailed: async (expr) => ({ result: `val:${expr}`, variablesReference: 0 }),
		getVariableChildren: async () => [],
		readMemory: async () => ({ address: "0x4000", data: new Uint8Array(0) }),
		...over,
	};
}

function makeView(over: Partial<FetchCtx> = {}): WatchListView {
	return new WatchListView(makeFetchCtx(over));
}

const key = (s: string) => s;

describe("WatchListView", () => {
	it("shows hints when empty", () => {
		const view = makeView();
		const lines = view.render(40);
		assert.ok(lines.some((l) => l.includes("/watch <expr>")));
	});

	it("o opens the prompt, typing accumulates, enter commits", async () => {
		const view = makeView();
		view.render(40);
		view.handleInput(key("o"));
		assert.ok(view.isPrompting());
		for (const ch of "price") view.handleInput(key(ch));
		assert.equal(view.getPrompt(), "price");
		view.handleInput(key("\r"));
		assert.ok(!view.isPrompting());
		await flush();
		assert.equal(view.getEntries().length, 1);
		assert.equal(view.getEntries()[0]!.value, "val:price");
	});

	it("escape cancels the prompt without adding an entry", () => {
		const view = makeView();
		view.render(40);
		view.handleInput(key("o"));
		view.handleInput(key("x"));
		view.handleInput(key("\x1b"));
		assert.ok(!view.isPrompting());
		assert.equal(view.getEntries().length, 0);
	});

	it("d deletes the entry under the cursor (the cursor follows the newest entry)", async () => {
		const view = makeView();
		view.add("a");
		view.add("b");
		await flush();
		view.handleInput(key("d"));
		assert.deepEqual(view.getEntries().map((e) => e.expr), ["a"]);
	});

	it("enter re-evaluates the entry under the cursor", async () => {
		let calls = 0;
		const view = makeView({
			evaluateDetailed: async (expr) => {
				calls++;
				return { result: String(calls), variablesReference: 0 };
			},
		});
		view.add("hp");
		await flush();
		assert.equal(calls, 1);
		view.handleInput(key("\r"));
		await flush();
		assert.equal(calls, 2);
		assert.equal(view.getEntries()[0]!.value, "2");
	});

	it("evaluator failures are shown as errors, not thrown", async () => {
		const view = makeView({
			evaluateDetailed: async () => {
				throw new Error('No symbol "x"');
			},
		});
		view.add("x");
		await flush();
		const lines = view.render(60).join("\n");
		assert.ok(lines.includes("x"), "expression missing");
		assert.ok(lines.includes('No symbol "x"'), "error message missing");
		assert.ok(lines.includes("✗"));
	});

	it("backspace edits the prompt", () => {
		const view = makeView();
		view.render(40);
		view.handleInput(key("o"));
		view.handleInput(key("a"));
		view.handleInput(key("b"));
		view.handleInput(key("\x7f"));
		assert.equal(view.getPrompt(), "a");
	});

	it("prompt keys do not leak into navigation", () => {
		const view = makeView();
		view.add("one");
		view.render(40);
		view.handleInput(key("o"));
		view.handleInput(key("j"));
		assert.equal(view.getPrompt(), "j");
	});

	it("re-renders from cache when switching between memory renderers", async () => {
		let reads = 0;
		const view = makeView({
			evaluateDetailed: async () => ({ result: "buf", type: "char [8]", variablesReference: 0, memoryReference: "0x1000" }),
			readMemory: async () => {
				reads++;
				return { address: "0x1000", data: new Uint8Array([0x41, 0x42, 0x43, 0x00]) };
			},
		});
		view.add("message");
		await flush();
		assert.equal(reads, 1);
		assert.ok(view.setRenderSpec(0, { rendererId: "bytes" }));
		await flush();
		assert.equal(reads, 1, "bytes renderer should reuse the cached observation");
		assert.match(view.getEntries()[0]!.value!, /41 42 43/);
	});

	it("cycling the renderer and toggling flags never refetches", async () => {
		let reads = 0;
		const view = makeView({
			evaluateDetailed: async () => ({ result: "buf", type: "char [8]", variablesReference: 0, memoryReference: "0x1000" }),
			readMemory: async () => {
				reads++;
				return { address: "0x1000", data: new Uint8Array([0x41, 0x42, 0x43]) };
			},
		});
		view.add("message");
		await flush();
		assert.equal(reads, 1);

		// Cycles through compatible renderers (lines -> text -> bytes...) in
		// place using the cached bytes. The compatible subset is capped by what
		// the observation can actually render.
		view.cycleRendererAt(0); // lines -> text
		assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "text");
		view.cycleRendererAt(0); // text -> bytes
		assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "bytes");
		assert.equal(reads, 1, "renderer cycling must not refetch");

		// Toggling a flags is render-only.
		const before = view.getEntries()[0]!.renderSpec.flags ?? 0;
		view.toggleFlagAt(0, ViewFlags.ADDRESSES);
		assert.notEqual(view.getEntries()[0]!.renderSpec.flags, before);
		assert.equal(reads, 1, "flag toggling must not refetch");
	});

	it("cycling skips renderers the observation cannot consume", async () => {
		// Value-only observation: no memory, tree, samples, rows, or lines.
		const view = makeView({
			evaluateDetailed: async (expr) => ({ result: `val:${expr}`, variablesReference: 0 }),
		});
		view.add("hp");
		await flush();

		// Only value/text renderers are compatible, so sparkline/struct-tree/table
		// are skipped entirely.
		view.cycleRendererAt(0);
		assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "text");
		view.cycleRendererAt(0);
		assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "lines", "wraps back within the compatible subset");
	});

	describe("auto-dispatch + multi-line blocks", () => {
		function structCtx(): FetchCtx {
			return makeFetchCtx({
				evaluateDetailed: async () => ({
					result: "{...}",
					type: "struct Player",
					variablesReference: 7,
					memoryReference: "0x4000",
				}),
				getVariableChildren: async () => [
					{ name: "hp", value: "99", type: "int", hasChildren: false },
					{ name: "pos", value: "{...}", type: "Vec2", hasChildren: true, ref: 8, variablesReference: 8 },
				],
			});
		}

		it("auto-picks struct-tree for struct observations", async () => {
			const view = makeView(structCtx());
			view.add("player");
			await flush();
			assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "struct-tree");
		});

		it("keeps C strings on the string-friendly lines renderer", async () => {
			const view = makeView({
				evaluateDetailed: async () => ({
					result: '"hello\\000\\000"',
					type: "char [16]",
					variablesReference: 0,
					memoryReference: "0x4000",
				}),
				readMemory: async () => ({ address: "0x4000", data: new Uint8Array(0) }),
			});
			view.add("name");
			await flush();
			assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "lines");
			assert.equal(view.getEntries()[0]!.value, '"hello"');
		});

		it("auto-picks struct-tree for bare C++ class types (regression: showed '—')", async () => {
			// gdb reports C++ aggregates WITHOUT the struct/class keyword; the
			// dispatch used to key on that keyword and left `Player` on raw
			// `lines`, which formats an empty aggregate value as `—`.
			const view = makeView({
				evaluateDetailed: async () => ({
					result: "",
					type: "Player",
					variablesReference: 7,
					memoryReference: "0x4000",
				}),
				getVariableChildren: async () => [
					{ name: "x", value: "99", type: "int", hasChildren: false },
					{ name: "y", value: "", type: "int [2]", hasChildren: true, ref: 8, variablesReference: 8 },
					{ name: "z", value: '"hi", \'\\000\' <repeats 13 times>', type: "char [2]", hasChildren: false },
				],
				readMemory: async () => ({ address: "0x4000", data: new Uint8Array(0) }),
			});
			view.add("p");
			await flush();
			assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "struct-tree");
			const text = view.render(60).join("\n");
			assert.match(text, /> p = Player = \{x = 99, y = \{…\}, z = "hi"\}/);
			assert.match(text, /^ {2}├─ x: int = 99/m);
		});

		it("auto-picks array for T[N] observations", async () => {
			const view = makeView({
				evaluateDetailed: async () => ({
					result: "",
					type: "int [3]",
					variablesReference: 5,
					memoryReference: "0x4000",
				}),
				getVariableChildren: async () => [
					{ name: "[0]", value: "10", type: "int", hasChildren: false },
					{ name: "[1]", value: "20", type: "int", hasChildren: false },
					{ name: "[2]", value: "30", type: "int", hasChildren: false },
				],
				readMemory: async () => ({ address: "0x4000", data: new Uint8Array(0) }),
			});
			view.add("ints");
			await flush();
			assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "array");
			assert.match(view.getEntries()[0]!.value!, /int \[3\] \{10, 20, 30\}/);
		});

		it("pretty-prints a struct tree as a multi-line block", async () => {
			const view = makeView(structCtx());
			view.add("player");
			await flush();
			const text = view.render(60).join("\n");
			// Root line keeps the type but drops the duplicated expr name; children
			// indent underneath it.
			assert.match(text, /player = struct Player = \{\.\.\.\}/);
			assert.match(text, /^ {2}├─ hp: int = 99/m);
			assert.match(text, /^ {2}└─ pos: Vec2 = \{\.\.\.\}/m);
		});

		it("d deletes whole multi-line entries via the row→entry map", async () => {
			const view = makeView(structCtx());
			view.add("player"); // multi-line block
			view.add("hp");
			await flush();
			// Cursor follows the newest entry (hp, one row below the tree).
			view.handleInput(key("d"));
			assert.deepEqual(view.getEntries().map((e) => e.expr), ["player"]);
		});

		it("first manual cycle pins the renderer (auto-dispatch stops)", async () => {
			const view = makeView(structCtx());
			view.add("player");
			await flush();
			assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "struct-tree");

			view.cycleRendererAt(0);
			assert.notEqual(view.getEntries()[0]!.renderSpec.rendererId, "struct-tree");
			await view.refreshAll();
			await flush();
			assert.notEqual(view.getEntries()[0]!.renderSpec.rendererId, "struct-tree", "refresh must not re-dispatch over an explicit choice");
		});

		it("restored entries are pinned and never auto-dispatch", async () => {
			const view = makeView(structCtx());
			view.restore([{ expr: "player", renderSpec: { rendererId: "lines" }, byteCount: 192 }]);
			await view.refreshAll();
			await flush();
			assert.equal(view.getEntries()[0]!.renderSpec.rendererId, "lines");
		});
	});

	describe("restore", () => {
		it("rehydrates persisted entries without fetching", () => {
			const view = makeView();
			view.restore([
				{ expr: "&player", renderSpec: { rendererId: "hexdump", flags: ViewFlags.ADDRESSES }, byteCount: 192 },
				{ expr: "hp", renderSpec: { rendererId: "lines" }, byteCount: 192 },
			]);
			const entries = view.getEntries();
			assert.equal(entries.length, 2);
			assert.equal(entries[0]!.expr, "&player");
			assert.equal(entries[0]!.renderSpec.rendererId, "hexdump");
			assert.equal(entries[0]!.renderSpec.flags, ViewFlags.ADDRESSES);
			assert.equal(entries[0]!.pending, true);
		});
		it("ignores empty expressions", () => {
			const view = makeView();
			view.restore([{ expr: "", renderSpec: { rendererId: "lines" }, byteCount: 192 }]);
			assert.equal(view.getEntries().length, 0);
		});
	});
});
