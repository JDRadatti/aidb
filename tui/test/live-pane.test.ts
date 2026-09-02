import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { handleReplInput, makeLivePaneView, parseLoadSpec, refreshLivePanes, type ReplContext, type ReplIO } from "../src/repl.ts";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";
import { LivePaneView } from "../src/views/live-pane.ts";
import { WatchListView } from "../src/views/watch.ts";
import { ExpressionBinding, InterleavedBinding, LocalsBinding, MemoryBinding, RegistersBinding, SeriesBinding, SourceBinding, TreeBinding, bindingFromSpec, specFromBinding } from "../src/viz/bindings.ts";
import { ViewFlags } from "../src/viz/types.ts";
import type { BindingSnapshot, PaneBindingSpec } from "../src/viz/types.ts";

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
				evaluateDetailed: async (expr: string) => ({ result: `${expr}={...}`, variablesReference: 0 }),
				getVariableChildren: async () => [],
				readMemory: async () => ({ address: "0x4000", data: new Uint8Array(0) }),
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

const lastMessage = (messages: ReturnType<typeof makeContext>["messages"]): string => messages.at(-1)!.text;

describe("parseLoadSpec", () => {
	it("pairs each keyword with its default interpreter", () => {
		assert.equal(parseLoadSpec("regs")?.interpreterId, "table");
		assert.ok(parseLoadSpec("regs")?.binding instanceof RegistersBinding);
		assert.ok(parseLoadSpec("mem &player")?.binding instanceof MemoryBinding);
		assert.equal(parseLoadSpec("mem &player")?.interpreterId, "hexdump");
		assert.ok(parseLoadSpec("plot hp")?.binding instanceof SeriesBinding);
		assert.equal(parseLoadSpec("plot hp")?.interpreterId, "sparkline");
		assert.ok(parseLoadSpec("tree player")?.binding instanceof TreeBinding);
		assert.equal(parseLoadSpec("tree player")?.interpreterId, "struct-tree");
		assert.ok(parseLoadSpec("locals")?.binding instanceof LocalsBinding);
		assert.equal(parseLoadSpec("locals")?.interpreterId, "struct-tree");
		assert.ok(parseLoadSpec("iasm")?.binding instanceof InterleavedBinding);
		assert.equal(parseLoadSpec("iasm")?.interpreterId, "iasm");
	});

	it("keeps multi-word expressions intact and rejects incomplete specs", () => {
		assert.deepEqual(parseLoadSpec("mem buf + 4")?.binding.identity(), new MemoryBinding("buf + 4").identity());
		assert.deepEqual(parseLoadSpec("mem frame 12")?.binding.identity(), new MemoryBinding("frame", 12).identity());
		assert.equal(new MemoryBinding("&p").identity(), "mem:&p:192");
		assert.equal(parseLoadSpec("mem"), undefined);
		assert.equal(parseLoadSpec("plot"), undefined);
		assert.equal(parseLoadSpec("tree"), undefined);
		assert.equal(parseLoadSpec("locals now"), undefined);
		assert.equal(parseLoadSpec("regs now"), undefined);
		assert.equal(parseLoadSpec("wat is this"), undefined);
	});
});

	describe("binding spec round-trip (layout persistence)", () => {
		it("serializes and rebuilds every /win load binding", () => {
			const cases: Array<[string, PaneBindingSpec]> = [
				["regs", { kind: "regs" }],
				["source", { kind: "source" }],
				["asm", { kind: "asm" }],
				["iasm", { kind: "iasm" }],
				["mem buf + 4", { kind: "mem", at: "buf + 4", byteCount: 192 }],
				["mem frame 12", { kind: "mem", at: "frame", byteCount: 12 }],
				["plot hp", { kind: "plot", expr: "hp", historySize: 120 }],
				["tree player", { kind: "tree", expr: "player", depth: 2 }],
				["locals", { kind: "locals" }],
			];
			for (const [spec, expected] of cases) {
				const parsed = parseLoadSpec(spec)!;
				assert.deepEqual(specFromBinding(parsed.binding), expected, `spec for ${spec}`);
				const rebuilt = bindingFromSpec(expected);
				assert.equal(rebuilt.identity(), parsed.binding.identity(), `identity for ${spec}`);
			}
		});

		it("refuses bindings layouts can't save", () => {
			assert.equal(specFromBinding(new ExpressionBinding("n")), undefined);
		});

		it("makeLivePaneView rebuilds a saved live pane verbatim", async () => {
			const { ctx } = makeContext();
			await handleReplInput("/win vsplit src", ctx);
			await handleReplInput("/win load src source", ctx);
			const view = ctx.windows.component("src") as LivePaneView;
			const saved = { spec: specFromBinding(view.getBinding())!, interpreterId: view.getInterpreterId(), flags: view.getFlags() };

			const rebuilt = makeLivePaneView(ctx, "src", saved);
			assert.equal(rebuilt.getBindingIdentity(), view.getBindingIdentity());
			assert.equal(rebuilt.getInterpreterId(), view.getInterpreterId());
			assert.equal(rebuilt.getFlags(), view.getFlags());
		});
	});
		describe("LivePaneView", () => {
	function memoryView(over: Record<string, unknown> = {}) {
		let readCalls = 0;
		const ctx = makeContext({
			readMemory: async () => {
				readCalls++;
				return { address: "0x4000", data: new Uint8Array([0x41, 0x42]) };
			},
			...over,
		});
		const view = new LivePaneView(new MemoryBinding("&buf", 2), "hexdump", ctx.ctx.getApi() as never);
		return { view, calls: () => readCalls };
	}

	it("renders the fetched snapshot through its interpreter", async () => {
		const { view } = memoryView();
		assert.equal(view.title, "&buf · mem · hexdump");
		await view.refreshAll();
		const lines = view.render(60);
		assert.ok(lines.some((line) => line.includes("41 42")), `expected bytes in ${JSON.stringify(lines)}`);
	});

	it("anchors source scroll on the current line, then scrolls its buffer", async () => {
		const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
		const ctx = makeContext({
			getLocation: () => ({ file: "/tmp/example.c", line: 60 }),
			readSource: async (_file: string, start: number, count: number) =>
				Array.from({ length: count }, (_, i) => `line ${start + i}`),
			getBreakpoints: () => [],
		});
		const view = new LivePaneView(new SourceBinding(), "code", ctx.ctx.getApi() as never, { viewportHeight: 10 });
		await view.refreshAll();

		// The current line (60) sits inside the wide buffer; the pane centers on it.
		const anchored = view.render(60);
		assert.ok(anchored.some((line) => plain(line).includes("▶") && plain(line).includes("line 60")), `expected ▶ at line 60, got:\n${anchored.join("\n")}`);

		// pageUp scrolls toward the top of the buffer; the anchored line moves off.
		view.handleInput("\x1b[5~");
		const scrolled = view.render(60);
		assert.ok(scrolled.some((line) => /line \d+/.test(plain(line))), `expected source lines after scroll, got:\n${scrolled.join("\n")}`);
		assert.ok(!scrolled.some((line) => plain(line).includes("line 60")), "current line should be scrolled off");
	});

	it("renders binding failures as an error frame instead of throwing", async () => {
		const { view } = memoryView({
			readMemory: async () => {
				throw new Error('Cannot access memory at address "zzz"');
			},
		});
		await view.refreshAll();
		assert.ok(view.render(60).some((line) => line.includes("✗ Cannot access memory")));
	});

	it("toggleFlag re-renders in place without refetching", async () => {
		const { view, calls } = memoryView();
		await view.refreshAll();
		const before = calls();
		const flagsBefore = view.getFlags();
		view.toggleFlag(ViewFlags.HIDE_CHANGES);
		assert.notEqual(view.getFlags(), flagsBefore, "flag should toggle");
		assert.ok((view.getFlags()! & ViewFlags.HIDE_CHANGES) !== 0, "HIDE_CHANGES bit set");
		assert.equal(calls(), before, "flag toggling must not refetch");
	});

	it("toggleFlag starts from renderer defaults so other bits survive", async () => {
		const { view } = memoryView();
		await view.refreshAll();
		view.toggleFlag(ViewFlags.TYPES);
		const flags = view.getFlags()!;
		assert.ok((flags & ViewFlags.ADDRESSES) !== 0, "hexdump default gutter survives toggle");
		assert.ok((flags & ViewFlags.ASCII) !== 0, "hexdump default ascii survives toggle");
	});

	it("setInterpreter swaps the renderer in place over the same snapshot", async () => {
		const { view } = memoryView();
		await view.refreshAll();
		const before = view.render(60).join("\n");
		assert.ok(before.includes("41 42"));
		assert.ok(view.setInterpreter("sparkline"));
		assert.equal(view.getInterpreterId(), "sparkline");
		assert.match(view.title, /sparkline/);
		const after = view.render(60).join("\n");
		// A memory snapshot lacks samples, so the renderer reports its
		// requirement without refetching or producing misleading output.
		assert.match(after, /sparkline.*requires: samples/);
		assert.notEqual(before, after);
		assert.ok(!view.setInterpreter("nope"));
	});

	it("centers the current assembly instruction on the first refresh", async () => {
		const instructions = Array.from({ length: 40 }, (_, index) => ({
			address: `0x${(0x4000 + index).toString(16)}`,
			instruction: "nop",
			current: index === 11,
		}));
		const view = new LivePaneView({
			kind: "assembly",
			identity: () => "test-assembly",
			describe: () => "assembly",
			fetch: async (): Promise<BindingSnapshot> => ({ kind: "assembly", instructions }),
		}, "code", {} as never, { viewportHeight: 8 });

		await view.refreshAll();
		const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const lines = view.render(80);
		assert.equal(lines.map(plain).findIndex((line) => line.startsWith("▶")), 4, JSON.stringify(lines));
		for (const [index, instruction] of instructions.entries()) instruction.current = index === 28;
		await view.refreshAll();
		const movedLines = view.render(80);
		assert.equal(movedLines.map(plain).findIndex((line) => line.startsWith("▶")), 4, JSON.stringify(movedLines));
	});

	it("recenters the initial assembly instruction after the pane gets resized", async () => {
		const instructions = Array.from({ length: 40 }, (_, index) => ({
			address: `0x${(0x4000 + index).toString(16)}`,
			instruction: "nop",
			current: index === 11,
		}));
		const view = new LivePaneView({
			kind: "assembly",
			identity: () => "test-assembly-resize",
			describe: () => "assembly",
			fetch: async (): Promise<BindingSnapshot> => ({ kind: "assembly", instructions }),
		}, "code", {} as never);

		await view.refreshAll();
		view.setViewportHeight(8);
		const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const lines = view.render(80);
		assert.equal(lines.map(plain).findIndex((line) => line.startsWith("▶")), 4, JSON.stringify(lines));
	});

	it("refetches interleaved data with a larger source window after resize", async () => {
		const requestedLines: number[] = [];
		const binding = new InterleavedBinding(6, 3);
		const ctx = makeContext({
			sourceFile: "/tmp/example.c",
			currentLine: 12,
			readSource: async (_file: string, _start: number, count: number) => {
				requestedLines.push(count);
				return Array.from({ length: count }, () => "source");
			},
			evaluateDetailed: async () => ({ result: "0x401126", variablesReference: 0, memoryReference: "0x401126" }),
			disassemble: async () => [{ address: "0x401126", instruction: "nop", line: 12 }],
		});
		const fetchCtx = {
			evaluate: async () => "0x401126",
			evaluateDetailed: async () => ({ result: "0x401126", variablesReference: 0, memoryReference: "0x401126" }),
			getVariableChildren: async () => [],
			readMemory: async () => ({ address: "0x0", data: new Uint8Array() }),
			getLocation: () => ({ file: "/tmp/example.c", line: 12 }),
			readSource: async (_file: string, _start: number, count: number) => {
				requestedLines.push(count);
				return Array.from({ length: count }, () => "source");
			},
			disassemble: async () => [{ address: "0x401126", instruction: "nop", line: 12 }],
		};
		const view = new LivePaneView({
			kind: "interleaved",
			identity: () => binding.identity(),
			describe: () => binding.describe(),
			setViewportHeight: (rows) => binding.setViewportHeight?.(rows) ?? false,
			fetch: (_ctx, previous) => binding.fetch(fetchCtx, previous),
		}, "iasm", fetchCtx, { viewportHeight: 8 });

		await view.refreshAll();
		view.setViewportHeight(20);
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.deepEqual(requestedLines, [6, 10]);
	});

	it("coalesces refresh requests that land mid-fetch", async () => {
		const { view, calls } = memoryView();
		const first = view.refreshAll();
		const second = view.refreshAll();
		await Promise.all([first, second]);
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(calls(), 2, "one in-flight fetch plus exactly one dirty re-run");
		const lines = view.render(60);
		assert.ok(lines.some((line) => line.includes("41 42")));
	});

	it("keeps change highlighting across a same-stop duplicate refresh", async () => {
		// A stop triggers several refreshes (stopped + location + breakpoints).
		// Each coalesces into one more fetch of the same stop's data; that must
		// NOT advance prevSnap, or the change highlight disappears immediately.
		let value = 1;
		const binding = {
			kind: "registers" as const,
			identity: () => "registers",
			describe: () => "registers",
			fetch: async (): Promise<BindingSnapshot> => ({
				kind: "registers",
				rows: [["rax", `0x${value}`, String(value), "0x4000"]],
			}),
		};
		const view = new LivePaneView(binding, "table", {} as never);

		await view.refreshAll(true); // first stop → no prior state
		value = 2; // next stop changes rax
		await view.refreshAll(true);
		const highlighted = view.render(40).join("\n");
		assert.match(highlighted, /\x1b\[38;5;33m0x2/);

		await view.refreshAll(false); // same stop: location/breakpoints duplicate
		assert.equal(view.render(40).join("\n"), highlighted, "highlight must survive the duplicate fetch");
	});

	it("clears plot history and snapshots when a new run begins", async () => {
		let value = 1;
		const ctx = makeContext({ evaluate: async () => String(value) });
		const binding = new SeriesBinding("total");
		const view = new LivePaneView(binding, "sparkline", ctx.ctx.getApi() as never);
		await view.refreshAll();
		value = 2;
		await view.refreshAll();
		assert.match(view.render(60).join("\n"), /2 stops/);

		view.reset();
		assert.deepEqual(binding.samples(), []);
		value = 9;
		await view.refreshAll();
		assert.match(view.render(60).join("\n"), /last 9 · 1 stops/);
	});
});

describe("/win load and /win pick", () => {
	it("/win load binds a pane to a live visualizer and fetches immediately", async () => {
		const evaluateContexts: string[] = [];
		const { ctx, panes, messages } = makeContext({
			evaluate: async (expr: string, context?: string) => {
				evaluateContexts.push(context ?? "");
				return "rax 0x1 1";
			},
		});
		await handleReplInput("/win vsplit live", ctx);
		await handleReplInput("/win load live regs", ctx);

		const view = panes.get("live");
		assert.ok(view instanceof LivePaneView);
		assert.equal(ctx.windows.active, "live");
		assert.equal(view.getBindingIdentity(), "registers");
		assert.match(lastMessage(messages), /Bound 'live' to registers \(table\)/);
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(evaluateContexts, ["repl"]); // RegistersBinding evaluates on the console path
		assert.ok(view.render(40).join("\n").includes("rax"));
	});

	it("/win load supports source and assembly views", async () => {
		const { ctx, panes } = makeContext({
			sourceFile: "/tmp/example.c",
			currentLine: 4,
			readSource: undefined,
		});
		await handleReplInput("/win vsplit src", ctx);
		await handleReplInput("/win load src source", ctx);
		assert.ok(panes.get("src") instanceof LivePaneView);
		assert.equal((panes.get("src") as LivePaneView).getBindingIdentity(), "source:24");

		await handleReplInput("/win vsplit asm", ctx);
		await handleReplInput("/win load asm asm", ctx);
		assert.ok(panes.get("asm") instanceof LivePaneView);
		assert.equal((panes.get("asm") as LivePaneView).getBindingIdentity(), "asm:24");
	});

	it("/win load refuses the transcript pane and unknown specs", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("/win load 0 regs", ctx);
		assert.match(lastMessage(messages), /hosts the transcript/);
		await handleReplInput("/win vsplit live", ctx);
		messages.length = 0;
		await handleReplInput("/win load live wat", ctx);
		assert.match(lastMessage(messages), /Cannot visualize "wat"/);
		assert.equal(ctx.windows.component("live"), undefined);
	});

	it("/win pick lists interpreters and swaps one in place", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit live", ctx);
		await handleReplInput("/win load live tree player", ctx);
		messages.length = 0;

		await handleReplInput("/win pick live", ctx);
		const listing = messages.map((m) => m.text).join("\n");
		assert.match(listing, /hexdump/);
		assert.match(listing, /struct-tree \*/);
		messages.length = 0;

		await handleReplInput("/win pick lines", ctx); // no pane arg → active pane
		const view = windows.component("live") as LivePaneView;
		assert.equal(view.getInterpreterId(), "lines");
		assert.match(lastMessage(messages), /renders with lines \(value lines\)/);
	});

	it("/win pick +flag toggles a render flag without refetching", async () => {
		const { ctx, windows, messages } = makeContext();
		await handleReplInput("/win vsplit live", ctx);
		await handleReplInput("/win load live mem &buf 4", ctx);
		await new Promise((r) => setTimeout(r, 0));
		const view = windows.component("live") as LivePaneView;
		const visible = view.getFlags();
		messages.length = 0;

		await handleReplInput("/win pick live +types", ctx);
		assert.notEqual(view.getFlags(), visible, "flag should toggle");
		assert.match(lastMessage(messages), /type/);
	});

	it("/win pick refuses panes without a live binding", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("/win vsplit blank", ctx);
		await handleReplInput("/win pick blank hexdump", ctx);
		assert.match(lastMessage(messages), /not a live pane/);
	});
});

