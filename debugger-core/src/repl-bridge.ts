/**
 * REPL bridge that intercepts Pi input and routes GDB commands via DAP.
 */

import type { DapClient } from "./dap-client.ts";
import type { DebuggerEventBus } from "./event-bus.ts";
import type { Breakpoint, SessionState, StackFrame, Variable, DebuggerAPI } from "./types.ts";

/**
 * GDB commands that should be routed to DAP evaluate.
 */
const GDB_COMMANDS = [
	"break",
	"b ",
	"delete",
	"clear",
	"run",
	"r ",
	"continue",
	"c ",
	"next",
	"n ",
	"step",
	"s ",
	"finish",
	"f ",
	"backtrace",
	"bt",
	"print",
	"p ",
	"info locals",
	"info args",
	"info registers",
	"info breakpoints",
	"info break",
	"watch",
	"rwatch",
	"set",
	"unset",
	"list",
	"l ",
	"where",
	"up",
	"down",
	"thread",
	"frame",
	"disassemble",
	"x ",
	"whatis",
	"ptype",
	"show",
	"help",
	"quit",
	"exit",
];

/**
 * Creates the debugger API implementation.
 * Uses the shared DapClient, EventBus, and StateMachine instances.
 */
export function createDebuggerAPI(
	dapClient: DapClient,
	eventBus: DebuggerEventBus,
	stateMachine: { getState(): SessionState; transition(state: SessionState, data?: any): void; forceState?(state: SessionState, data?: any): void },
): DebuggerAPI {
	const breakpoints = new Map<number, Breakpoint>();
	let sourceFile: string | null = null;
	let currentLine = 0;
	let currentColumn = 0;
	let activeThreadId = 1;
	let started = false;

	async function ensureStarted() {
		if (!started) {
			started = true;
			await dapClient.start();
		}
	}

	/**
	 * Fetch the top frame for a thread and update tracked location state.
	 * DAP's stopped event does not reliably carry source/line, so we ask
	 * for the stack explicitly after every stop.
	 */
	async function refreshLocation(threadId: number): Promise<void> {
		try {
			const result = await dapClient.sendRequest("stackTrace", { threadId });
			const frame = result.stackFrames?.[0];
			if (!frame) return;
			sourceFile = frame.source?.path ?? sourceFile;
			currentLine = frame.line ?? currentLine;
			currentColumn = frame.column ?? currentColumn;
			emitLocation();
		} catch {
			// Target may resume or exit before we can read the stack; keep last known location.
		}
	}

	function emitLocation(): void {
		eventBus.emit("location", { file: sourceFile, line: currentLine });
	}

	eventBus.on("stopped", (data) => {
		let changed = false;
		if (data.threadId !== undefined) {
			activeThreadId = data.threadId;
		}
		if (data.source) {
			sourceFile = data.source;
			changed = true;
		}
		if (data.line !== undefined) {
			currentLine = data.line;
			changed = true;
		}
		if (changed) {
			emitLocation();
		}
		if (data.threadId !== undefined && !data.source) {
			void refreshLocation(data.threadId);
		}
	});

	eventBus.on("session:exited", () => {
		sourceFile = null;
		currentLine = 0;
		emitLocation();
	});

	eventBus.on("continued", (data) => {
		if (data.threadId !== undefined) {
			activeThreadId = data.threadId;
		}
	});

	/**
	 * Begin a new run on the existing GDB process. GDB's DAP supports
	 * repeated launch/attach requests, so `run` can restart the target
	 * while keeping breakpoints — no client reset needed.
	 */
	function beginRun(): void {
		const state = stateMachine.getState();
		if (state === "not-started") {
			stateMachine.transition("launching");
		} else {
			stateMachine.forceState?.("launching");
		}
		sourceFile = null;
		currentLine = 0;
		currentColumn = 0;
		activeThreadId = 1;
	}

	/**
	 * DAP's setBreakpoints replaces the full breakpoint list for a file,
	 * so every mutation must send the complete desired list for that file
	 * (sending just one line would silently delete the others).
	 */
	function desiredList(file: string): Array<{ line: number; condition?: string }> {
		return Array.from(breakpoints.values())
			.filter((bp) => bp.file === file)
			.map((bp) => ({ line: bp.line, condition: bp.condition }));
	}

	async function syncFileBreakpoints(file: string, extra?: { line: number; condition?: string }): Promise<Breakpoint | undefined> {
		await ensureStarted();
		const existing = Array.from(breakpoints.values()).filter((bp) => bp.file === file);
		const desired = [...desiredList(file), ...(extra ? [extra] : [])];
		const result = await dapClient.sendRequest("setBreakpoints", {
			source: { path: file },
			breakpoints: desired,
		});

		for (const bp of existing) breakpoints.delete(bp.id);

		const created: Breakpoint[] = [];
		const responses = result.breakpoints ?? [];
		responses.forEach((rb: any, i: number) => {
			const nb: Breakpoint = {
				id: rb?.id ?? i + 1,
				file,
				line: desired[i]?.line ?? rb?.line ?? 0,
				condition: desired[i]?.condition,
				verified: rb?.verified ?? false,
			};
			breakpoints.set(nb.id, nb);
			created.push(nb);
		});

		if (extra) return created[created.length - 1];
		return undefined;
	}

	eventBus.on("breakpoint", ({ id, verified }) => {
		const bp = breakpoints.get(id);
		if (bp && verified !== bp.verified) {
			bp.verified = verified;
		}
	});

	return {
		async launch(program: string, args?: string[]) {
			beginRun();
			await ensureStarted();
			// Install an exec-wrapper piping inferior stdout/stderr into a FIFO
			// we drain ourselves: GDB's DAP drops/mangles program output.
			await dapClient.prepareInferiorIo();
			await dapClient.sendRequest("launch", {
				program,
				args: args ?? [],
				gdb: true,
				rights: "all",
			});
			await dapClient.sendRequest("configurationDone");
			// State is auto-wired via event bus; DAP will send "stopped" or "running" events
		},

		async attach(pid: number) {
			beginRun();
			await ensureStarted();
			await dapClient.sendRequest("attach", { pid });
			await dapClient.sendRequest("configurationDone");
		},

		async detach() {
			await dapClient.sendRequest("disconnect", { restart: false });
			stateMachine.transition("detached");
		},

		async quit() {
			await dapClient.sendRequest("disconnect", { terminateDebuggee: true });
			stateMachine.transition("exited");
		},

		async continue() {
			stateMachine.transition("running");
			await dapClient.sendRequest("continue", { threadId: activeThreadId });
		},

		async stepOver() {
			stateMachine.transition("running");
			await dapClient.sendRequest("next", { threadId: activeThreadId });
		},

		async stepInto() {
			stateMachine.transition("running");
			await dapClient.sendRequest("stepIn", { threadId: activeThreadId });
		},

		async stepOut() {
			stateMachine.transition("running");
			await dapClient.sendRequest("stepOut", { threadId: activeThreadId });
		},

		async setBreakpoint(file: string, line: number, condition?: string) {
			const bp = await syncFileBreakpoints(file, { line, condition });
			return bp!;
		},

		async removeBreakpoint(id: number) {
			const bp = breakpoints.get(id);
			if (!bp) return;
			breakpoints.delete(id);
			await dapClient.sendRequest("setBreakpoints", {
				source: { path: bp.file },
				breakpoints: desiredList(bp.file),
			});
		},

		async listBreakpoints() {
			return Array.from(breakpoints.values());
		},

		getState() {
			return stateMachine.getState();
		},

		async getStack() {
			let result: any;
			try {
				result = await dapClient.sendRequest("stackTrace", { threadId: activeThreadId });
			} catch {
				// No live stack (e.g. target running, exited, or never started).
				// GDB replies with raw internal errors here; don't leak them.
				return [];
			}
			return (result.stackFrames ?? []).map((frame: any) => ({
				id: frame.id,
				name: frame.name,
				file: frame.source?.path ?? "",
				line: frame.line,
				column: frame.column,
			}));
		},

		async getVariables(scope?: "local" | "global" | "args") {
			const stack = await this.getStack();
			if (stack.length === 0) return [];

			const scopesResult = await dapClient.sendRequest("scopes", {
				frameId: stack[0].id,
			});

			const scopes = scopesResult.scopes ?? [];
			const targetScope = scope === "global"
				? scopes.find((s: any) => /^global/i.test(s.name))
				: scope === "args"
					? scopes.find((s: any) => s.presentationHint === "arguments") ?? scopes.find((s: any) => /^arg/i.test(s.name))
					: scopes.find((s: any) => s.presentationHint === "locals") ?? scopes.find((s: any) => /^local/i.test(s.name));

			if (!targetScope) return [];

			const varsResult = await dapClient.sendRequest("variables", {
				variablesReference: targetScope.variablesReference,
			});

			return (varsResult.variables ?? []).map((v: any) => ({
				name: v.name,
				value: v.value,
				type: v.type ?? "unknown",
				variablesReference: v.variablesReference,
			}));
		},

		async evaluate(expression: string, context: string = "watch") {
			await ensureStarted();
			// Only pin to a frame while the target is stopped. Asking for a stack
			// while running/exited makes GDB's DAP blow up with internal Python errors.
			let frameId: number | undefined;
			if (stateMachine.getState() === "stopped") {
				const stack = await this.getStack();
				frameId = stack[0]?.id;
			}
			const result = await dapClient.sendRequest("evaluate", {
				expression,
				frameId,
				context,
			});
			return result.result;
		},

		on(event, handler) {
			return eventBus.on(event, handler);
		},

		off(event, handler) {
			eventBus.off(event, handler);
		},

		get sourceFile() {
			return sourceFile;
		},

		get currentLine() {
			return currentLine;
		},

		get activeThreadId() {
			return activeThreadId;
		},

		get breakpoints() {
			return breakpoints;
		},
	};
}

/**
 * Check if input is a GDB command (vs Pi command).
 */
export function isGdbCommand(input: string): boolean {
	const trimmed = input.trim();

	if (GDB_COMMANDS.some((cmd) => trimmed.startsWith(cmd))) {
		return true;
	}

	if (/^\d+$/.test(trimmed)) {
		return true;
	}

	return false;
}
