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
 */
export interface Breakpoint {
	id: number;
	file: string;
	line: number;
	condition?: string;
	verified: boolean;
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
 * Variable representation.
 */
export interface Variable {
	name: string;
	value: string;
	type: string;
	variablesReference: number;
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
	"breakpoint:hit": { breakpointId: number; file: string; line: number };
	"output": { category: string; output: string };
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

	// State
	getState(): SessionState;
	getStack(): Promise<StackFrame[]>;
	getVariables(scope?: "local" | "global"): Promise<Variable[]>;

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
