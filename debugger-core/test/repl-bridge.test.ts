/**
 * Tests for repl-bridge: lifecycle handshake, stop-location tracking,
 * and active-thread management. Uses a fake DapClient (no GDB required).
 */

import { describe, it, expect } from "vitest";
import { DebuggerEventBus } from "../src/event-bus.ts";
import { SessionStateMachine } from "../src/session.ts";
import { createDebuggerAPI } from "../src/repl-bridge.ts";
import type { DebuggerAPI } from "../src/types.ts";

class FakeDapClient {
	requests: Array<{ command: string; args?: any }> = [];
	private responders = new Map<string, (args?: any) => any>();

	onRequest(command: string, responder: (args?: any) => any) {
		this.responders.set(command, responder);
	}

	async start() {}

	sendRequest(command: string, args?: any): Promise<any> {
		this.requests.push({ command, args });
		const responder = this.responders.get(command);
		return Promise.resolve(responder ? responder(args) : {});
	}

	lastCommand(): string | undefined {
		return this.requests.at(-1)?.command;
	}
}

function flushAsync() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Mirror how dap-client emits stops: raw event + session event. */
function emitStop(bus: DebuggerEventBus, data: { reason: string; threadId?: number; source?: string; line?: number }) {
	bus.emit("stopped", data);
	bus.emit("session:stopped", { ...data });
}

interface Setup {
	api: DebuggerAPI;
	bus: DebuggerEventBus;
	fake: FakeDapClient;
}

function setup(): Setup {
	const bus = new DebuggerEventBus();
	const fake = new FakeDapClient();
	fake.onRequest("stackTrace", () => ({
		stackFrames: [
			{ id: 7, name: "main", source: { path: "/tmp/main.c" }, line: 12, column: 1 },
		],
	}));
	fake.onRequest("setBreakpoints", (args) => ({
		breakpoints: (args?.breakpoints ?? []).map((bp: any, i: number) => ({
			id: i + 1,
			verified: true,
			line: bp.line,
		})),
	}));
	const stateMachine = new SessionStateMachine(bus);
	const api = createDebuggerAPI(fake as any, bus, stateMachine);
	return { api, bus, fake };
}

describe("repl-bridge lifecycle", () => {
	it("sends configurationDone after launch", async () => {
		const { api, fake } = setup();

		await api.launch("./app");

		const commands = fake.requests.map((r) => r.command);
		expect(commands).toEqual(["launch", "configurationDone"]);
	});

	it("sends configurationDone after attach", async () => {
		const { api, fake } = setup();

		await api.attach(1234);

		const commands = fake.requests.map((r) => r.command);
		expect(commands).toEqual(["attach", "configurationDone"]);
	});
});

describe("stop-location tracking", () => {
	it("updates sourceFile/currentLine from stackTrace after a stop", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");

		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		expect(api.sourceFile).toBe("/tmp/main.c");
		expect(api.currentLine).toBe(12);
		const trace = fake.requests.find((r) => r.command === "stackTrace");
		expect(trace?.args).toEqual({ threadId: 5 });
	});

	it("prefers location carried by the stopped event itself", async () => {
		const { api, bus } = setup();
		await api.launch("./app");

		emitStop(bus, { reason: "step", threadId: 2, source: "/tmp/other.c", line: 42 });
		await flushAsync();

		expect(api.sourceFile).toBe("/tmp/other.c");
		expect(api.currentLine).toBe(42);
	});

	it("clears tracked location when the target exits", async () => {
		const { api, bus } = setup();

		bus.emit("stopped", { reason: "breakpoint", threadId: 1 });
		await flushAsync();
		bus.emit("session:exited", { exitCode: 0 });

		expect(api.sourceFile).toBeNull();
		expect(api.currentLine).toBe(0);
	});

	it("emits location events once the stack is resolved", async () => {
		const { api, bus, fake } = setup();
		const locations: Array<{ file: string | null; line: number }> = [];
		api.on("location", (loc) => locations.push(loc));
		await api.launch("./app");

		emitStop(bus, { reason: "breakpoint", threadId: 5, source: "/tmp/direct.c", line: 3 });
		await flushAsync();
		emitStop(bus, { reason: "step", threadId: 5 });
		await flushAsync();

		expect(locations[0]).toEqual({ file: "/tmp/direct.c", line: 3 });
		expect(locations.at(-1)).toEqual({ file: "/tmp/main.c", line: 12 });
		expect(fake.requests.filter((r) => r.command === "stackTrace")).toHaveLength(1);
	});
});

