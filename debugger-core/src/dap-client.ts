/**
 * DAP (Debug Adapter Protocol) client for communicating with GDB.
 * Spawns gdb --interpreter=dap and communicates over stdio.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DebuggerEventBus } from "./event-bus.ts";
import type { DapClientConfig } from "./types.ts";
import { DapProtocolError, DapRequestError, DapTimeoutError, DapTransportError, GdbExitedError } from "./errors.ts";

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

export interface DapTraceEntry {
	direction: "in" | "out";
	timestamp: string;
	message: DapMessage;
}

/**
 * Pending request waiting for response.
 */
interface PendingRequest {
	command: string;
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
	private buffer = Buffer.alloc(0);
	private maxDapFrameSize: number;
	private writeQueue: Promise<void> = Promise.resolve();
	private eventBus: DebuggerEventBus;
	private config: DapClientConfig;
	private requestTimeout = 10_000;
	private capabilities: any = null;
	private exitReported = false;
	private dapTrace: DapTraceEntry[] = [];
	private traceDap: boolean;
	private traceDapMaxEntries: number;
	/**
	 * True between sending launch/attach and the new run showing signs of life.
	 * On relaunch GDB tears down the previous inferior, and those stale
	 * exited/terminated events arrive *after* the new launch request. They must
	 * be swallowed so they don't kill the fresh session's state.
	 */
	private startingRun = false;
	private lastPid: number | undefined = undefined;
	/**
	 * Inferior stdout/stderr capture: GDB 15's DAP forwards inferior output
	 * only lazily (buffered until the next command is processed) and mangles
	 * line boundaries. We redirect the inferior into a FIFO we drain instead,
	 * and suppress GDB's delayed duplicate copies.
	 */
	private fifoDir: string | null = null;
	private fifoFd: number | null = null;
	private outTail = "";
	private pumping = false;
	/** Normalized lines recently delivered from the FIFO, for deduping GDB's
	 * lazy console copies of the same output. */
	private recentInferiorLines: string[] = [];
	/**
	 * With an exec-wrapper installed, every exec boundary makes GDB's DAP emit
	 * exited/terminated for the pre-exec image even though the pid lives on.
	 * Exit reporting is therefore debounced briefly and cancelled if the
	 * inferior shows further signs of life.
	 */
	private pendingExitCode: number | null = null;
	private pendingExitTimer: ReturnType<typeof setTimeout> | null = null;
	private stopPromise: Promise<void> | null = null;
	private stopping = false;

	/**
	 * Emit session:exited once per GDB lifecycle, debounced to ride out
	 * exec-boundary false alarms.
	 */
	private scheduleExit(exitCode: number): void {
		if (this.exitReported || this.startingRun || this.pendingExitTimer) return;
		this.pendingExitCode = exitCode;
		this.pendingExitTimer = setTimeout(() => {
			this.pendingExitTimer = null;
			if (this.exitReported || this.startingRun || this.pendingExitCode === null) return;
			const code = this.pendingExitCode;
			this.pendingExitCode = null;
			this.exitReported = true;
			// The final bytes may still be in flight through the FIFO; give the
			// pump a moment to drain before emitting any unterminated tail.
			setTimeout(() => {
				if (!this.startingRun) this.flushInferiorTail();
			}, 150);
			this.eventBus.emit("session:exited", { exitCode: code });
		}, 120);
	}

	/** Life sign: a debounced exit was a false alarm (exec boundary). */
	private cancelPendingExit(): void {
		if (this.pendingExitTimer) {
			clearTimeout(this.pendingExitTimer);
			this.pendingExitTimer = null;
			this.pendingExitCode = null;
		}
	}

	/**
	 * Set up inferior output capture.
	 *
	 * GDB 15's DAP neither forwards inferior output reliably nor preserves a
	 * final unterminated line, and pointing `inferior-tty` at a FIFO makes GDB
	 * consume bytes behind our back. Instead we install an exec-wrapper that
	 * redirects the inferior's stdout/stderr into a FIFO only we read:
	 *   set exec-wrapper /bin/sh -c 'exec "$@" >FIFO 2>&1' sh
	 * GDB appends the real program and its args after "sh", keeping symbols,
	 * breakpoints and argv untouched.
	 */
	async prepareInferiorIo(): Promise<void> {
		if (this.fifoFd !== null) return;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidb-io-"));
		const fifo = path.join(dir, "inferior.out");
		execFileSync("mkfifo", [fifo]);
		this.fifoDir = dir;
		this.fifoFd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
		await this.sendRequest("evaluate", {
			expression: `set exec-wrapper /bin/sh -c 'exec "$@" >${fifo} 2>&1' sh`,
			context: "repl",
		});
		void this.pumpInferiorOutput();
	}

