/**
 * Shared types for the debugger-core package.
 */

import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * Session state machine states.
 */
export type SessionState =
	| "not-started"
	| "launching"
	| "running"
	| "stopped"
	| "exited"
	| "detached"
	| "error";

/**
 * Breakpoint representation.
 *
 * Breakpoints created through raw GDB passthrough (e.g. `break <function>`)
 * are registered via `trackExternalBreakpoint`: they carry a display-only
 * `location` instead of a resolved file/line, which also marks them for
 * console-command deletion (GDB's DAP bookkeeping cannot remove them).
 */
export interface Breakpoint {
	id: number;
	file: string;
	line: number;
	condition?: string;
	verified: boolean;
	location?: string;
}

/**
 * Stack frame representation.
 */
export interface StackFrame {
	id: number;
	name: string;
	file: string;
	line: number;
	column: number;
}

/**
 * Variable representation. The optional fields mirror DAP's Variable body
 * and drive the TUI's struct-tree interpreter: `variablesReference` gates
 * lazy child expansion, `namedVariables`/`indexedVariables` hint container
 * sizes, and `memoryReference` links a value to hexdump windows.
 */
export interface Variable {
	name: string;
	value: string;
	type: string;
	variablesReference: number;
	namedVariables?: number;
	indexedVariables?: number;
	memoryReference?: string;
	presentationHint?: Record<string, unknown>;
	evaluateName?: string;
}

/**
 * Full DAP evaluate response — unlike {@link DebuggerAPI.evaluate}, which
 * flattens to the display string, this keeps the variablesReference needed
 * to expand an expression into a tree.
 */
export interface EvaluateInfo {
	result: string;
	type?: string;
	variablesReference: number;
	namedVariables?: number;
	indexedVariables?: number;
	memoryReference?: string;
}

/** Resolved memory read: the adapter-reported base plus the raw bytes. */
export interface MemoryRead {
	address: string;
	data: Uint8Array;
}

export interface Instruction {
	address: string;
	instructionBytes?: string;
	instruction: string;
	line?: number;
	column?: number;
}

export interface ThreadInfo {
	id: number;
	name?: string;
}

/** Subset of the DAP initialize response the core branches on. */
export interface DapCapabilities {
	supportsReadMemoryRequest?: boolean;
	supportsDisassembleRequest?: boolean;
	[key: string]: unknown;
}

/**
 * Debugger events emitted by the event bus.
 */
export interface StopEventData {
	reason: string;
	threadId?: number;
	source?: string;
	line?: number;
	column?: number;
}

export interface DebuggerEvents {
	"session:started": { pid?: number };
	"session:stopped": StopEventData;
	"session:running": { threadId?: number };
	"session:exited": { exitCode: number };
	"session:detached": {};
	"session:error": { error: Error };
	"breakpoint": { id: number; verified: boolean; line?: number; file?: string };
	"breakpoints-changed": {};
	"output": { category: string; output: string };
	"process": { name?: string; systemProcessId?: number; startMethod?: string };
	"stopped": StopEventData;
	"continued": { threadId?: number };
	"terminated": {};
	"location": { file: string | null; line: number };
}

/**
 * DAP client configuration.
 */
export interface DapClientConfig {
	gdbPath?: string;
	program?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

/**
 * Debugger API surface exposed to extensions.
 */
export interface DebuggerAPI {
	// Session control
	launch(program: string, args?: string[]): Promise<void>;
	attach(pid: number): Promise<void>;
	detach(): Promise<void>;
	quit(): Promise<void>;

	// Execution control
	continue(): Promise<void>;
	stepOver(): Promise<void>;
	stepInto(): Promise<void>;
	stepOut(): Promise<void>;

	// Breakpoints
	setBreakpoint(file: string, line: number, condition?: string): Promise<Breakpoint>;
	removeBreakpoint(id: number): Promise<void>;
	listBreakpoints(): Promise<Breakpoint[]>;
	/** Register a breakpoint created through raw GDB (passthrough) so it is counted and deletable. */
	trackExternalBreakpoint(id: number, location?: string): Breakpoint;

	// State
	getState(): SessionState;
	getStack(): Promise<StackFrame[]>;
	getVariables(scope?: "local" | "global" | "args"): Promise<Variable[]>;

	/**
	 * Pin expression evaluation to a stack frame. The selection resets to the
	 * top frame after every stop (frames are stop-scoped in DAP). Rejects if
	 * no frame with that id exists in the current stack.
	 */
	selectFrame(frameId: number): Promise<void>;
	/** Currently selected frame (cached; null while running or before a stop). */
	selectedFrame(): StackFrame | null;

	/** Like evaluate, but keeps the variablesReference/memoryReference metadata. */
	evaluateDetailed(expression: string, context?: string): Promise<EvaluateInfo>;
	/** Lazy child expansion of a variablesReference (DAP `variables`). */
	getVariableChildren(reference: number, start?: number, count?: number): Promise<Variable[]>;

	/**
	 * Read debuggee memory at an expression (`&player`, `0x55f1a0`, …).
	 * Primary path is DAP readMemory; when the adapter lacks the capability
	 * (or errors) it falls back to parsing `x/Nxb` console output. Resolves
	 * with possibly fewer bytes than requested; rejects only if both paths fail.
	 */
	readMemory(expression: string, count: number, offset?: number): Promise<MemoryRead>;
	disassemble(memoryReference: string, instructionCount: number): Promise<Instruction[]>;
	listThreads(): Promise<ThreadInfo[]>;
	capabilities(): DapCapabilities;

	// Raw GDB (escape hatch)
	evaluate(expression: string, context?: string): Promise<any>;

	// Event subscription
	on<K extends keyof DebuggerEvents>(event: K, handler: (data: DebuggerEvents[K]) => void): () => void;
	off<K extends keyof DebuggerEvents>(event: K, handler: (data: DebuggerEvents[K]) => void): void;

	// For UI extensions
	sourceFile: string | null;
	currentLine: number;
	activeThreadId: number;
	breakpoints: Map<number, Breakpoint>;
}
