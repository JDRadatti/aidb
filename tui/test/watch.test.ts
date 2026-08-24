import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WatchListView } from "../src/views/watch.ts";

const flush = async (): Promise<void> => {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
};

function makeView(evaluate?: (expr: string) => Promise<string>): WatchListView {
	return new WatchListView(evaluate ?? ((expr) => Promise.resolve(`val:${expr}`)));
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
		view.handleInput(key("k")); // cursor from b up to a
		view.handleInput(key("d"));
		assert.deepEqual(view.getEntries().map((e) => e.expr), ["b"]);
	});

	it("enter re-evaluates the entry under the cursor", async () => {
		let calls = 0;
		const view = makeView(() => {
			calls++;
			return Promise.resolve(String(calls));
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
		const view = makeView(() => Promise.reject(new Error("No symbol \"x\"")));
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
		view.handleInput(key("\x7f")); // backspace
		assert.equal(view.getPrompt(), "a");
	});

	it("prompt keys do not leak into navigation", () => {
		const view = makeView();
		view.add("one");
		view.render(40);
		view.handleInput(key("o"));
		view.handleInput(key("j")); // part of the expression, not a cursor move
		assert.equal(view.getPrompt(), "j");
	});
});
