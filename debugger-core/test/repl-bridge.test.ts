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
	capabilities: Record<string, any> = {};

	onRequest(command: string, responder: (args?: any) => any) {
		this.responders.set(command, responder);
	}

	async start() {}

	async prepareInferiorIo() {}

	getCapabilities() {
		return this.capabilities;
	}

	sendRequest(command: string, args?: any): Promise<any> {
		this.requests.push({ command, args });
		const responder = this.responders.get(command);
		return Promise.resolve(responder ? responder(args) : {});
	}

	lastCommand(): string | undefined {
		return this.requests.at(-1)?.command;
	}

	count(command: string): number {
		return this.requests.filter((r) => r.command === command).length;
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

	it("rolls back launching when launch fails", async () => {
		const { api, fake } = setup();
		fake.onRequest("launch", async () => { throw new Error("launch failed"); });

		await expect(api.launch("./app")).rejects.toThrow("launch failed");
		expect(api.getState()).toBe("not-started");
	});

	it("restarts GDB and rebinds breakpoints after an unexpected exit", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app", ["--demo"]);
		await api.setBreakpoint("/tmp/main.c", 12);

		bus.emit("gdb:exited", { exitCode: 1 });
		await flushAsync();

		expect(fake.count("launch")).toBe(2);
		expect(fake.count("configurationDone")).toBe(2);
		expect(fake.count("setBreakpoints")).toBe(2);
		expect(fake.requests.at(-1)?.command).toBe("configurationDone");
	});

	it("reports recovery failure without throwing from the exit handler", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");
		const errors: Error[] = [];
		api.on("session:error", ({ error }) => errors.push(error));
		(fake as any).start = async () => { throw new Error("restart failed"); };

		bus.emit("gdb:exited", { exitCode: 1 });
		await flushAsync();

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe("restart failed");
		expect(api.getState()).toBe("error");
	});

	it("matches breakpoint responses by line when an adapter omits one", async () => {
		const { api, fake } = setup();
		await api.launch("./app");
		await api.setBreakpoint("/tmp/main.c", 10);
		await api.setBreakpoint("/tmp/main.c", 20);
		await api.setBreakpoint("/tmp/main.c", 30);
		fake.onRequest("setBreakpoints", () => ({
			breakpoints: [
				{ id: 101, line: 10, verified: true },
				{ id: 103, line: 30, verified: true },
			],
		}));

		await api.setBreakpoint("/tmp/main.c", 10, "x > 0");

		expect([...api.breakpoints.values()].map((bp) => bp.line)).toEqual([10, 30]);
		expect(api.breakpoints.get(101)?.condition).toBe("x > 0");
		expect(api.breakpoints.get(103)?.condition).toBeUndefined();
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

	it("discards a delayed stack location from an older stop", async () => {
		const { api, bus, fake } = setup();
		let resolveOld!: (value: any) => void;
		let stackCalls = 0;
		fake.onRequest("stackTrace", () => {
			stackCalls++;
			if (stackCalls === 1) return new Promise((resolve) => { resolveOld = resolve; });
			return { stackFrames: [{ id: 8, name: "next", source: { path: "/tmp/next.c" }, line: 20 }] };
		});

		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		emitStop(bus, { reason: "step", threadId: 5, source: "/tmp/next.c", line: 20 });
		resolveOld({ stackFrames: [{ id: 7, name: "main", source: { path: "/tmp/old.c" }, line: 12 }] });
		await flushAsync();

		expect(api.sourceFile).toBe("/tmp/next.c");
		expect(api.currentLine).toBe(20);
	});
});

