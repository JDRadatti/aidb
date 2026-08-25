/** Stable error categories exposed by debugger-core. */
export type DebuggerErrorCode =
	| "dap-transport"
	| "dap-protocol"
	| "dap-request"
	| "dap-timeout"
	| "gdb-exited"
	| "session-state"
	| "capability-unsupported"
	| "frame-not-found"
	| "memory-read";

export class DebuggerError extends Error {
	readonly code: DebuggerErrorCode;
	readonly recoverable: boolean;

	constructor(code: DebuggerErrorCode, message: string, options: { recoverable?: boolean; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "DebuggerError";
		this.code = code;
		this.recoverable = options.recoverable ?? false;
	}
}

export class DapTransportError extends DebuggerError {
	constructor(message: string, cause?: unknown) {
		super("dap-transport", message, { recoverable: true, cause });
		this.name = "DapTransportError";
	}
}

export class DapProtocolError extends DebuggerError {
	constructor(message: string) {
		super("dap-protocol", message);
		this.name = "DapProtocolError";
	}
}

export class DapRequestError extends DebuggerError {
	readonly command: string;

	constructor(command: string, message: string) {
		super("dap-request", `DAP request "${command}" failed: ${message}`, { recoverable: true });
		this.name = "DapRequestError";
		this.command = command;
	}
}

export class DapTimeoutError extends DebuggerError {
	readonly command: string;
	readonly timeoutMs: number;

	constructor(command: string, timeoutMs: number) {
		super("dap-timeout", `DAP request "${command}" timed out after ${timeoutMs}ms`, { recoverable: true });
		this.name = "DapTimeoutError";
		this.command = command;
		this.timeoutMs = timeoutMs;
	}
}

export class GdbExitedError extends DebuggerError {
	constructor() {
		super("gdb-exited", "GDB exited", { recoverable: true });
		this.name = "GdbExitedError";
	}
}

export class SessionStateError extends DebuggerError {
	constructor(message: string) {
		super("session-state", message, { recoverable: true });
		this.name = "SessionStateError";
	}
}

export class CapabilityUnsupportedError extends DebuggerError {
	constructor(capability: string) {
		super("capability-unsupported", `This gdb DAP adapter does not advertise ${capability} support.`, { recoverable: true });
		this.name = "CapabilityUnsupportedError";
	}
}

export class FrameNotFoundError extends DebuggerError {
	constructor(frameId: number, count: number) {
		super("frame-not-found", `No frame ${frameId} in the current stack (${count} frames).`, { recoverable: true });
		this.name = "FrameNotFoundError";
	}
}

export class MemoryReadError extends DebuggerError {
	constructor(count: number, expression: string) {
		super("memory-read", `Could not read ${count} bytes at '${expression}'.`, { recoverable: true });
		this.name = "MemoryReadError";
	}
}
