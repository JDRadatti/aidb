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
		assert.ok(lines.some((l) => l.includes("o: add expression")));
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

	it("d deletes the entry under the cursor", async () => {
		const view = makeView();
		view.add("a");
		view.add("b");
		await flush();
		view.handleInput(key("k"));
		view.handleInput(key("d"));
		assert.deepEqual(view.getEntries().map((e) => e.expr), ["b"]);
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

		// Cycles through renderers in place using the cached bytes.
		view.cycleRendererAt(0); // lines -> text -> bytes...
		const spec = view.getEntries()[0]!.renderSpec;
		assert.notEqual(spec.rendererId, "lines");
		assert.equal(reads, 1, "renderer cycling must not refetch");

		// Toggling a flags is render-only.
		const before = view.getEntries()[0]!.renderSpec.flags ?? 0;
		view.toggleFlagAt(0, ViewFlags.ADDRESSES);
		assert.notEqual(view.getEntries()[0]!.renderSpec.flags, before);
		assert.equal(reads, 1, "flag toggling must not refetch");
	});
});
