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

export type BindingKind = "expression" | "memory" | "series" | "tree" | "registers" | "source" | "assembly" | "interleaved";

/** A node of an expanded expression tree (struct-tree interpreter input). */
export interface VarNode {
	name: string;
	value: string;
	type?: string;
	/** DAP expression that can be evaluated again for this value. */
	evaluateName?: string;
	/** DAP address for reading the value as raw memory when available. */
	memoryReference?: string;
	/** DAP reference used to request this node's children. */
	variablesReference?: number;
	/** DAP container-size hints for indexed or named children. */
	namedVariables?: number;
	indexedVariables?: number;
	presentationHint?: Record<string, unknown>;
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
	type?: string;
	variablesReference: number;
	namedVariables?: number;
	indexedVariables?: number;
	memoryReference?: string;
}

export interface SourceLocation {
	file: string | null;
	line: number;
}

export interface SourceBreakpoint {
	line: number;
	verified: boolean;
	condition?: string;
}

export interface AssemblyLine {
	address: string;
	symbol?: string;
	instructionBytes?: string;
	instruction: string;
	line?: number;
	column?: number;
	current?: boolean;
}

export type InterleavedRow =
	| { kind: "source"; line: number; text: string; current: boolean }
	| { kind: "instruction"; instruction: AssemblyLine };

/** Everything a binding may touch. Hosted by repl.ts over DebuggerAPI. */
export interface FetchCtx {
	evaluate(expression: string, context?: string): Promise<string>;
	evaluateDetailed(expression: string): Promise<EvalInfo>;
	getVariableChildren(reference: number, start?: number, count?: number): Promise<VarNode[]>;
	readMemory(expression: string, count: number, offset?: number): Promise<{ address: string; data: Uint8Array }>;
	getLocation?(): SourceLocation;
	getBreakpoints?(): SourceBreakpoint[];
	readSource?(file: string, startLine: number, count: number): Promise<string[]>;
	disassemble?(memoryReference: string, instructionCount: number, instructionOffset?: number): Promise<AssemblyLine[]>;
	/** Current frame's variables for a scope (locals/args), as VarNodes. Used by
	 * the locals pane; returns [] for scopes the frame doesn't have. */
	getFrameVariables?(scope?: "local" | "args" | "global"): Promise<VarNode[]>;
}

/**
 * One observation of one binding. `error` is set instead of throwing so a
 * pane can render the failure and retry on the next stop.
 */
export interface BindingSnapshot {
	kind: BindingKind;
	/** Display value (series last value, fallback text). */
	value?: string;
	type?: string;
	memoryReference?: string;
	variablesReference?: number;
	namedVariables?: number;
	indexedVariables?: number;
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
	breakpoints?: SourceBreakpoint[];
	instructions?: AssemblyLine[];
	currentAddress?: string;
	interleaved?: InterleavedRow[];
	/** Non-fatal status shown above otherwise useful data. */
	info?: string;
	error?: string;
}

/**
 * Serialized form of a live pane's binding, so layouts can persist which
 * visualizer a pane hosts (`/win load <pane> source` etc.). `kind` mirrors
 * the /win load keywords; parameters are optional-with-defaults exactly like
 * parseLoadSpec, so old/hand-edited docs degrade gracefully.
 */
export type PaneBindingSpec =
	| { kind: "regs" }
	| { kind: "source" }
	| { kind: "asm" }
	| { kind: "iasm" }
	| { kind: "mem"; at: string; byteCount?: number }
	| { kind: "plot"; expr: string; historySize?: number }
	| { kind: "tree"; expr: string; depth?: number }
	| { kind: "locals" };

export interface Binding {
	readonly kind: BindingKind;
	/** Cache/coalescing key; identical identities must fetch identically. */
	identity(): string;
	/** Short human label for pane titles and the /win pick menu. */
	describe(): string;
	fetch(ctx: FetchCtx, prev?: BindingSnapshot): Promise<BindingSnapshot>;
	/** Update view-dependent fetch sizing; returns true when it changed. */
	setViewportHeight?(rows: number): boolean;
	/** Clear state that belongs to a debugger run, such as sample history. */
	reset?(): void;
}

export type ObservationCapability = "value" | "memory" | "tree" | "rows" | "lines" | "assembly" | "interleaved" | "samples";

