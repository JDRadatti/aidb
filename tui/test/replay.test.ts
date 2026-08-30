import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canReplayCommand,
	clearLastReplay,
	replayLastCommand,
	setLastReplay,
	type ReplContext,
	type ReplIO,
} from "../src/repl.ts";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";
import type { Component } from "@earendil-works/pi-tui";

/** Fake context mirroring repl-win.test.ts; api stubs record calls. */
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
	// Record execution hooks (next/continue/...) so a replay's dispatch is
	// observable; state is "stopped" so the existing guards let them through.
	const calls: string[] = [];
	const step = (name: string) => async () => { calls.push(name); };
	const ctx: ReplContext = {
		getApi: () => ({
			...api,
			getState: () => "stopped",
			stepOver: step("stepOver"),
			stepInto: step("stepInto"),
			stepOut: step("stepOut"),
			continue: step("continue"),
			evaluate: async (expr: string) => `${expr}=42`,
			evaluateDetailed: async (expr: string) => ({ result: String(expr), variablesReference: 0 }),
			getVariableChildren: async () => [],
			readMemory: async () => ({ address: "0x0", data: new Uint8Array(0) }),
		}) as never,
		reset: async () => ({}) as never,
		requestExit: () => {},
		requestRender: () => {},
		io,
		windows,
	};
	return { ctx, messages, calls };
}

const lastMessage = (messages: ReturnType<typeof makeContext>["messages"]): string =>
	messages.at(-1)!.text;

describe("canReplayCommand — the dont_repeat table", () => {
	it("repeats the stepping cadence and its aliases", () => {
		for (const line of ["next", "next 3", "n", "step", "s", "stepi", "si", "finish", "f", "continue", "c"]) {
			assert.equal(canReplayCommand(line), true, line);
		}
	});

	it("repeats reads and deterministic re-evaluations", () => {
		for (const line of ["print x", "p x", "bt", "backtrace", "where", "info locals", "info registers",
			"x/4xw buf", "disassemble", "pwd", "set $i = 5", "break main", "break file.c:12 if x > 3",
			"delete 1", "help", "h win", "/status", "/settings", "/config reload", "/breaks", "/stack", "/locals",
		]) {
			assert.equal(canReplayCommand(line), true, line);
		}
	});

	it("repeats arbitrary gdb passthrough by default", () => {
		for (const line of ["thread apply all bt", "info threads", "show language", "set disassembly-flavor intel", "target remote :1234"]) {
			assert.equal(canReplayCommand(line), true, line);
		}
	});

	it("repeats bare finders, profile saves, and read-only /win / /watch forms", () => {
		for (const line of ["/session", "/session save foo", "/target", "/target save t",
			"/layout", "/layout save l", "/open", "> mem", ">",
		]) {
			assert.equal(canReplayCommand(line), true, line);
		}
		for (const line of ["/win list", "/watch list", "/watch"]) {
			assert.equal(canReplayCommand(line), true, line);
		}
	});

	it("blocks named profile switches (re-applying wipes live state)", () => {
		// The user case: `/layout quad` then Enter must not re-apply. Same
		// one-shot "switch to this profile" semantics for the others.
		for (const line of ["/session myproj", "/session switch myproj", "/target mytarget", "/target switch t",
			"/layout quad", "/layout switch quad", "/open memlayout",
		]) {
			assert.equal(canReplayCommand(line), false, line);
		}
	});

	it("blocks one-shot and destructive start verbs (gdb kills run too)", () => {
		for (const line of ["run", "run ./app a b", "r", "file", "file /tmp/app", "/run", "/launch", "attach 123", "/attach 123", "detach", "quit", "q", "/quit", "/new", "/new fresh"]) {
			assert.equal(canReplayCommand(line), false, line);
		}
	});

	it("blocks position-shifting /win mutations but not the listing", () => {
		for (const line of ["/win", "/win vsplit", "/win hsplit 0 mem", "/win close 1", "/win swap 0 1", "/win next", "/win switch mem", "/win load 0 regs", "/win pick 0 table", "/win bogus"]) {
			assert.equal(canReplayCommand(line), false, line);
		}
	});

	it("blocks /watch mutations (indices shift / adds duplicate) but not listings", () => {
		for (const line of ["/watch cycle", "/watch cycle 2", "/watch flag hex", "/watch del 1", "/watch foo", "/watch x + 2"]) {
			assert.equal(canReplayCommand(line), false, line);
		}
	});

	it("blocks gdb definition-mode denylist (would hang the DAP channel)", () => {
		for (const line of ["commands 1", "define foo", "document foo", "python print(1)", "guile", "while i < 3", "if x", "layout next", "layout src", "focus cmd", "refresh", "update", "tui enable"]) {
			assert.equal(canReplayCommand(line), false, line);
		}
	});
});

describe("empty-Enter replay dispatch", () => {
	it("replays a repeatable command with a typed-style echo", async () => {
		const { ctx, messages, calls } = makeContext();
		setLastReplay("next");
		await replayLastCommand(ctx);
		assert.deepEqual(calls, ["stepOver"]); // dispatched through the real path
		assert.equal(messages.at(-1)!.kind, "line");
		assert.match(messages.at(-1)!.text, /next/); // typed-style echo
	});

	it("refuses a blocked command with a one-line reason and no dispatch", async () => {
		const { ctx, messages, calls } = makeContext();
		setLastReplay("/win vsplit");
		await replayLastCommand(ctx);
		assert.deepEqual(calls, []);
		assert.equal(messages.at(-1)!.kind, "info");
		assert.match(lastMessage(messages), /not repeated: \/win vsplit/);
	});

	it("does nothing when the buffer is empty (fresh session)", async () => {
		const { ctx, messages } = makeContext();
		clearLastReplay();
		await replayLastCommand(ctx);
		assert.equal(messages.length, 0);
	});

	it("setLastReplay trims and rejects blank lines", async () => {
		const { ctx, messages } = makeContext();
		setLastReplay("  next  ");
		await replayLastCommand(ctx);
		assert.match(lastMessage(messages), /next/);
		setLastReplay("   ");
		clearLastReplay();
		await replayLastCommand(ctx);
		assert.equal(messages.at(-1)!.text, messages[0]!.text); // unchanged by the blank set
	});

	it("a blocked verb stays blocked even when it errors the first time (classification, not outcome)", async () => {
		const { ctx, messages } = makeContext();
		setLastReplay("run");
		await replayLastCommand(ctx);
		assert.equal(messages.at(-1)!.kind, "info");
		assert.match(lastMessage(messages), /not repeated: run/);
	});

	it("a repeatable command still dispatches to the api (state guards apply, not refusal)", async () => {
		const { ctx, messages, calls } = makeContext();
		setLastReplay("continue");
		await replayLastCommand(ctx);
		assert.deepEqual(calls, ["continue"]);
		assert.equal(messages.at(-1)!.kind, "line");
	});
});