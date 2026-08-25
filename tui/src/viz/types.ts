/**
 * Viz framework types: the binding × interpreter contract behind the
 * watch-window plan (watch-windows.html §4).
 *
 * A Binding observes one piece of debuggee state per stop; an Interpreter
 * renders a snapshot into pane lines. Both are pure with respect to gdb —
 * all debuggee access flows through FetchCtx, so tests run without a
 * debugger and interpreters stay trivially golden-file-able.
 */

/** Pane drawing area in character cells. */
export interface Rect {
	width: number;
	height: number;
}

export type BindingKind = "memory" | "series" | "tree" | "registers" | "source" | "assembly";

/** A node of an expanded expression tree (struct-tree interpreter input). */
export interface VarNode {
	name: string;
	value: string;
	type?: string;
	/** True when the node reports a live variablesReference (children exist). */
	hasChildren: boolean;
	/**
	 * DAP variablesReference for further expansion. Present on nodes the
	 * binding may still expand; renderers must never need it.
	 */
	ref?: number;
	children?: VarNode[];
}

/** Structural subset of DAP's evaluate response that bindings rely on. */
export interface EvalInfo {
	result: string;
	variablesReference: number;
	memoryReference?: string;
}

export interface SourceLocation {
	file: string | null;
	line: number;
}

export interface AssemblyLine {
	address: string;
	instructionBytes?: string;
	instruction: string;
	line?: number;
	column?: number;
	current?: boolean;
}

/** Everything a binding may touch. Hosted by repl.ts over DebuggerAPI. */
export interface FetchCtx {
	evaluate(expression: string, context?: string): Promise<string>;
	evaluateDetailed(expression: string): Promise<EvalInfo>;
	getVariableChildren(reference: number, start?: number, count?: number): Promise<VarNode[]>;
	readMemory(expression: string, count: number, offset?: number): Promise<{ address: string; data: Uint8Array }>;
	getLocation?(): SourceLocation;
	readSource?(file: string, startLine: number, count: number): Promise<string[]>;
	disassemble?(memoryReference: string, instructionCount: number): Promise<AssemblyLine[]>;
}

/**
 * One observation of one binding. `error` is set instead of throwing so a
 * pane can render the failure and retry on the next stop.
 */
export interface BindingSnapshot {
	kind: BindingKind;
	/** Display value (series last value, fallback text). */
	value?: string;
	tree?: VarNode;
	/** Sample history for sparklines; index 0 = oldest stop. */
	samples?: number[];
	bytes?: Uint8Array;
	address?: string;
	rows?: string[][];
	lines?: string[];
	file?: string;
	startLine?: number;
	currentLine?: number;
	instructions?: AssemblyLine[];
	currentAddress?: string;
	error?: string;
}

export interface Binding {
	readonly kind: BindingKind;
	/** Cache/coalescing key; identical identities must fetch identically. */
	identity(): string;
	/** Short human label for pane titles and the /win pick menu. */
	describe(): string;
	fetch(ctx: FetchCtx, prev?: BindingSnapshot): Promise<BindingSnapshot>;
	/** Clear state that belongs to a debugger run, such as sample history. */
	reset?(): void;
}

export interface Interpreter {
	readonly id: string;
	readonly title: string;
	render(snap: BindingSnapshot | undefined, prev: BindingSnapshot | undefined, rect: Rect): string[];
}

/** Any pane content that wants re-evaluation after every stop. */
export interface LivePane {
	refreshAll(): Promise<void> | void;
	/** Clear snapshots and run-local binding state without removing the pane. */
	reset?(): void;
}