/** Orthogonal presentation toggles shared by watch entries and live panes. */
export const ViewFlags = {
	None: 0,
	/** Show the address gutter / row offsets in memory views. */
	ADDRESSES: 1 << 0,
	/** Show a type/annotation line in the pane header. */
	TYPES: 1 << 1,
	/** Keep changed-byte highlighting *off* even when a previous stop exists. */
	HIDE_CHANGES: 1 << 2,
	/** Show the ASCII column in the `hexdump` renderer. */
	ASCII: 1 << 3,
} as const;
export type ViewFlags = number;

/** Machine-readable description of each flag bit for `/win pick` and AI tools. */
export interface FlagDescriptor {
	name: string;
	description: string;
}

/** Ordered flag bit → metadata map; order is the human display/cycle order. */
export const VIEW_FLAG_META: Record<number, FlagDescriptor> = {
	[ViewFlags.None]: { name: "none", description: "Default presentation (no flags set)." },
	[ViewFlags.ADDRESSES]: { name: "addresses", description: "Show address gutter and row offsets in memory views." },
	[ViewFlags.TYPES]: { name: "types", description: "Show the observation's type in the pane header." },
	[ViewFlags.HIDE_CHANGES]: { name: "hide-changes", description: "Disable changed-byte/cell highlighting." },
	[ViewFlags.ASCII]: { name: "ascii", description: "Show the ASCII column in the hexdump renderer." },
};

export type OptionKind = "number" | "string" | "boolean" | "enum";

/** Machine-readable option metadata for `/win pick` and future AI tools. */
export interface OptionDescriptor {
	kind: OptionKind;
	description: string;
	required?: boolean;
	default?: unknown;
	enum?: readonly string[];
}

export interface BytesOptions {
	/** Bytes per row before wrapping; auto when omitted. */
	columns?: number;
}

export interface CharsOptions {
	encoding?: "latin1" | "utf8";
	nonPrintable?: "dot" | "hex" | "escape";
	/** Stop at the first zero byte; the default for C string buffers. */
	stopAtNull?: boolean;
}

export interface TupleOptions {
	elementWidth: 1 | 2 | 4 | 8;
	signed?: boolean;
	format?: "dec" | "hex" | "float";
	/** Elements grouped into one printed tuple, e.g. 3 for RGB. */
	tupleWidth?: number;
}

export interface BitmapOptions {
	width?: number;
	height?: number;
	tupleWidth?: number;
	channelOrder?: "rgb" | "bgr" | "rgba" | "gray";
	scale?: "fit" | "1:1";
}

/** Semantic token kinds the source highlighter can emit (see viz/interpreters.ts —
 * per-line regex + keyword set, like gdb's source-highlight). */
export type SyntaxKind =
	| "comment"
	| "string"
	| "char"
	| "number"
	| "keyword"
	| "type"
	| "preprocessor"
	| "identifier"
	| "other";

/** Semantic token kinds the assembly highlighter can emit (see viz/interpreters.ts). */
export type AsmTokenKind =
	| "mnemonic"
	| "register"
	| "immediate"
	| "number"
	| "directive"
	| "symbol"
	| "label"
	| "comment"
	| "other";

	export interface Interpreter {
	readonly id: string;
	readonly title: string;
	/** Example RenderSpec options for tooling/AI; nothing consumes these at runtime. */
	readonly examples?: Record<string, unknown>[];
	/** Flags applied when a render call passes no explicit flags (e.g. hexdump shows gutter+ascii). */
	readonly defaultFlags?: ViewFlags;
	/** Capabilities that must all be present for this renderer. */
	readonly requires?: readonly ObservationCapability[];
	/** Alternative capabilities; at least one must be present when declared. */
	readonly requiresAny?: readonly ObservationCapability[];
	/** Typed options this renderer understands; defaults are baked into registry entries. */
	readonly options?: BytesOptions | CharsOptions | TupleOptions | BitmapOptions;
	/** Schema describing configurable options for tooling and documentation. */
	readonly optionSchema?: Record<string, OptionDescriptor>;
	render(snap: BindingSnapshot | undefined, prev: BindingSnapshot | undefined, rect: Rect, flags?: ViewFlags): string[];
}

/** Any pane content that wants re-evaluation after every stop. */
export interface LivePane {
	/** @param advance true when a genuinely new stop occurred; only then is prevSnap advanced for change highlighting. */
	refreshAll(advance?: boolean): Promise<void> | void;
	/** Clear snapshots and run-local binding state without removing the pane. */
	reset?(): void;
}
