/**
 * Basic tests for debugger-core package.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DebuggerEventBus } from "../src/event-bus.ts";
import { SessionStateMachine } from "../src/session.ts";
import { DapClient } from "../src/dap-client.ts";

function dapFrame(message: object): string {
	const body = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

describe("DapClient wire tracing", () => {
	it("records inbound and outbound frames within the configured ring buffer", async () => {
		const client = new DapClient(new DebuggerEventBus(), { traceDap: true, traceDapMaxEntries: 2 });
		const writes: string[] = [];
		(client as any).process = { stdin: { write: (message: string) => writes.push(message) } };

		const response = client.sendRequest("threads");
		(client as any).handleData(dapFrame({ seq: 2, type: "response", request_seq: 1, success: true, body: {} }));
		await response;
		const trace = client.getDapTrace();

		expect(writes).toHaveLength(1);
		expect(trace).toHaveLength(2);
		expect(trace.map((entry) => entry.direction)).toEqual(["out", "in"]);
		expect(trace[0].message.command).toBe("threads");
		expect(JSON.parse(client.dumpDapTrace().split("\n")[0])).toMatchObject({ direction: "out" });
	});

	it("does not retain frames when disabled", () => {
		const client = new DapClient(new DebuggerEventBus());
		(client as any).recordDapTrace("in", { seq: 1, type: "event", event: "output" });
		expect(client.getDapTrace()).toEqual([]);
	});

	it("rejects oversized frames and clears the parser buffer", () => {
		const bus = new DebuggerEventBus();
		const errors: Error[] = [];
		bus.on("session:error", ({ error }) => errors.push(error));
		const client = new DapClient(bus, { maxDapFrameSize: 16 });

		(client as any).handleData("Content-Length: 100\r\n\r\n");

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("exceeds 16 bytes");
		expect((client as any).buffer.length).toBe(0);
	});

	it("waits for stdin drain before completing a write", async () => {
		const client = new DapClient(new DebuggerEventBus());
		const stdin = new EventEmitter() as any;
		let writes = 0;
		stdin.write = () => {
			writes++;
			return false;
		};
		const process = { stdin };
		(client as any).process = process;

		const response = client.sendRequest("threads");
		await Promise.resolve();
		expect(writes).toBe(1);
		let settled = false;
		void response.then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		stdin.emit("drain");
		(client as any).handleData(dapFrame({ seq: 2, type: "response", request_seq: 1, success: true, body: {} }));
		await response;
	});
});

describe("DapClient shutdown", () => {
	function setupProcess(response: object, onKill: (signal: string) => void) {
		const client = new DapClient(new DebuggerEventBus());
		const child = new EventEmitter() as any;
		child.exitCode = null;
		child.signalCode = null;
		child.kill = (signal: string) => {
			onKill(signal);
			return true;
		};
		child.stdin = {
			write: () => queueMicrotask(() => (client as any).handleData(dapFrame(response))),
		};
		(client as any).process = child;
		return { client, child };
	}

	function addTempOutput(client: DapClient): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidb-test-"));
		(client as any).fifoDir = dir;
		(client as any).fifoFd = fs.openSync(path.join(dir, "out"), "w");
		return dir;
	}

	it("disconnects, waits for exit, and removes FIFO resources", async () => {
		const { client, child } = setupProcess(
			{ seq: 2, type: "response", request_seq: 1, success: true, body: {} },
			(signal) => {
				if (signal === "SIGTERM") {
					child.exitCode = 0;
					child.emit("exit", 0, null);
				}
			},
		);
		const dir = addTempOutput(client);

		await client.stop();

		expect(fs.existsSync(dir)).toBe(false);
		expect(client.getDapTrace()).toEqual([]);
	});

	it("escalates to SIGKILL when GDB ignores SIGTERM", async () => {
		const signals: string[] = [];
		const { client, child } = setupProcess(
			{ seq: 2, type: "response", request_seq: 1, success: true, body: {} },
			(signal) => {
				signals.push(signal);
				if (signal === "SIGKILL") {
					child.exitCode = 1;
					child.emit("exit", 1, null);
				}
			},
		);
		const dir = addTempOutput(client);

		await client.stop();

		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("is safe to call concurrently", async () => {
		const { client, child } = setupProcess(
			{ seq: 2, type: "response", request_seq: 1, success: true, body: {} },
			(signal) => {
				if (signal === "SIGTERM") {
					child.exitCode = 0;
					child.emit("exit", 0, null);
				}
			},
		);
		const first = client.stop();
		const second = client.stop();

		expect(first).toBe(second);
		await Promise.all([first, second]);
	});
});

describe("DebuggerEventBus", () => {
	it("should emit and receive events", () => {
		const bus = new DebuggerEventBus();
		const received: any[] = [];

		bus.on("session:running", (data) => {
			received.push(data);
		});

		bus.emit("session:running", { threadId: 1 });

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({ threadId: 1 });
	});

	it("should support multiple listeners", () => {
		const bus = new DebuggerEventBus();
		let count1 = 0;
		let count2 = 0;

		bus.on("session:stopped", () => { count1++; });
		bus.on("session:stopped", () => { count2++; });

		bus.emit("session:stopped", { reason: "breakpoint" });

		expect(count1).toBe(1);
		expect(count2).toBe(1);
	});

	it("should unsubscribe", () => {
		const bus = new DebuggerEventBus();
		let count = 0;

		const unsub = bus.on("session:running", () => { count++; });

		bus.emit("session:running", {});
		unsub();
		bus.emit("session:running", {});

		expect(count).toBe(1);
	});

	it("should clear all listeners", () => {
		const bus = new DebuggerEventBus();
		let count = 0;

		bus.on("session:running", () => { count++; });
		bus.clear();

		bus.emit("session:running", {});

		expect(count).toBe(0);
	});
});

describe("SessionStateMachine", () => {
	it("should start in not-started state", () => {
		const bus = new DebuggerEventBus();
		const sm = new SessionStateMachine(bus);

		expect(sm.getState()).toBe("not-started");
	});

	it("should transition from not-started to launching", () => {
		const bus = new DebuggerEventBus();
		const sm = new SessionStateMachine(bus);

		sm.transition("launching");
		expect(sm.getState()).toBe("launching");
	});

	it("should transition from launching to running", () => {
		const bus = new DebuggerEventBus();
		const sm = new SessionStateMachine(bus);

		sm.transition("launching");
		sm.transition("running", { threadId: 1 });

		expect(sm.getState()).toBe("running");
	});

	it("should throw on invalid transition", () => {
		const bus = new DebuggerEventBus();
		const sm = new SessionStateMachine(bus);

		expect(() => sm.transition("running")).toThrow("Invalid state transition");
	});

	it("should emit events on transitions", () => {
		const bus = new DebuggerEventBus();
		const sm = new SessionStateMachine(bus);
		const events: string[] = [];

		bus.on("session:running", () => events.push("running"));
		bus.on("session:stopped", () => events.push("stopped"));

		sm.transition("launching");
		sm.transition("running");
		sm.transition("stopped", { reason: "step" });

		expect(events).toEqual(["running", "stopped"]);
	});

	it("should check if transition is valid", () => {
		const bus = new DebuggerEventBus();
		const sm = new SessionStateMachine(bus);

		expect(sm.canTransition("launching")).toBe(true);
		expect(sm.canTransition("running")).toBe(false);
	});

	it("should reset to initial state", () => {
		const bus = new DebuggerEventBus();
		const sm = new SessionStateMachine(bus);

		sm.transition("launching");
		sm.transition("running");
		sm.reset();

		expect(sm.getState()).toBe("not-started");
	});
});
