import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { handleReplInput, type ReplContext, type ReplIO } from "../src/repl.ts";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";

function makeContext() {
	const messages: Array<{ kind: string; text: string }> = [];
	const io: ReplIO = {
		line: (text) => messages.push({ kind: "line", text }),
		info: (text) => messages.push({ kind: "info", text }),
		success: (text) => messages.push({ kind: "success", text }),
		warning: (text) => messages.push({ kind: "warning", text }),
		error: (text) => messages.push({ kind: "error", text }),
	};
	const windows = new WindowManager(new SplitTree("repl"), {
		panes: new Map<string, Component>([["repl", { render: () => [], invalidate: () => {} }]]),
	});
	const ctx: ReplContext = {
		getApi: () => ({}) as never,
		reset: async () => ({}) as never,
		requestExit: () => {},
		io,
		windows,
	};
	return { ctx, windows, messages };
}

const lastMessage = (messages: ReturnType<typeof makeContext>["messages"]): string =>
	messages.at(-1)!.text;

describe("window commands", () => {
	it("/switch moves the active pane and rejects bad indices", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit", ctx);
		await handleReplInput("/switch 0", ctx);
		assert.equal(windows.active, "repl");
		await handleReplInput("/switch 1", ctx);
		assert.equal(windows.active, "pane2");
		await handleReplInput("/switch 5", ctx);
		assert.match(lastMessage(messages), /No pane at index 5/);
	});

	it("/win vsplit [idx] targets the given pane", async () => {
		const { ctx, windows } = makeContext();
		await handleReplInput("/win vsplit", ctx); // repl | pane2
		await handleReplInput("/win hsplit 1", ctx); // rows inside pane2
		const ids = windows.list().map((p) => p.id);
		assert.deepEqual(ids, ["repl", "pane2", "pane3"]);
	});

	it("/win close <idx> removes panes; the repl refuses", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit", ctx);
		await handleReplInput("/win close 0", ctx);
		assert.match(lastMessage(messages), /repl/);
		await handleReplInput("/win close 1", ctx);
		assert.deepEqual(windows.list().map((p) => p.id), ["repl"]);
	});

	it("/win list prints the idx mapping", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("/win vsplit", ctx);
		messages.length = 0;
		await handleReplInput("/win list", ctx);
		const text = messages.map((m) => m.text).join("\n");
		assert.match(text, /0\trepl/);
		assert.match(text, /1\tpane2 \*/); // splits activate the new pane
	});

	it("/win next cycles without any key shortcuts", async () => {
		const { ctx, windows } = makeContext();
		await handleReplInput("/win vsplit", ctx);
		await handleReplInput("/win next", ctx);
		assert.equal(windows.active, "repl");
	});
});