describe("active thread tracking", () => {
	it("rolls back to stopped when continue fails", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 1 });
		fake.onRequest("continue", async () => { throw new Error("continue failed"); });

		await expect(api.continue()).rejects.toThrow("continue failed");
		expect(api.getState()).toBe("stopped");
	});

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

	it("does not duplicate a breakpoint when the same location is set twice", async () => {
		const { api, fake } = setup();
		await api.launch("./app");

		await api.setBreakpoint("/tmp/main.c", 12);
		const again = await api.setBreakpoint("/tmp/main.c", 12);

		expect(again.line).toBe(12);
		expect(fake.requests.filter((r) => r.command === "setBreakpoints")).toHaveLength(1);
		expect(await api.listBreakpoints()).toHaveLength(1);
	});

	it("updates the condition when the same line is re-broken with one", async () => {
		const { api, fake } = setup();
		await api.launch("./app");

		await api.setBreakpoint("/tmp/main.c", 12);
		const updated = await api.setBreakpoint("/tmp/main.c", 12, "i > 3");

		const lastCall = fake.requests.filter((r) => r.command === "setBreakpoints").at(-1);
		expect(lastCall?.args.breakpoints).toEqual([{ line: 12, condition: "i > 3" }]);
		expect(updated.condition).toBe("i > 3");
		expect(await api.listBreakpoints()).toHaveLength(1);
	});

	it("tracks breakpoints created through raw GDB and deletes them via console", async () => {
		const { api, fake } = setup();
		fake.onRequest("evaluate", () => ({ result: "Breakpoint 2 at 0x401136" }));
		await api.launch("./app");

		const tracked = api.trackExternalBreakpoint(2, "main", "/tmp/main.c", 12);
		expect(tracked.location).toBe("main");
		expect(tracked.file).toBe("/tmp/main.c");
		expect(tracked.line).toBe(12);
		expect((await api.listBreakpoints()).map((bp) => bp.id)).toContain(2);

		await api.removeBreakpoint(2);

		const del = fake.requests.filter((r) => r.command === "evaluate").at(-1);
		expect(del?.args.expression).toBe("delete 2");
		expect(fake.requests.some((r) => r.command === "setBreakpoints" && r.args.breakpoints.length === 0)).toBe(false);
		expect(await api.listBreakpoints()).toHaveLength(0);
	});

	it("applies a breakpoint event that arrives before external tracking", () => {
		const { api, bus } = setup();
		bus.emit("breakpoint", { id: 4, verified: true, file: "/tmp/main.c", line: 12 });

		const tracked = api.trackExternalBreakpoint(4, "main");

		expect(tracked.file).toBe("/tmp/main.c");
		expect(tracked.line).toBe(12);
	});

	it("emits breakpoints-changed after every mutation", async () => {
		const { api } = setup();
		let changes = 0;
		api.on("breakpoints-changed", () => changes++);

		await api.launch("./app");
		const bp = await api.setBreakpoint("/tmp/main.c", 12);
		api.trackExternalBreakpoint(9, "helper");
		await api.removeBreakpoint(bp.id);

		expect(changes).toBe(3);
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

describe("frame selection", () => {
	function twoFrameSetup() {
		const s = setup();
		s.fake.onRequest("stackTrace", () => ({
			stackFrames: [
				{ id: 7, name: "main", source: { path: "/tmp/main.c" }, line: 12, column: 1 },
				{ id: 9, name: "helper", source: { path: "/tmp/helper.c" }, line: 3, column: 5 },
			],
		}));
		return s;
	}

	it("pins evaluate to the selected frame", async () => {
		const { api, bus, fake } = twoFrameSetup();
		fake.onRequest("evaluate", () => ({ result: "$1 = 1" }));
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		await api.selectFrame(9);
		await api.evaluate("print x");

		const evalReq = fake.requests.find((r) => r.command === "evaluate");
		expect(evalReq?.args.frameId).toBe(9);
	});

	it("rejects unknown frame ids", async () => {
		const { api, bus } = twoFrameSetup();
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		await expect(api.selectFrame(99)).rejects.toThrow(/No frame 99/);
	});

	it("resets to the top frame after a new stop", async () => {
		const { api, bus, fake } = twoFrameSetup();
		fake.onRequest("evaluate", () => ({ result: "$1 = 1" }));
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();
		await api.selectFrame(9);
		emitStop(bus, { reason: "step", threadId: 5 });
		await flushAsync();

		expect(api.selectedFrame()).toBeNull();
		await api.evaluate("print x");

		const lastEval = fake.requests.filter((r) => r.command === "evaluate").at(-1);
		expect(lastEval?.args.frameId).toBe(7);
	});

	it("selectedFrame reflects the choice and follows location tracking", async () => {
		const { api, bus } = twoFrameSetup();
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		await api.selectFrame(9);

		const frame = api.selectedFrame();
		expect(frame?.id).toBe(9);
		expect(frame?.name).toBe("helper");
	});
});

describe("per-stop caches", () => {
	it("coalesces repeated getStack calls within one stop", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		await api.getStack();
		await api.getStack();

		// One from the stop's own location refresh + one explicit fetch.
		expect(fake.count("stackTrace")).toBe(2);
	});

	it("refetches the stack after the next stop", async () => {
		const { api, bus, fake } = setup();
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();
		await api.getStack();
		const before = fake.count("stackTrace");

		emitStop(bus, { reason: "step", threadId: 5 });
		await flushAsync();
		await api.getStack();

		expect(fake.count("stackTrace")).toBeGreaterThan(before);
	});

	it("coalesces scopes and variables per reference within one stop", async () => {
		const { api, bus, fake } = setup();
		fake.onRequest("scopes", () => ({
			scopes: [{ name: "Locals", presentationHint: "locals", variablesReference: 42 }],
		}));
		fake.onRequest("variables", () => ({
			variables: [{ name: "x", value: "1", type: "int", variablesReference: 0 }],
		}));
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		await api.getVariables();
		await api.getVariables();

		expect(fake.count("scopes")).toBe(1);
		expect(fake.count("variables")).toBe(1);
	});
});

describe("variable children", () => {
	it("passes paging args through to DAP variables", async () => {
		const { api, fake } = setup();
		await api.launch("./app");

		await api.getVariableChildren(42, 4, 10);

		const req = fake.requests.at(-1)!;
		expect(req.command).toBe("variables");
		expect(req.args).toMatchObject({ variablesReference: 42, start: 4, count: 10 });
	});

	it("caches children per variablesReference within a stop", async () => {
		const { api, fake } = setup();
		fake.onRequest("variables", () => ({
			variables: [
				{
					name: "pos",
					value: "{...}",
					type: "Vec2",
					variablesReference: 43,
					namedVariables: 2,
					memoryReference: "0x55f1b0",
					evaluateName: "player.pos",
				},
			],
		}));
		await api.launch("./app");

		const first = await api.getVariableChildren(42);
		const second = await api.getVariableChildren(42);

		expect(fake.count("variables")).toBe(1);
		expect(second).toBe(first);
		expect(first[0]).toMatchObject({
			name: "pos",
			type: "Vec2",
			namedVariables: 2,
			memoryReference: "0x55f1b0",
			evaluateName: "player.pos",
		});
	});
});

describe("evaluateDetailed", () => {
	it("keeps variablesReference/memoryReference/type metadata", async () => {
		const { api, bus, fake } = setup();
		fake.onRequest("evaluate", () => ({
			result: "{hp: 100}",
			type: "Player",
			variablesReference: 77,
			namedVariables: 3,
			memoryReference: "0x55f1a0",
		}));
		await api.launch("./app");
		emitStop(bus, { reason: "breakpoint", threadId: 5 });
		await flushAsync();

		const info = await api.evaluateDetailed("player");

		expect(info).toMatchObject({
			result: "{hp: 100}",
			type: "Player",
			variablesReference: 77,
			namedVariables: 3,
			memoryReference: "0x55f1a0",
		});
		const evalReq = fake.requests.find((r) => r.command === "evaluate");
		expect(evalReq?.args.context).toBe("watch");
	});
});

describe("readMemory", () => {
	const bytes64ff = Buffer.from([0x64, 0x00, 0xff]).toString("base64");

	it("can use an evaluated value's memoryReference for a raw read", async () => {
		const { api, fake } = setup();
		fake.capabilities.supportsReadMemoryRequest = true;
		fake.onRequest("evaluate", () => ({
			result: "{r = 100, g = 150, b = 200}",
			type: "struct Pixel",
			variablesReference: 12,
			memoryReference: "0x601040",
		}));
		fake.onRequest("readMemory", (args) => ({
			address: args?.memoryReference,
			data: Buffer.from([100, 150, 200]).toString("base64"),
		}));
		await api.launch("./app");

		const info = await api.evaluateDetailed("frame[0]");
		const read = await api.readMemory(info.memoryReference!, 3);

		expect(info.type).toBe("struct Pixel");
		expect(info.memoryReference).toBe("0x601040");
		expect(read.address).toBe("0x601040");
		expect(Array.from(read.data)).toEqual([100, 150, 200]);
		expect(fake.requests.find((request) => request.command === "readMemory")?.args).toMatchObject({
			memoryReference: "0x601040",
			count: 3,
		});
	});

	it("uses DAP readMemory and decodes base64 when supported", async () => {
		const { api, fake } = setup();
		fake.capabilities.supportsReadMemoryRequest = true;
		fake.onRequest("readMemory", () => ({ address: "0x55f1a0", data: bytes64ff }));
		await api.launch("./app");

		const read = await api.readMemory("&player", 3);

		const req = fake.requests.find((r) => r.command === "readMemory");
		expect(req?.args).toMatchObject({ memoryReference: "&player", count: 3 });
		expect(read.address).toBe("0x55f1a0");
		expect(Array.from(read.data)).toEqual([0x64, 0x00, 0xff]);
	});

	it("falls back to x/Nxb console output without capability", async () => {
		const { api, fake } = setup();
		fake.onRequest("evaluate", () => ({
			result: "0x55f1a0 <player>:\t0x64\t0x00\n\t0xff",
		}));
		await api.launch("./app");

		const read = await api.readMemory("&player", 3);

		const req = fake.requests.find((r) => r.command === "evaluate");
		expect(req?.args.expression).toContain("x/3xb &player");
		expect(read.address).toBe("0x55f1a0");
		expect(Array.from(read.data)).toEqual([0x64, 0x00, 0xff]);
	});

	it("falls back when readMemory errors despite capability", async () => {
		const { api, fake } = setup();
		fake.capabilities.supportsReadMemoryRequest = true;
		fake.onRequest("readMemory", () => {
			throw new Error("Cannot access memory address 0x0");
		});
		fake.onRequest("evaluate", () => ({ result: "0x10 <buf>:\t0x41\t0x42" }));
		await api.launch("./app");

		const read = await api.readMemory("buf", 2);

		expect(Array.from(read.data)).toEqual([0x41, 0x42]);
	});

	it("rejects only when both paths fail", async () => {
		const { api, fake } = setup();
		fake.onRequest("evaluate", () => ({ result: "No symbol \"zzz\" in current context." }));
		await api.launch("./app");

		await expect(api.readMemory("zzz", 16)).rejects.toThrow(/Could not read 16 bytes/);
	});
});

describe("threads and disassemble", () => {
	it("lists threads", async () => {
		const { api, fake } = setup();
		fake.onRequest("threads", () => ({
			threads: [{ id: 1, name: "main" }, { id: 5 }],
		}));

		const threads = await api.listThreads();

		expect(threads).toEqual([{ id: 1, name: "main" }, { id: 5, name: undefined }]);
	});

	it("refuses disassemble without adapter capability", async () => {
		const { api } = setup();

		await expect(api.disassemble("*main", 20)).rejects.toThrow(/disassemble support/);
	});

	it("maps disassemble instructions when supported", async () => {
		const { api, fake } = setup();
		fake.capabilities.supportsDisassembleRequest = true;
		fake.onRequest("disassemble", () => ({
			instructions: [
				{ address: "0x401136", symbol: "main", instructionBytes: "55", instruction: "push rbp", location: { line: 12 } },
				{ address: "0x401137", instructionBytes: "4889e5", instruction: "mov rbp,rsp" },
			],
		}));

		const insns = await api.disassemble("*main", 2);

		const req = fake.requests.at(-1)!;
		expect(req.args.instructionCount).toBe(2);
		expect(insns[0]).toMatchObject({ address: "0x401136", symbol: "main", instruction: "push rbp", line: 12 });
	});
});