	private async pumpInferiorOutput(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		const chunk = Buffer.alloc(4096);
		while (this.fifoFd !== null) {
			let n = 0;
			try {
				n = fs.readSync(this.fifoFd, chunk, 0, chunk.length, null);
			} catch (error: any) {
				if (error?.code === "EAGAIN") {
					await new Promise((r) => setTimeout(r, 25));
					continue;
				}
				break;
			}
			if (n > 0) {
				this.outTail += chunk.toString("utf8", 0, n);
				let idx: number;
				while ((idx = this.outTail.indexOf("\n")) !== -1) {
					const line = this.outTail.slice(0, idx + 1);
					this.outTail = this.outTail.slice(idx + 1);
					this.recordInferiorLine(line);
					this.eventBus.emit("output", { category: "stdout", output: line });
				}
				continue;
			}
			// FIFO has no EOF while we hold the write end; just idle.
			await new Promise((r) => setTimeout(r, 50));
		}
		this.pumping = false;
	}

	private flushInferiorTail(): void {
		if (!this.outTail) return;
		const tail = this.outTail.endsWith("\n") ? this.outTail : this.outTail + "\n";
		this.outTail = "";
		this.recordInferiorLine(tail);
		this.eventBus.emit("output", { category: "stdout", output: tail });
	}

