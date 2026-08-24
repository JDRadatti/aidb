import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { handleReplInput, type ReplContext, type ReplIO } from "../src/repl.ts";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";
import { WatchListView } from "../src/views/watch.ts";

function makeContext(api: Record<string, unknown> = {}) {
	const messages: Array<{ kind: string; text: string }> = [];
	const io: ReplIO = {
		line: (text) => messages.push({ kind: "line", text }),
		info: (text) => messages.push({ kind: "info", text }),
		success: (text) => messages.push({ kind: "success", text }),
		warning: (text) => messages.push({ kind: "warning", text }),
		error: (text) => messages.push({ kind: "error", text }),
	};
	const panes = new Map<string, Component>([["repl", { render: () => [], invalidate: () => {} }]]);
	const windows = new WindowManager(new SplitTree("repl"), { panes });
	const ctx: ReplContext = {
		getApi: () =>
			({
				evaluate: async (expr: string) => `${expr}=42`,
				...api,
			}) as never,
		reset: async () => ({}) as never,
		requestExit: () => {},
		requestRender: () => {},
		io,
		windows,
	};
	return { ctx, windows, panes, messages };
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

	it("/win splits can name panes; /switch resolves names", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit mem", ctx);
		assert.deepEqual(windows.list().map((p) => p.id), ["repl", "mem"]);
		await handleReplInput("/switch mem", ctx);
		assert.equal(windows.active, "mem");
		await handleReplInput("/switch nope", ctx);
		assert.match(lastMessage(messages), /No pane named 'nope'/);
	});

	it("/win close takes a name; digit-only names are rejected at split time", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit 0 3", ctx);
		assert.match(lastMessage(messages), /reserved/);
		await handleReplInput("/win vsplit 0 mem", ctx);
		await handleReplInput("/win close mem", ctx);
		assert.deepEqual(windows.list().map((p) => p.id), ["repl"]);
	});

	it("watch-named splits mount a live WatchListView", async () => {
		const { ctx, panes } = makeContext();
		await handleReplInput("/win hsplit 0 watch", ctx);
		const view = panes.get("watch");
		assert.ok(view instanceof WatchListView);
	});

	it("/watch auto-creates a live pane and pins expressions", async () => {
		const { ctx, windows, panes, messages } = makeContext();
		await handleReplInput("/watch i", ctx);
		const view = panes.get("watch");
		assert.ok(view instanceof WatchListView, "expected an auto-created watch pane");
		assert.equal(windows.active, "repl"); // creating the pane must not steal focus
		assert.match(messages.map((m) => m.text).join("\n"), /Created live watch pane 'watch'/);
		assert.equal(view.getEntries().length, 1);
		assert.equal(view.getEntries()[0].expr, "i");
		await new Promise((r) => setTimeout(r, 0)); // let the evaluator settle
		assert.match(view.getEntries()[0].value!, /=42$/);
	});

	it("a second /watch expression reuses the existing pane", async () => {
		const { ctx, windows } = makeContext();
		await handleReplInput("/watch i", ctx);
		await handleReplInput("/watch sum", ctx);
		assert.deepEqual(windows.list().map((p) => p.id), ["repl", "watch"]);
		const view = windows.component("watch") as WatchListView;
		assert.deepEqual(view.getEntries().map((e) => e.expr), ["i", "sum"]);
	});
});
