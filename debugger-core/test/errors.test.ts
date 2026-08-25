import { describe, expect, it } from "vitest";
import { DapClient } from "../src/dap-client.ts";
import { DebuggerEventBus } from "../src/event-bus.ts";
import { SessionStateMachine } from "../src/session.ts";
import {
	CapabilityUnsupportedError,
	DapProtocolError,
	DapRequestError,
	DapTimeoutError,
	DapTransportError,
	DebuggerError,
	SessionStateError,
} from "../src/errors.ts";

function frame(message: object): string {
	const body = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

describe("typed debugger errors", () => {
	it("retains stable codes and Error compatibility", () => {
		const error = new DapTimeoutError("stackTrace", 1000);

		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(DebuggerError);
		expect(error.code).toBe("dap-timeout");
		expect(error.recoverable).toBe(true);
		expect(error.command).toBe("stackTrace");
	});

	it("types DAP request failures with the original command", async () => {
		const client = new DapClient(new DebuggerEventBus());
		const writes: string[] = [];
		(client as any).process = { stdin: { write: (message: string) => writes.push(message) } };
		const pending = client.sendRequest("evaluate", { expression: "bad" });
		(client as any).handleData(frame({ seq: 2, type: "response", request_seq: 1, success: false, message: "unknown symbol" }));

		await expect(pending).rejects.toMatchObject({
			name: "DapRequestError",
			code: "dap-request",
			command: "evaluate",
		});
		expect(writes).toHaveLength(1);
	});

	it("emits protocol errors as typed errors", () => {
		const errors: Error[] = [];
		const bus = new DebuggerEventBus();
		bus.on("session:error", ({ error }) => errors.push(error));
		const client = new DapClient(bus);

		(client as any).handleData(Buffer.from("not a DAP frame\r\n\r\n"));

		expect(errors[0]).toBeInstanceOf(DapProtocolError);
		expect(errors[0].code).toBe("dap-protocol");
	});

	it("types invalid state and unsupported capability errors", () => {
		const machine = new SessionStateMachine(new DebuggerEventBus());

		expect(() => machine.transition("stopped")).toThrow(SessionStateError);
		expect(new CapabilityUnsupportedError("disassemble").code).toBe("capability-unsupported");
		expect(new DapTransportError("offline").recoverable).toBe(true);
		expect(new DapRequestError("continue", "busy").message).toContain("continue");
	});
});