	private recordInferiorLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		this.recentInferiorLines.push(trimmed);
		if (this.recentInferiorLines.length > 64) this.recentInferiorLines.shift();
	}

	constructor(eventBus: DebuggerEventBus, config: DapClientConfig = {}) {
		this.eventBus = eventBus;
		this.config = config;
		this.traceDap = config.traceDap ?? false;
		this.traceDapMaxEntries = Math.max(1, config.traceDapMaxEntries ?? 512);
		this.maxDapFrameSize = Math.max(1, config.maxDapFrameSize ?? 8 * 1024 * 1024);
	}

	/** Return a snapshot of the retained DAP conversation. */
	getDapTrace(): DapTraceEntry[] {
		return this.dapTrace.map((entry) => ({ ...entry }));
	}

	/** Return the trace as one JSON object per line for diagnostics. */
	dumpDapTrace(): string {
		return this.dapTrace.map((entry) => JSON.stringify(entry)).join("\n");
	}

	private recordDapTrace(direction: "in" | "out", message: DapMessage): void {
		if (!this.traceDap) return;
		this.dapTrace.push({ direction, timestamp: new Date().toISOString(), message });
		if (this.dapTrace.length > this.traceDapMaxEntries) {
			this.dapTrace.splice(0, this.dapTrace.length - this.traceDapMaxEntries);
		}
	}

	/**
	 * Start GDB with DAP interpreter.
	 */
	async start(): Promise<void> {
		const gdbPath = this.config.gdbPath ?? "gdb";
		const args = ["--interpreter=dap", "--nx", "--quiet"];
		this.exitReported = false;
		this.stopping = false;

		this.process = spawn(gdbPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...this.config.env },
			cwd: this.config.cwd,
		});

		this.process.on("error", (error) => {
			console.error("GDB process error:", error);
			this.rejectAllPending(new DapTransportError("GDB process error", error));
		});

		this.process.on("exit", (code) => {
			this.process = null;
			if (!this.stopping) this.eventBus.emit("gdb:exited", { exitCode: code ?? 0 });
			// GDB itself died — no debouncing, the session is definitively over.
			this.cancelPendingExit();
			this.exitReported = true;
			this.eventBus.emit("session:exited", { exitCode: code ?? 0 });
			this.rejectAllPending(new GdbExitedError());
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
	private handleData(data: Buffer | string): void {
		const chunk = typeof data === "string" ? Buffer.from(data) : data;
		this.buffer = Buffer.concat([this.buffer, chunk]);

		while (true) {
			const headerEnd = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
			if (headerEnd === -1) {
				if (this.buffer.length > this.maxDapFrameSize) this.rejectOversizedFrame();
				break;
			}

			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = header.match(/Content-Length: (\d+)/);
			if (!match) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				this.reportProtocolError("DAP frame is missing Content-Length");
				continue;
			}

			const contentLength = parseInt(match[1], 10);
			if (contentLength > this.maxDapFrameSize) {
				this.rejectOversizedFrame();
				break;
			}
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + contentLength;

			if (this.buffer.length < bodyEnd) {
				if (this.buffer.length > this.maxDapFrameSize + bodyStart) this.rejectOversizedFrame();
				break;
			}

			const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
			this.buffer = this.buffer.slice(bodyEnd);

			try {
				const message = JSON.parse(body) as DapMessage;
				this.recordDapTrace("in", message);
				this.handleMessage(message);
			} catch (error) {
				console.error("Failed to parse DAP message:", error);
			}
		}
	}

	private reportProtocolError(message: string): void {
		this.eventBus.emit("session:error", { error: new DapProtocolError(message) });
	}

	private rejectOversizedFrame(): void {
		this.buffer = Buffer.alloc(0);
		this.reportProtocolError(`DAP frame exceeds ${this.maxDapFrameSize} bytes`);
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
					pending.reject(new DapRequestError(pending.command, message.message ?? "Request failed"));
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
				this.startingRun = false;
				this.cancelPendingExit();
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
				this.startingRun = false;
				this.cancelPendingExit();
				this.eventBus.emit("continued", { threadId: body.threadId });
				this.eventBus.emit("session:running", { threadId: body.threadId });
				break;

			case "process": {
				// GDB re-emits the previous run's process event (same pid) during a
				// relaunch; only a genuinely new pid marks the new run as alive.
				const pid = body.systemProcessId;
				if (pid === undefined || pid !== this.lastPid) {
					this.lastPid = pid;
					this.startingRun = false;
					this.cancelPendingExit();
					this.eventBus.emit("process", {
						name: body.name,
						systemProcessId: pid,
						startMethod: body.startMethod,
					});
				}
				break;
			}

			case "thread":
				if (body.reason === "started") {
					this.startingRun = false;
					this.cancelPendingExit();
				}
				break;

			case "terminated":
				this.eventBus.emit("terminated", {});
				this.scheduleExit(0);
				break;

			case "exited":
				this.scheduleExit(body.exitCode ?? 0);
				break;

			case "output": {
				const output = body.output ?? "";
				// GDB lazily re-forwards inferior output it siphoned from our
				// FIFO whenever it processes the next command. Drop those
				// delayed duplicates; the pump already delivered the real thing.
				if (
					(body.category ?? "console") === "stdout" &&
					output
						.split("\n")
						.filter((l: string) => l.trim())
						.every((l: string) => this.recentInferiorLines.includes(l.trim()) && l.trim().length > 0) &&
					output.trim().length > 0
				) {
					break;
				}
				this.eventBus.emit("output", {
					category: body.category ?? "console",
					output,
				});
				break;
			}

			case "breakpoint":
				if (body.reason === "changed" || body.reason === "new") {
					const bp = body.breakpoint;
					if (bp?.id) {
						this.eventBus.emit("breakpoint", {
							id: bp.id,
							verified: bp.verified ?? false,
							line: bp.line,
							file: bp.source?.path,
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
			throw new DapTransportError("GDB process not started");
		}

		const seq = ++this.seq;
		const request = {
			seq,
			type: "request" as const,
			command,
			arguments: args,
		};

		if (command === "launch" || command === "attach") {
			this.startingRun = true;
			this.exitReported = false;
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new DapTimeoutError(command, this.requestTimeout));
			}, this.requestTimeout);

			this.pending.set(seq, { command, resolve, reject, timer });

			const body = JSON.stringify(request);
			const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
			this.recordDapTrace("out", request);
			const write = this.writeQueue.then(() => this.writeMessage(message));
			this.writeQueue = write.catch(() => undefined);
			void write.catch((error) => {
				const pending = this.pending.get(seq);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(seq);
				pending.reject(error instanceof Error ? error : new DapTransportError(String(error)));
			});
		});
	}

	private async writeMessage(message: string): Promise<void> {
		const stdin = this.process?.stdin;
		if (!stdin) throw new DapTransportError("GDB stdin is not available");
		if (stdin.write(message) !== false) return;
		await once(stdin, "drain");
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

	private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null) return true;
		return new Promise((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve(false);
				}
			}, timeoutMs);
			child.once("exit", () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(true);
				}
			});
		});
	}

	private async terminateProcess(child: ChildProcess): Promise<void> {
		try {
			child.kill("SIGTERM");
		} catch {
			// The process may have exited between the disconnect and kill attempts.
		}
		if (await this.waitForExit(child, 500)) return;

		try {
			child.kill("SIGKILL");
		} catch {
			// The process may have exited before escalation.
		}
		await this.waitForExit(child, 500);
	}

	private async stopInternal(): Promise<void> {
		const child = this.process;
		this.stopping = true;
		this.cancelPendingExit();
		this.pumping = false;

		try {
			if (child) {
				try {
					await this.sendRequest("disconnect");
				} catch {
					// Cleanup must continue even when GDB cannot answer disconnect.
				}
				this.process = null;
				await this.terminateProcess(child);
			}
		} finally {
			this.process = null;
			this.flushInferiorTail();
			if (this.fifoFd !== null) {
				try {
					fs.closeSync(this.fifoFd);
				} catch {
					// Already closed
				}
				this.fifoFd = null;
			}
			if (this.fifoDir) {
				fs.rmSync(this.fifoDir, { recursive: true, force: true });
				this.fifoDir = null;
			}
			this.rejectAllPending(new DapTransportError("Client stopped"));
		}
	}

	/** Stop the GDB process and release all session resources. */
	stop(): Promise<void> {
		if (!this.stopPromise) {
			this.stopPromise = this.stopInternal().finally(() => {
				this.stopPromise = null;
			});
		}
		return this.stopPromise;
	}
}
