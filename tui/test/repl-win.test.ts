import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { handleReplInput, refreshLivePanes, type ReplContext, type ReplIO } from "../src/repl.ts";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";
import { WatchListView } from "../src/views/watch.ts";
import type { FetchCtx } from "../src/viz/types.ts";

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
		getApi: () => {
			const evaluate = (api.evaluate as ((expr: string, context?: string) => Promise<string>) | undefined)
				?? (async (expr: string) => `${expr}=42`);
			return {
				...api,
				evaluate,
				evaluateDetailed:
					(api.evaluateDetailed as ((expr: string) => Promise<{ result: string; variablesReference: number }>) | undefined)
					?? (async (expr: string) => ({ result: String(await evaluate(expr)), variablesReference: 0 })),
				getVariableChildren: (api.getVariableChildren as FetchCtx["getVariableChildren"] | undefined) ?? (async () => []),
				readMemory: (api.readMemory as FetchCtx["readMemory"] | undefined)
					?? (async () => ({ address: "0x0", data: new Uint8Array(0) })),
			} as never;
		},
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
	it("/win switch moves the active pane and rejects bad indices", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit", ctx);
		await handleReplInput("/win switch 0", ctx);
		assert.equal(windows.active, "repl");
		await handleReplInput("/win switch 1", ctx);
		assert.equal(windows.active, "pane2");
		await handleReplInput("/win switch 5", ctx);
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

	it("/win splits can name panes; /win switch resolves names", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit mem", ctx);
		assert.deepEqual(windows.list().map((p) => p.id), ["repl", "mem"]);
		await handleReplInput("/win switch mem", ctx);
		assert.equal(windows.active, "mem");
		await handleReplInput("/win switch nope", ctx);
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

	it("gdb `display <expr>` auto-creates a watch pane and pins the expression", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("display frame", ctx);
		const view = windows.component("watch") as WatchListView | undefined;
		assert.ok(view instanceof WatchListView, "display creates the same live watch pane as /watch");
		assert.equal(windows.active, "repl", "creating the pane must not steal focus");
		assert.deepEqual(view.getEntries().map((e) => e.expr), ["frame"]);
		assert.match(messages.map((m) => m.text).join("\n"), /display 1: frame/);
	});

	it("display numbers are 1-based watch indices; info display lists, undisplay removes", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("display a", ctx);
		assert.match(messages.at(-1)!.text, /display 1: a/);
		await handleReplInput("display b", ctx);
		assert.match(messages.at(-1)!.text, /display 2: b/);

		await handleReplInput("info display", ctx);
		const listed = messages.map((m) => m.text).join("\n");
		assert.match(listed, /0\./); // watch pane env in the listing is index-based
		assert.match(listed, /a/);
		assert.match(listed, /b/);

		await handleReplInput("undisplay 1", ctx);
		const view = windows.component("watch") as WatchListView;
		assert.deepEqual(view.getEntries().map((e) => e.expr), ["b"], "undisplay 1 removed the first entry");
		assert.match(messages.at(-1)!.text, /Undisplayed 1 \(a\)/);
	});

	it("undisplay with no watchers / an out-of-range index is a guarded no-op", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("undisplay 3", ctx);
		assert.match(messages.at(-1)!.text, /Nothing to undisplay/);
	});

	it("bare `display` lists without creating a pane", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("display", ctx);
		assert.deepEqual(windows.list().map((p) => p.id), ["repl"], "a bare listing never spawns a pane");
		assert.match(messages.map((m) => m.text).join("\n"), /No watch pane yet/);
	});

	it("/watch cycle lists change the renderer of an entry", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/watch i", ctx);
		await handleReplInput("/watch sum", ctx);
		const view = windows.component("watch") as WatchListView;
		assert.equal(view.getEntries()[0].renderSpec.rendererId, "lines");

		await handleReplInput("/watch cycle 0", ctx);
		assert.equal(view.getEntries()[0].renderSpec.rendererId, "text");
		assert.equal(view.getEntries()[1].renderSpec.rendererId, "lines", "entry 1 untouched");
		assert.match(messages.map((m) => m.text).join("\n"), /renderer text/);
	});

	it("each watch entry keeps an independent renderer", async () => {
		const { ctx, windows } = makeContext();
		await handleReplInput("/watch count", ctx);
		await handleReplInput("/watch ptr", ctx);
		const view = windows.component("watch") as WatchListView;
		assert.equal(view.getEntries()[0].renderSpec.rendererId, "lines");
		assert.equal(view.getEntries()[1].renderSpec.rendererId, "lines");

		await handleReplInput("/watch cycle 0", ctx); // entry 0 -> text
		await handleReplInput("/watch cycle 1", ctx); // entry 1 -> text
		await handleReplInput("/watch cycle 0", ctx); // entry 0 wraps back to lines
		assert.equal(view.getEntries()[0].renderSpec.rendererId, "lines");
		assert.equal(view.getEntries()[1].renderSpec.rendererId, "text", "entry 1 independently cycles");

		await handleReplInput("/watch flag types 0", ctx);
		assert.notEqual(view.getEntries()[0].renderSpec.flags ?? 0, 0, "entry 0 flag on its own");
		assert.equal(view.getEntries()[1].renderSpec.flags ?? 0, 0, "entry 1 flag untouched");
	});

	it("/watch flag toggles a flag on an entry by name", async () => {
		const { ctx, windows } = makeContext();
		await handleReplInput("/watch i", ctx);
		await handleReplInput("/watch sum", ctx);
		const view = windows.component("watch") as WatchListView;

		await handleReplInput("/watch flag types 1", ctx);
		assert.notEqual(view.getEntries()[1].renderSpec.flags ?? 0, 0, "flag should be set");
	});

	it("/watch del removes an entry", async () => {
		const { ctx, windows } = makeContext();
		await handleReplInput("/watch i", ctx);
		await handleReplInput("/watch sum", ctx);
		const view = windows.component("watch") as WatchListView;
		await handleReplInput("/watch del 0", ctx);
		assert.deepEqual(view.getEntries().map((e) => e.expr), ["sum"]);
	});

	it("/watch list prints entries with renderers and flags", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("/watch i", ctx);
		await handleReplInput("/watch cycle 0", ctx);
		messages.length = 0;
		await handleReplInput("/watch list", ctx);
		const listing = messages.map((m) => m.text).join("\n");
		assert.match(listing, /0\./);
		assert.match(listing, /text/);
	});

	it("refreshLivePanes re-evaluates on stops, across all watch panes", async () => {
		const values: Record<string, string> = { i: "1", n: "1" };
		const { ctx, windows } = makeContext({
			evaluate: async (expr: string) => `${expr}=${values[expr]}`,
		});
		await handleReplInput("/win hsplit 0 watch", ctx);
		await handleReplInput("/watch i", ctx); // evaluates to i=1
		await handleReplInput("/win vsplit 0 watch2", ctx);
		// /watch targets the first pane; add to watch2 directly.
		(windows.component("watch2") as WatchListView).add("n");
		await new Promise((r) => setTimeout(r, 0));

		values.i = "2";
		values.n = "2";
		refreshLivePanes(ctx); // a "stopped" event fired
		await new Promise((r) => setTimeout(r, 0));
		const first = windows.component("watch") as WatchListView;
		const second = windows.component("watch2") as WatchListView;
		assert.equal(first.getEntries()[0].value, "i=2"); // was i=1
		assert.equal(second.getEntries()[0].value, "n=2");
	});
});
