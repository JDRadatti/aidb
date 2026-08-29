import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { handleReplInput, getLastLaunch, setLastLaunch, type ReplContext, type ReplIO } from "../src/repl.ts";
import type { SessionHooks } from "../src/repl.ts";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";

interface Recorder {
	resets: number;
	markDirty: number;
	startNewCalls: Array<string | undefined>;
	savedTargets: string[];
	loadedTargets: string[];
	savedLayouts: string[];
	loadedLayouts: string[];
}

/** In-memory target/layout/session hook facade so commands are testable without disk. */
function makeHooks(rec: Recorder, over: { activeLayout?: string | null } = {}): SessionHooks {
	return {
		activeName: () => null,
		list: () => [],
		markDirty: () => {
			rec.markDirty++;
		},
		save: async () => {},
		setCurrent: () => {},
		remove: async () => {},
		startNew: async (name?: string) => {
			rec.startNewCalls.push(name?.trim() || "session");
		},
		restore: async () => {},
		targets: {
			current: () => null,
			list: () => [],
			save: async (name?: string) => {
				rec.savedTargets.push(name ?? "(active)");
			},
			load: async (name: string) => {
				rec.loadedTargets.push(name);
			},
			remove: async () => {},
		},
		layouts: {
			current: () => over.activeLayout ?? null,
			list: () => [],
			save: async (name: string) => {
				rec.savedLayouts.push(name);
			},
			load: async (name: string) => {
				rec.loadedLayouts.push(name);
				return Promise.resolve();
			},
			remove: async () => {},
		},
	};
}

function makeContext(over: {
	api?: Record<string, unknown>;
	withSessions?: boolean;
} = {}) {
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
	const rec: Recorder = { resets: 0, markDirty: 0, startNewCalls: [], savedTargets: [], loadedTargets: [], savedLayouts: [], loadedLayouts: [] };
	const ctx: ReplContext = {
		getApi: () => {
			const evaluate = (over.api?.evaluate as ((expr: string) => Promise<string>) | undefined)
				?? (async (expr: string) => `${expr}=42`);
			return {
				...over.api,
				evaluate,
				getState: () => "stopped",
				sourceFile: "example.c",
				currentLine: 12,
				breakpoints: new Map(),
			} as never;
		},
		reset: async () => {
			rec.resets++;
			return {} as never;
		},
		requestExit: () => {},
		requestRender: () => {},
		io,
		windows,
		...(over.withSessions ? { sessions: makeHooks(rec) } : {}),
	};
	return { ctx, windows, messages, rec };
}

const lastMessage = (messages: ReturnType<typeof makeContext>["messages"]): string =>
	messages.at(-1)!.text;

describe("target", () => {
	it("/target <name> loads a profile by name", async () => {
		const { ctx, rec } = makeContext({ withSessions: true });
		await handleReplInput("/target game", ctx);
		assert.deepEqual(rec.loadedTargets, ["game"]);
	});

	it("/target save persists the live target under a name", async () => {
		const { ctx, rec } = makeContext({ withSessions: true });
		setLastLaunch({ program: "/app", args: [] });
		await handleReplInput("/target save game", ctx);
		assert.deepEqual(rec.savedTargets, ["game"]);
	});

	it("/target switch <name> loads the profile (invisible alias)", async () => {
		const { ctx, rec } = makeContext({ withSessions: true });
		await handleReplInput("/target switch game", ctx);
		assert.deepEqual(rec.loadedTargets, ["game"]);
	});
});

describe("layout", () => {
	it("/layout save persists the current layout under a name", async () => {
		const { ctx, messages, rec } = makeContext({ withSessions: true });
		await handleReplInput("/win vsplit watch", ctx);
		await handleReplInput("/layout save code-watch", ctx);
		assert.deepEqual(rec.savedLayouts, ["code-watch"]);
		assert.match(lastMessage(messages), /Layout 'code-watch' saved/);
	});

	it("/layout switch loads a layout profile", async () => {
		const { ctx, rec } = makeContext({ withSessions: true });
		await handleReplInput("/layout switch code-watch", ctx);
		assert.deepEqual(rec.loadedLayouts, ["code-watch"]);
	});

	it("/layout save with an active profile updates it (no name needed)", async () => {
		const { ctx, rec, messages } = makeContext({ withSessions: true });
		ctx.sessions = makeHooks(rec, { activeLayout: "code-watch" });
		await handleReplInput("/layout save", ctx);
		assert.deepEqual(rec.savedLayouts, ["code-watch"]);
		assert.match(lastMessage(messages), /Layout 'code-watch' saved/);
	});

	it("/layout save with no active profile errors", async () => {
		const { ctx, messages } = makeContext({ withSessions: true });
		await handleReplInput("/layout save", ctx);
		assert.match(lastMessage(messages), /No active layout profile/);
	});

	it("/layout list shows saved layouts", async () => {
		const { ctx } = makeContext({ withSessions: true });
		await handleReplInput("/layout list", ctx);
		// no crash; lists empty gracefully
	});
});

describe("new", () => {
	it("/new with sessions off still resets the live debugger", async () => {
		const { ctx, rec } = makeContext();
		await handleReplInput("/new", ctx);
		assert.equal(rec.resets, 1);
		assert.equal(getLastLaunch(), null);
	});

	it("/new [name] calls startNew with the session hook", async () => {
		const { ctx, rec } = makeContext({ withSessions: true });
		await handleReplInput("/new bugfix", ctx);
		assert.deepEqual(rec.startNewCalls, ["bugfix"]);
	});

	it("/new with no name defaults to 'session'", async () => {
		const { ctx, rec } = makeContext({ withSessions: true });
		await handleReplInput("/new", ctx);
		assert.deepEqual(rec.startNewCalls, ["session"]);
	});
});