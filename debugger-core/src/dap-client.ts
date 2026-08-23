/**
 * DAP (Debug Adapter Protocol) client for communicating with GDB.
 * Spawns gdb --interpreter=dap and communicates over stdio.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { DebuggerEventBus } from "./event-bus.ts";
import type { DapClientConfig } from "./types.ts";

/**
 * DAP message with sequence number.
 */
interface DapMessage {
	seq: number;
	type: "request" | "response" | "event";
	command?: string;
	arguments?: any;
	success?: boolean;
	message?: string;
	body?: any;
	event?: string;
	request_seq?: number;
}

/**
 * Pending request waiting for response.
 */
interface PendingRequest {
	resolve: (result: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * DAP client that communicates with GDB via stdio.
 */
export class DapClient {
	private process: ChildProcess | null = null;
	private seq = 0;
	private pending = new Map<number, PendingRequest>();
	private buffer = "";
	private eventBus: DebuggerEventBus;
	private config: DapClientConfig;
	private requestTimeout = 10_000;
	private capabilities: any = null;
	private exitReported = false;

	/**
	 * Emit session:exited exactly once per GDB lifecycle.
	 * GDB sends both "exited" and "terminated" DAP events on target exit,
	 * and the process close handler fires again on shutdown.
	 */
	private reportExit(exitCode: number): void {
		if (this.exitReported) return;
		this.exitReported = true;
		this.eventBus.emit("session:exited", { exitCode });
	}

	constructor(eventBus: DebuggerEventBus, config: DapClientConfig = {}) {
		this.eventBus = eventBus;
		this.config = config;
	}

	/**
	 * Start GDB with DAP interpreter.
	 */
	async start(): Promise<void> {
		const gdbPath = this.config.gdbPath ?? "gdb";
		const args = ["--interpreter=dap", "--nx", "--quiet"];
		this.exitReported = false;

		this.process = spawn(gdbPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...this.config.env },
			cwd: this.config.cwd,
		});

		this.process.on("error", (error) => {
			console.error("GDB process error:", error);
			this.rejectAllPending(error);
		});

		this.process.on("exit", (code) => {
			this.reportExit(code ?? 0);
			this.rejectAllPending(new Error("GDB exited"));
		});

		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => {
				this.handleData(data.toString());
			});
		}

		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => {
				this.eventBus.emit("output", { category: "stderr", output: data.toString() });
			});
		}

		await this.sendRequest("initialize", {
			adapterID: "pi-debugger",
			clientID: "pi-debugger-core",
			clientName: "Pi Debugger",
			locale: "en-us",
			linesStartAt1: true,
			columnsStartAt1: true,
			supportsVariableType: true,
			supportsVariablePaging: false,
			supportsRunInTerminalRequest: false,
		}).then((body) => {
			this.capabilities = body ?? {};
		});
	}

	/**
	 * Capabilities returned by the adapter's initialize response.
	 */
	getCapabilities(): any {
		return this.capabilities;
	}

	/**
	 * Handle raw data from GDB stdout.
	 */
	private handleData(data: string): void {
		this.buffer += data;

		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const header = this.buffer.slice(0, headerEnd);
			const match = header.match(/Content-Length: (\d+)/);
			if (!match) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const contentLength = parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + contentLength;

			if (this.buffer.length < bodyEnd) break;

			const body = this.buffer.slice(bodyStart, bodyEnd);
			this.buffer = this.buffer.slice(bodyEnd);

			try {
				const message = JSON.parse(body) as DapMessage;
				this.handleMessage(message);
			} catch (error) {
				console.error("Failed to parse DAP message:", error);
			}
		}
	}

	/**
	 * Handle a parsed DAP message.
	 */
	private handleMessage(message: DapMessage): void {
		if (message.type === "response") {
			const requestId = message.request_seq ?? message.seq!;
			const pending = this.pending.get(requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(requestId);
				if (message.success ?? true) {
					pending.resolve(message.body);
				} else {
					pending.reject(new Error(message.message ?? "Request failed"));
				}
			}
		} else if (message.type === "event") {
			this.handleEvent(message);
		}
	}

	/**
	 * Handle a DAP event from GDB.
	 */
	private handleEvent(message: DapMessage): void {
		const event = message.event!;
		const body = message.body ?? {};

		switch (event) {
			case "stopped": {
				const stopData = {
					reason: body.reason ?? "unknown",
					threadId: body.threadId,
					source: body.source?.path,
					line: body.line,
					column: body.column,
				};
				this.eventBus.emit("stopped", stopData);
				this.eventBus.emit("session:stopped", stopData);
				break;
			}

			case "continued":
				this.eventBus.emit("continued", { threadId: body.threadId });
				this.eventBus.emit("session:running", { threadId: body.threadId });
				break;

			case "terminated":
				this.eventBus.emit("terminated", {});
				this.reportExit(0);
				break;

			case "exited":
				this.reportExit(body.exitCode ?? 0);
				break;

			case "output":
				this.eventBus.emit("output", {
					category: body.category ?? "console",
					output: body.output ?? "",
				});
				break;

			case "breakpoint":
				if (body.reason === "changed" || body.reason === "new") {
					const bp = body.breakpoint;
					if (bp?.id) {
						this.eventBus.emit("breakpoint:hit", {
							breakpointId: bp.id,
							file: "",
							line: 0,
						});
					}
				}
				break;
		}
	}

	/**
	 * Send a DAP request and wait for response.
	 */
	sendRequest(command: string, args?: any): Promise<any> {
		if (!this.process?.stdin) {
			throw new Error("GDB process not started");
		}

		const seq = ++this.seq;
		const request = {
			seq,
			type: "request" as const,
			command,
			arguments: args,
		};

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`DAP request "${command}" timed out after ${this.requestTimeout}ms`));
			}, this.requestTimeout);

			this.pending.set(seq, { resolve, reject, timer });

			const body = JSON.stringify(request);
			const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
			this.process!.stdin!.write(message);
		});
	}

	/**
	 * Set request timeout in milliseconds.
	 */
	setRequestTimeout(ms: number): void {
		this.requestTimeout = ms;
	}

	/**
	 * Reject all pending requests (e.g., on GDB exit).
	 */
	private rejectAllPending(error: Error): void {
		for (const [seq, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	/**
	 * Stop the GDB process.
	 */
	async stop(): Promise<void> {
		if (this.process) {
			try {
				await this.sendRequest("disconnect");
			} catch {
				// Ignore errors during disconnect
			}

			this.process.kill();
			this.process = null;
		}

		this.rejectAllPending(new Error("Client stopped"));
	}
}
