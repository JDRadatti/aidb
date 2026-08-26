import { afterEach, describe, expect, it, vi } from "vitest";
import { DapClient } from "../src/dap-client.ts";
import { DebuggerEventBus } from "../src/event-bus.ts";

function event(client: DapClient, name: string, body: object = {}): void {
	(client as any).handleEvent({ seq: 1, type: "event", event: name, body });
}

describe("DapClient exit and relaunch races", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("cancels an exec-boundary exit when a stop arrives before the debounce", async () => {
		vi.useFakeTimers();
		const bus = new DebuggerEventBus();
		const exits: unknown[] = [];
		bus.on("session:exited", (data) => exits.push(data));
		const client = new DapClient(bus);

		event(client, "exited", { exitCode: 1 });
		await vi.advanceTimersByTimeAsync(119);
		event(client, "stopped", { reason: "breakpoint", threadId: 1 });
		await vi.advanceTimersByTimeAsync(1);

		expect(exits).toHaveLength(0);
	});

	it("reports a real exit after the debounce window", async () => {
		vi.useFakeTimers();
		const bus = new DebuggerEventBus();
		const exits: Array<{ exitCode: number }> = [];
		bus.on("session:exited", (data) => exits.push(data));
		const client = new DapClient(bus);

		event(client, "terminated");
		await vi.advanceTimersByTimeAsync(119);
		expect(exits).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);

		expect(exits).toEqual([{ exitCode: 0 }]);
	});

	it("ignores stale exit events while a relaunch is starting", async () => {
		vi.useFakeTimers();
		const bus = new DebuggerEventBus();
		const exits: unknown[] = [];
		bus.on("session:exited", (data) => exits.push(data));
		const client = new DapClient(bus);
		(client as any).startingRun = true;

		event(client, "terminated");
		await vi.advanceTimersByTimeAsync(500);

		expect(exits).toHaveLength(0);
	});

	it("suppresses duplicate process events for the same pid", () => {
		const bus = new DebuggerEventBus();
		const processes: unknown[] = [];
		bus.on("process", (data) => processes.push(data));
		const client = new DapClient(bus);

		event(client, "process", { name: "app", systemProcessId: 42 });
		event(client, "process", { name: "app", systemProcessId: 42 });
		event(client, "process", { name: "app", systemProcessId: 43 });

		expect(processes).toHaveLength(2);
		expect((processes[1] as any).systemProcessId).toBe(43);
	});
});
