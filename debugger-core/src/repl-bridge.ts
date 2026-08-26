/**
 * REPL bridge that intercepts Pi input and routes GDB commands via DAP.
 */

import { Buffer } from "node:buffer";
import type { DapClient } from "./dap-client.ts";
import type { DebuggerEventBus } from "./event-bus.ts";
import type {
	Breakpoint,
	DapCapabilities,
	EvaluateInfo,
	Instruction,
	MemoryRead,
	SessionState,
	StackFrame,
	ThreadInfo,
	Variable,
	DebuggerAPI,
} from "./types.ts";
import { CapabilityUnsupportedError, FrameNotFoundError, MemoryReadError } from "./errors.ts";

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
	let recovering = false;
	let lastTarget: { kind: "launch"; program: string; args: string[] } | { kind: "attach"; pid: number } | null = null;

	/**
	 * Per-stop observation state. Every "stopped" event bumps `stopSeq` and
	 * drops the caches, so panes re-querying the same data within one stop
	 * coalesce into a single DAP round-trip while fresh stops always refetch.
	 * Frame ids are DAP-scoped to the stop they came from — the selection is
	 * reset on every stop so watches never pin a stale frame.
	 */
	let stopSeq = 0;
	let selectedFrameId: number | null = null;
	let cachedStack: { seq: number; frames: StackFrame[] } | null = null;
	const scopesCache = new Map<number, any>();
	const variablesCache = new Map<number, Variable[]>();
	const pendingBreakpointUpdates = new Map<number, { verified: boolean; file?: string; line?: number }>();

	function invalidateStopData(): void {
		cachedStack = null;
		scopesCache.clear();
		variablesCache.clear();
		selectedFrameId = null;
	}

	eventBus.on("stopped", () => {
		stopSeq++;
		invalidateStopData();
	});
	eventBus.on("continued", invalidateStopData);
	eventBus.on("session:exited", invalidateStopData);
	eventBus.on("gdb:exited", () => {
		started = false;
		void recoverFromGdbExit();
	});

	async function ensureStarted() {
		if (!started) {
			started = true;
			try {
				await dapClient.start();
			} catch (error) {
				started = false;
				throw error;
			}
		}
	}

	function capabilitiesSafe(): DapCapabilities {
		const caps = (dapClient as unknown as { getCapabilities?: () => unknown }).getCapabilities?.();
		return (caps ?? {}) as DapCapabilities;
	}

	/**
	 * Fetch the top frame for a thread and update tracked location state.
	 * DAP's stopped event does not reliably carry source/line, so we ask
	 * for the stack explicitly after every stop.
	 */
	async function refreshLocation(threadId: number): Promise<void> {
		const requestSeq = stopSeq;
		try {
			const result = await dapClient.sendRequest("stackTrace", { threadId });
			if (requestSeq !== stopSeq || stateMachine.getState() !== "stopped") return;
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

	/** Stack for the active thread, memoized for the duration of one stop. */
	async function getStackCached(): Promise<StackFrame[]> {
		if (cachedStack && cachedStack.seq === stopSeq) return cachedStack.frames;
		let result: any;
		try {
			result = await dapClient.sendRequest("stackTrace", { threadId: activeThreadId });
		} catch {
			// No live stack (e.g. target running, exited, or never started).
			// GDB replies with raw internal errors here; don't leak them.
			return [];
		}
		const frames: StackFrame[] = (result.stackFrames ?? []).map((frame: any) => ({
			id: frame.id,
			name: frame.name,
			file: frame.source?.path ?? "",
			line: frame.line,
			column: frame.column,
		}));
		cachedStack = { seq: stopSeq, frames };
		return frames;
	}

	/** Index of the user-selected frame (top frame when nothing is selected). */
	function selectedIndex(frames: StackFrame[]): number {
		if (selectedFrameId === null) return 0;
		const idx = frames.findIndex((f) => f.id === selectedFrameId);
		return idx >= 0 ? idx : 0;
	}

	/** Frame id evaluations should pin to; undefined lets gdb use its default. */
	async function resolveEvalFrameId(): Promise<number | undefined> {
		if (stateMachine.getState() !== "stopped") return undefined;
		const frames = await getStackCached();
		if (frames.length === 0) return undefined;
		return frames[selectedIndex(frames)].id;
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
		stopSeq++;
		invalidateStopData();
		sourceFile = null;
		currentLine = 0;
		currentColumn = 0;
		activeThreadId = 1;
	}

	/** Restore a state changed optimistically before a DAP request. */
	function rollbackState(previous: SessionState, expected: SessionState): void {
		if (stateMachine.getState() !== expected) return;
		if (stateMachine.forceState) stateMachine.forceState(previous);
		else if (stateMachine.getState() !== previous) stateMachine.transition(previous);
	}

	async function requestWhileRunning(command: string, args: any): Promise<void> {
		const previous = stateMachine.getState();
		stateMachine.transition("running");
		try {
			await dapClient.sendRequest(command, args);
		} catch (error) {
			rollbackState(previous, "running");
			throw error;
		}
	}

	/**
	 * DAP's setBreakpoints replaces the full breakpoint list for a file,
	 * so every mutation must send the complete desired list for that file
	 * (sending just one line would silently delete the others). GDB does
	 * NOT dedupe identical locations within one call — duplicates multiply.
	 */
	function notifyBreakpointsChanged(): void {
		eventBus.emit("breakpoints-changed", {});
	}

	function desiredList(file: string): Array<{ line: number; condition?: string }> {
		return Array.from(breakpoints.values())
			.filter((bp) => bp.file === file)
			.map((bp) => ({ line: bp.line, condition: bp.condition }));
	}

	async function rebindBreakpoints(): Promise<void> {
		const files = [...new Set(Array.from(breakpoints.values()).filter((bp) => bp.location === undefined).map((bp) => bp.file).filter(Boolean))];
		for (const file of files) {
			const old = Array.from(breakpoints.values()).filter((bp) => bp.file === file);
			const desired = desiredList(file);
			const result = await dapClient.sendRequest("setBreakpoints", {
				source: { path: file },
				breakpoints: desired,
			});
			for (const bp of old) breakpoints.delete(bp.id);
			for (const rb of result.breakpoints ?? []) {
				const line = rb?.line ?? desired[0]?.line;
				const source = old.find((bp) => bp.line === line);
				if (!source || line === undefined) continue;
				breakpoints.set(rb?.id ?? source.id, {
					...source,
					id: rb?.id ?? source.id,
					line,
					verified: rb?.verified ?? false,
				});
			}
		}
		notifyBreakpointsChanged();
	}

	async function recoverFromGdbExit(): Promise<void> {
		if (recovering || !lastTarget) return;
		recovering = true;
		const target = lastTarget;
		try {
			beginRun();
			await ensureStarted();
			await rebindBreakpoints();
			if (target.kind === "launch") {
				await dapClient.prepareInferiorIo();
				await dapClient.sendRequest("launch", {
					program: target.program,
					args: target.args,
					gdb: true,
					rights: "all",
				});
			} else {
				await dapClient.sendRequest("attach", { pid: target.pid });
			}
			await dapClient.sendRequest("configurationDone");
		} catch (error) {
			const recoveryError = error instanceof Error ? error : new Error(String(error));
			if (stateMachine.forceState) stateMachine.forceState("error", recoveryError);
			else eventBus.emit("session:error", { error: recoveryError });
		} finally {
			recovering = false;
		}
	}

	function sameCondition(a?: string, b?: string): boolean {
		return (a ?? undefined) === (b ?? undefined);
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
		const desiredByLine = new Map(desired.map((bp) => [bp.line, bp]));
		responses.forEach((rb: any) => {
			const requested = desiredByLine.get(rb?.line);
			if (!requested) return;
			const nb: Breakpoint = {
				id: rb?.id ?? requested.line,
				file,
				line: requested.line,
				condition: requested.condition,
				verified: rb?.verified ?? false,
			};
			breakpoints.set(nb.id, nb);
			created.push(nb);
		});

		notifyBreakpointsChanged();
		if (extra) return created.find((bp) => bp.line === extra.line);
		return undefined;
	}

	eventBus.on("breakpoint", ({ id, verified, file, line }) => {
		const bp = breakpoints.get(id);
		if (!bp) {
			pendingBreakpointUpdates.set(id, { verified, file, line });
			return;
		}
		if (verified !== bp.verified || file !== undefined || line !== undefined) {
			bp.verified = verified;
			if (file) bp.file = file;
			if (line !== undefined) bp.line = line;
			notifyBreakpointsChanged();
		}
	});

	return {
		async launch(program: string, args?: string[]) {
			lastTarget = { kind: "launch", program, args: args ?? [] };
			const previous = stateMachine.getState();
			beginRun();
			try {
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
			} catch (error) {
				rollbackState(previous, "launching");
				throw error;
			}
			// State is auto-wired via event bus; DAP will send "stopped" or "running" events
		},

		async attach(pid: number) {
			lastTarget = { kind: "attach", pid };
			const previous = stateMachine.getState();
			beginRun();
			try {
				await ensureStarted();
				await dapClient.sendRequest("attach", { pid });
				await dapClient.sendRequest("configurationDone");
			} catch (error) {
				rollbackState(previous, "launching");
				throw error;
			}
		},

		async detach() {
			await dapClient.sendRequest("disconnect", { restart: false });
			lastTarget = null;
			stateMachine.transition("detached");
		},

		async quit() {
			await dapClient.sendRequest("disconnect", { terminateDebuggee: true });
			lastTarget = null;
			stateMachine.transition("exited");
		},

		async continue() {
			await requestWhileRunning("continue", { threadId: activeThreadId });
		},

		async stepOver() {
			await requestWhileRunning("next", { threadId: activeThreadId });
		},

		async stepInto() {
			await requestWhileRunning("stepIn", { threadId: activeThreadId });
		},

		async stepOut() {
			await requestWhileRunning("stepOut", { threadId: activeThreadId });
		},

		async setBreakpoint(file: string, line: number, condition?: string) {
			// GDB DAP does not dedupe locations within one setBreakpoints call:
			// re-breaking the same file:line would create a second real
			// breakpoint. Return the existing entry, or update its condition.
			const sameLine = Array.from(breakpoints.values()).filter((bp) => bp.file === file && bp.line === line);
			if (sameLine.length > 0 && sameCondition(sameLine[0].condition, condition)) {
				return sameLine[0];
			}
			if (sameLine.length > 0) {
				sameLine[0].condition = condition;
				await syncFileBreakpoints(file);
				return Array.from(breakpoints.values()).find((bp) => bp.file === file && bp.line === line)!;
			}
			const bp = await syncFileBreakpoints(file, { line, condition });
			return bp!;
		},

		async removeBreakpoint(id: number) {
			const bp = breakpoints.get(id);
			if (!bp) return;
			breakpoints.delete(id);
			if (bp.location !== undefined || !bp.file) {
				// Created via raw GDB passthrough: invisible to GDB's per-file
				// DAP bookkeeping, so only the console command removes it.
				await dapClient.sendRequest("evaluate", { expression: `delete ${id}`, context: "repl" });
			} else {
				await dapClient.sendRequest("setBreakpoints", {
					source: { path: bp.file },
					breakpoints: desiredList(bp.file),
				});
			}
			notifyBreakpointsChanged();
		},

		trackExternalBreakpoint(id: number, location?: string, file = "", line = 0): Breakpoint {
			const existing = breakpoints.get(id);
			if (existing) return existing;
			const update = pendingBreakpointUpdates.get(id);
			pendingBreakpointUpdates.delete(id);
			const nb: Breakpoint = {
				id,
				file: update?.file ?? file,
				line: update?.line ?? line,
				verified: update?.verified ?? true,
				location,
			};
			breakpoints.set(id, nb);
			notifyBreakpointsChanged();
			return nb;
		},

		async listBreakpoints() {
			return Array.from(breakpoints.values());
		},

		getState() {
			return stateMachine.getState();
		},

		async getStack() {
			return getStackCached();
		},

		async getVariables(scope?: "local" | "global" | "args") {
			const stack = await this.getStack();
			if (stack.length === 0) return [];
			const frame = stack[selectedIndex(stack)];

			let scopes = scopesCache.get(frame.id);
			if (!scopes) {
				const scopesResult = await dapClient.sendRequest("scopes", {
					frameId: frame.id,
				});
				scopes = scopesResult.scopes ?? [];
				scopesCache.set(frame.id, scopes);
			}

			const targetScope = scope === "global"
				? scopes.find((s: any) => /^global/i.test(s.name))
				: scope === "args"
					? scopes.find((s: any) => s.presentationHint === "arguments") ?? scopes.find((s: any) => /^arg/i.test(s.name))
					: scopes.find((s: any) => s.presentationHint === "locals") ?? scopes.find((s: any) => /^local/i.test(s.name));

			if (!targetScope) return [];

			const vars = await this.getVariableChildren(targetScope.variablesReference);
			return vars;
		},

		async selectFrame(frameId: number): Promise<void> {
			const frames = await getStackCached();
			const frame = frames.find((f) => f.id === frameId);
			if (!frame) {
				throw new FrameNotFoundError(frameId, frames.length);
			}
			selectedFrameId = frameId;
			if (frame.file) sourceFile = frame.file;
			if (frame.line) currentLine = frame.line;
			emitLocation();
		},

		selectedFrame(): StackFrame | null {
			if (selectedFrameId === null || !cachedStack || cachedStack.seq !== stopSeq) return null;
			return cachedStack.frames.find((f) => f.id === selectedFrameId) ?? null;
		},

		async evaluateDetailed(expression: string, context: string = "watch"): Promise<EvaluateInfo> {
			await ensureStarted();
			const frameId = await resolveEvalFrameId();
			const result = await dapClient.sendRequest("evaluate", {
				expression,
				frameId,
				context,
			});
			return {
				result: String(result.result ?? ""),
				type: result.type,
				variablesReference: result.variablesReference ?? 0,
				namedVariables: result.namedVariables,
				indexedVariables: result.indexedVariables,
				memoryReference: result.memoryReference,
			};
		},

		async getVariableChildren(reference: number, start?: number, count?: number): Promise<Variable[]> {
			const cached = variablesCache.get(reference);
			if (cached) return cached;
			const varsResult = await dapClient.sendRequest("variables", {
				variablesReference: reference,
				start,
				count,
			});
			const vars: Variable[] = (varsResult.variables ?? []).map((v: any) => ({
				name: v.name,
				value: v.value,
				type: v.type ?? "unknown",
				variablesReference: v.variablesReference ?? 0,
				namedVariables: v.namedVariables,
				indexedVariables: v.indexedVariables,
				memoryReference: v.memoryReference,
				presentationHint: v.presentationHint,
				evaluateName: v.evaluateName,
			}));
			variablesCache.set(reference, vars);
			return vars;
		},

		async readMemory(expression: string, count: number, offset?: number): Promise<MemoryRead> {
			await ensureStarted();
			if (capabilitiesSafe().supportsReadMemoryRequest) {
				try {
					const result = await dapClient.sendRequest("readMemory", {
						memoryReference: expression,
						offset,
						count,
					});
					const data = new Uint8Array(Buffer.from(result?.data ?? "", "base64"));
					return { address: result?.address ?? expression, data };
				} catch {
					// Adapter advertised support but refused (bad symbol, unmapped
					// page…). Fall through to the console path so the pane still works.
				}
			}
			const text = await this.evaluate(`x/${count}xb ${expression}`, "repl");
			const { address, bytes } = parseXBytes(String(text ?? ""));
			if (bytes.length === 0) {
				throw new MemoryReadError(count, expression);
			}
			return { address: address ?? expression, data: bytes };
		},

		async disassemble(memoryReference: string, instructionCount: number, instructionOffset = 0): Promise<Instruction[]> {
			await ensureStarted();
			if (!capabilitiesSafe().supportsDisassembleRequest) {
				throw new CapabilityUnsupportedError("disassemble");
			}
			const result = await dapClient.sendRequest("disassemble", {
				memoryReference,
				instructionCount,
				instructionOffset,
			});
			return (result?.instructions ?? []).map((ins: any) => ({
				address: ins.address,
				symbol: ins.symbol,
				instructionBytes: ins.instructionBytes,
				instruction: ins.instruction,
				line: ins.location?.line ?? ins.line,
				column: ins.location?.column ?? ins.column,
			}));
		},

		async listThreads(): Promise<ThreadInfo[]> {
			await ensureStarted();
			const result = await dapClient.sendRequest("threads");
			return (result?.threads ?? []).map((t: any) => ({ id: t.id, name: t.name }));
		},

		capabilities(): DapCapabilities {
			return capabilitiesSafe();
		},

		async evaluate(expression: string, context: string = "watch") {
			await ensureStarted();
			// Only pin to a frame while the target is stopped. Asking for a stack
			// while running/exited makes GDB's DAP blow up with internal Python errors.
			const frameId = await resolveEvalFrameId();
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

/**
 * Parse `x/Nxb ADDR` console output into raw bytes.
 *
 * GDB prints a `ADDR <symbol>:` header, then hex byte tokens separated by
 * tabs, wrapping onto continuation lines that carry no header:
 *
 *   0x55f1a0 &lt;player&gt;:	0x64	0x00	0x00
 *   	0xff	0x7f
 *
 * The resolved address is taken from the header so callers can label rows
 * even on the fallback path where readMemory never ran.
 */
export function parseXBytes(text: string): { address?: string; bytes: Uint8Array } {
	let address: string | undefined;
	const bytes: number[] = [];
	for (const line of text.split("\n")) {
		let payload = line;
		if (!address) {
			const header = line.match(/^\s*(0x[0-9a-fA-F]+)\s*[^:]*:/);
			if (header) {
				address = header[1];
				payload = line.slice(header[0].length);
			}
		}
		for (const token of payload.matchAll(/0x([0-9a-fA-F]{2})\b/g)) {
			bytes.push(Number.parseInt(token[1], 16));
		}
	}
	return { address, bytes: new Uint8Array(bytes) };
}