describe("active thread tracking", () => {
	it("routes continue to the thread from the last stop event", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");

		emitStop(bus, { reason: "breakpoint", threadId: 9 });
		await flushAsync();
		await api.continue();

		const cont = fake.requests.find((r) => r.command === "continue");
		expect(cont?.args).toEqual({ threadId: 9 });
	});

	it("routes steps to the thread from the last continued event", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");

		emitStop(bus, { reason: "breakpoint", threadId: 4 });
		bus.emit("continued", { threadId: 6 });
		await flushAsync();

		await api.stepOver();

		const next = fake.requests.find((r) => r.command === "next");
		expect(next?.args).toEqual({ threadId: 6 });
	});

	it("exposes activeThreadId on the API", async () => {
		const { api, bus } = setup();
		await api.launch("./app");

		expect(api.activeThreadId).toBe(1);

		emitStop(bus, { reason: "breakpoint", threadId: 3 });
		await flushAsync();

		expect(api.activeThreadId).toBe(3);
	});
});

describe("lifecycle relaunch", () => {
	it("allows relaunching after the target exited", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");
		bus.emit("session:exited", { exitCode: 0 });

		await api.launch("./app");

		expect(fake.requests.filter((r) => r.command === "launch")).toHaveLength(2);
	});

	it("clears tracked location on relaunch", async () => {
		const { api, bus } = setup();
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 1 });
		await flushAsync();
		bus.emit("session:exited", { exitCode: 0 });

		await api.launch("./app");

		expect(api.sourceFile).toBeNull();
		expect(api.currentLine).toBe(0);
	});
});

describe("breakpoint management", () => {
	it("sends the full per-file list so earlier breakpoints survive", async () => {
		const { api, fake } = setup();
		await api.launch("./app");

		await api.setBreakpoint("/tmp/main.c", 12);
		await api.setBreakpoint("/tmp/main.c", 20);

		const calls = fake.requests.filter((r) => r.command === "setBreakpoints");
		expect(calls[0].args.breakpoints).toEqual([{ line: 12, condition: undefined }]);
		expect(calls[1].args.breakpoints).toEqual([
			{ line: 12, condition: undefined },
			{ line: 20, condition: undefined },
		]);
		const lines = (await api.listBreakpoints()).map((bp) => bp.line);
		expect(lines).toEqual([12, 20]);
	});

	it("removes one breakpoint without dropping the others in the file", async () => {
		const { api, fake } = setup();
		await api.launch("./app");

		const first = await api.setBreakpoint("/tmp/main.c", 12);
		await api.setBreakpoint("/tmp/main.c", 20);
		await api.removeBreakpoint(first.id);

		const lastCall = fake.requests.filter((r) => r.command === "setBreakpoints").at(-1);
		expect(lastCall?.args.breakpoints).toEqual([{ line: 20, condition: undefined }]);
		const lines = (await api.listBreakpoints()).map((bp) => bp.line);
		expect(lines).toEqual([20]);
	});
});

describe("evaluate passthrough", () => {
	it("defaults to watch context with the top frame while stopped", async () => {
		const { api, bus, fake } = setup();
		fake.onRequest("evaluate", () => ({ result: "$1 = 42" }));
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		const result = await api.evaluate("print x");

		expect(result).toBe("$1 = 42");
		const evalReq = fake.requests.find((r) => r.command === "evaluate");
		expect(evalReq?.args.context).toBe("watch");
		expect(evalReq?.args.frameId).toBe(7);
	});

	it("omits the frame when the target is not stopped", async () => {
		const { api, fake } = setup();
		fake.onRequest("evaluate", () => ({ result: "done" }));
		await api.launch("./app");

		await api.evaluate("print x", "repl");

		expect(fake.requests.some((r) => r.command === "stackTrace")).toBe(false);
		const evalReq = fake.requests.find((r) => r.command === "evaluate");
		expect(evalReq?.args.frameId).toBeUndefined();
	});

	it("allows an explicit repl context for raw GDB commands", async () => {
		const { api, fake } = setup();
		fake.onRequest("evaluate", () => ({ result: "done" }));

		await api.evaluate("-exec-run", "repl");

		const evalReq = fake.requests.find((r) => r.command === "evaluate");
		expect(evalReq?.args.context).toBe("repl");
	});
});

describe("stack resilience", () => {
	it("returns an empty stack instead of leaking DAP errors", async () => {
		const { api, fake } = setup();
		fake.onRequest("stackTrace", () => {
			throw new Error("'NoneType' object has no attribute 'global_num'");
		});

		expect(await api.getStack()).toEqual([]);
		expect(await api.getVariables()).toEqual([]);
	});
});
