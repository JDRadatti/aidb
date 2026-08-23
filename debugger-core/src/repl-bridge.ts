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

	eventBus.on("session:exited", () => {
		sourceFile = null;
		currentLine = 0;
	});

	return {
		async launch(program: string, args?: string[]) {
			stateMachine.transition("launching");
			await ensureStarted();
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
			stateMachine.transition("launching");
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
			await ensureStarted();
			const result = await dapClient.sendRequest("setBreakpoints", {
				source: { path: file },
				breakpoints: [{ line, condition }],
			});

			const bp: Breakpoint = {
				id: result.breakpoints?.[0]?.id ?? breakpoints.size + 1,
				file,
				line,
				condition,
				verified: result.breakpoints?.[0]?.verified ?? false,
			};

			breakpoints.set(bp.id, bp);
			return bp;
		},

		async removeBreakpoint(id: number) {
			const bp = breakpoints.get(id);
			if (bp) {
				await dapClient.sendRequest("setBreakpoints", {
					source: { path: bp.file },
					breakpoints: [],
				});
				breakpoints.delete(id);
			}
		},

		async listBreakpoints() {
			return Array.from(breakpoints.values());
		},

		getState() {
			return stateMachine.getState();
		},

		async getStack() {
			const result = await dapClient.sendRequest("stackTrace", { threadId: activeThreadId });
			return (result.stackFrames ?? []).map((frame: any) => ({
				id: frame.id,
				name: frame.name,
				file: frame.source?.path ?? "",
				line: frame.line,
				column: frame.column,
			}));
		},

		async getVariables(scope?: "local" | "global") {
			const stack = await this.getStack();
			if (stack.length === 0) return [];

			const scopesResult = await dapClient.sendRequest("scopes", {
				frameId: stack[0].id,
			});

			const scopes = scopesResult.scopes ?? [];
			const targetScope = scope === "global"
				? scopes.find((s: any) => /^global/i.test(s.name))
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
			const stack = await this.getStack();
			const result = await dapClient.sendRequest("evaluate", {
				expression,
				frameId: stack[0]?.id,
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