describe("refreshLivePanes covers viz panes too", () => {
	it("re-runs bindings in LivePaneViews alongside watch lists", async () => {
		const values: Record<string, number> = { n: 1 };
		const { ctx, windows } = makeContext({
			evaluate: async (expr: string) => String(expr === "n" ? values.n : 7),
		});
		await handleReplInput("/win vsplit live", ctx);
		await handleReplInput("/win load live plot n", ctx);
		await handleReplInput("/win hsplit 0 watch2", ctx);
		ctx.windows.mount("watch2", new WatchListView({
			evaluate: async (expr) => `${expr}=${values.n}`,
			evaluateDetailed: async (expr) => ({ result: `${expr}=${values.n}`, variablesReference: 0 }),
			getVariableChildren: async () => [],
			readMemory: async () => ({ address: "0x0", data: new Uint8Array(0) }),
		}));

		const live = windows.component("live") as LivePaneView;
		const watch = windows.component("watch2") as WatchListView;
		watch.add("n");
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(live.render(60).filter((l) => l.trim()).length > 0, true);
		const samplesBefore = JSON.stringify(live.render(60));

		values.n = 5;
		refreshLivePanes(ctx);
		await new Promise((r) => setTimeout(r, 0));
		assert.match(watch.getEntries()[0]!.value!, /=5$/);
		assert.notEqual(JSON.stringify(live.render(60)), samplesBefore); // footer shows "2 stops"
	});
});
