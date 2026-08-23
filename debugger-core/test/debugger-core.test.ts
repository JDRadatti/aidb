/**
 * Basic tests for debugger-core package.
 */

import { describe, it, expect } from "vitest";
import { DebuggerEventBus } from "../src/event-bus.ts";
import { SessionStateMachine } from "../src/session.ts";

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
