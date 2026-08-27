/**
 * Built-in source bindings: the "what do we observe" half of a watch window.
 * Each fetch produces one BindingSnapshot; failures become `error` snapshots
 * so panes can display them and retry on the next stop instead of throwing.
 */

import type { AssemblyLine, Binding, BindingSnapshot, FetchCtx, InterleavedRow, VarNode } from "./types.ts";

/** Parse a gdb value string ("42", "0x10", "3.5e2", "100 'd'") to a number. */
export function parseGdbNumber(text: string): number | null {
	const trimmed = text.trim();
	const hex = trimmed.match(/^[-+]?0x[0-9a-fA-F]+/);
	if (hex) return Number.parseInt(hex[0], 16);
	const dec = trimmed.match(/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?/);
	return dec ? Number.parseFloat(dec[0]) : null;
}

/**
 * Evaluates one expression and enriches its value with type metadata and raw
 * memory when GDB reports a usable memoryReference. A missing or failed memory
 * read is non-fatal: value-only expressions are still useful to renderers.
 */
export class ExpressionBinding implements Binding {
	readonly kind = "expression" as const;
	readonly expr: string;
	readonly byteCount: number;
	readonly offset: number;

	constructor(expr: string, byteCount = 192, offset = 0) {
		this.expr = expr;
		this.byteCount = byteCount;
		this.offset = offset;
	}

	identity(): string {
		return `expression:${this.expr}:${this.byteCount}:${this.offset}`;
	}

	describe(): string {
		return this.expr;
	}

	async fetch(ctx: FetchCtx): Promise<BindingSnapshot> {
		let info;
		try {
			info = await ctx.evaluateDetailed(this.expr);
		} catch (error) {
			return { kind: this.kind, error: message(error) };
		}

		const snapshot: BindingSnapshot = {
			kind: this.kind,
			value: info.result,
			type: info.type,
			memoryReference: info.memoryReference,
			variablesReference: info.variablesReference,
			namedVariables: info.namedVariables,
			indexedVariables: info.indexedVariables,
		};
		let memoryReference = info.memoryReference;
		// GDB's DAP `evaluate` only exposes a memoryReference for address
		// expressions; on an array/struct it returns `result: ""` and no
		// address. Fall back to `&<expr>` for aggregate/pointer types so the
		// byte-oriented renderers see the raw bytes (`&frame`, `&message`,
		// `&sample`). Scalars (non-empty result, scalar type) are left alone.
		if (!memoryReference && looksLikeAddressable(info.type)) {
			try {
				const addressInfo = await ctx.evaluateDetailed(`&${this.expr}`);
				if (addressInfo.memoryReference) {
					memoryReference = addressInfo.memoryReference;
					snapshot.memoryReference = addressInfo.memoryReference;
					snapshot.value = (snapshot.value || addressInfo.result);
				}
			} catch {
				// Not addressable — keep the value-only observation.
			}
		}
		if (!memoryReference) {
			snapshot.info = "raw memory unavailable for this expression";
			return snapshot;
		}
		try {
			const read = await ctx.readMemory(memoryReference, this.byteCount, this.offset);
			snapshot.address = read.address;
			snapshot.bytes = read.data;
		} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		snapshot.info = `raw memory unavailable: ${detail}`;
	}
	return snapshot;
}
}

/**
 * Memory at an address-expression, e.g. `&player` or `buf + 16`.
 * The byte length is fixed at construction; column layout is the
 * interpreter's business.
 */
export class MemoryBinding implements Binding {
	readonly kind = "memory" as const;
	readonly at: string;
	byteCount: number;

	constructor(at: string, byteCount = 192) {
		this.at = at;
		this.byteCount = byteCount;
	}

	identity(): string {
		return `mem:${this.at}:${this.byteCount}`;
	}

	describe(): string {
		return `${this.at} · mem`;
	}

	async fetch(ctx: FetchCtx): Promise<BindingSnapshot> {
		const read = await ctx.readMemory(this.at, this.byteCount);
		return { kind: this.kind, address: read.address, bytes: read.data };
	}
}

/**
 * A numeric expression sampled once per stop into a ring buffer. The ring
 * lives in the binding (not the snapshot) so history survives across stops;
 * unparseable values record an error without corrupting the series.
 */
export class SeriesBinding implements Binding {
	readonly kind = "series" as const;
	readonly expr: string;
	readonly historySize: number;
	private ring: number[] = [];

	constructor(expr: string, historySize = 120) {
		this.expr = expr;
		this.historySize = historySize;
	}

	identity(): string {
		return `plot:${this.expr}:${this.historySize}`;
	}

	describe(): string {
		return `${this.expr} · plot`;
	}

	samples(): readonly number[] {
		return this.ring;
	}

	reset(): void {
		this.ring = [];
	}

	async fetch(ctx: FetchCtx): Promise<BindingSnapshot> {
		let text: string;
		try {
			text = await ctx.evaluate(this.expr);
		} catch (error) {
			return { kind: this.kind, error: message(error) };
		}
		const parsed = parseGdbNumber(text);
		if (parsed === null || !Number.isFinite(parsed)) {
			return { kind: this.kind, error: `cannot plot '${text.trim()}'` };
		}
		this.ring.push(parsed);
		while (this.ring.length > this.historySize) this.ring.shift();
		return { kind: this.kind, samples: [...this.ring] };
	}
}

/**
 * An expression expanded into a tree via DAP variablesReferences, eager to
 * `depth` levels with a total-node budget so huge containers cannot freeze
 * a pane; deeper levels stay collapsible markers for later interaction.
 */
export class TreeBinding implements Binding {
	readonly kind = "tree" as const;
	readonly expr: string;
	readonly depth: number;
	readonly maxNodes: number;

	constructor(expr: string, depth = 2, maxNodes = 256) {
		this.expr = expr;
		this.depth = depth;
		this.maxNodes = maxNodes;
	}

	identity(): string {
		return `tree:${this.expr}:${this.depth}`;
	}

	describe(): string {
		return this.expr;
	}

	async fetch(ctx: FetchCtx): Promise<BindingSnapshot> {
		let info;
		try {
			info = await ctx.evaluateDetailed(this.expr);
		} catch (error) {
			return { kind: this.kind, error: message(error) };
		}
		let budget = this.maxNodes - 1; // the root already claimed its slot
		const hasBudget = (): boolean => budget > 0;
		// Charges one unit per rendered child; nodes pay exactly once, at push
		// time, so re-checking hasBudget at expansion entry never double-charges.
		const takeSlot = (): boolean => {
			if (!hasBudget()) return false;
			budget--;
			return true;
		};
		const root: VarNode = {
			name: this.expr,
			value: info.result,
			type: info.type,
			memoryReference: info.memoryReference,
			variablesReference: info.variablesReference,
			namedVariables: info.namedVariables,
			indexedVariables: info.indexedVariables,
			hasChildren: info.variablesReference > 0,
			ref: info.variablesReference > 0 ? info.variablesReference : undefined,
		};
		await this.expand(ctx, root, info.variablesReference, this.depth, hasBudget, takeSlot);
		return { kind: this.kind, tree: root };
	}

	private async expand(
		ctx: FetchCtx,
		node: VarNode,
		reference: number,
		levelsLeft: number,
		hasBudget: () => boolean,
		takeSlot: () => boolean,
	): Promise<void> {
		if (!node.hasChildren || reference <= 0 || levelsLeft <= 0 || !hasBudget()) return;
		let children: VarNode[];
		try {
			children = await ctx.getVariableChildren(reference);
		} catch {
			return; // Leave the node marked expandable; gdb refused this level.
		}
		node.children = [];
		for (const child of children) {
			if (!takeSlot()) break;
			const mapped: VarNode = {
				name: child.name,
				value: child.value,
				type: child.type,
				evaluateName: child.evaluateName,
				memoryReference: child.memoryReference,
				variablesReference: child.variablesReference,
				namedVariables: child.namedVariables,
				indexedVariables: child.indexedVariables,
				presentationHint: child.presentationHint,
				hasChildren: child.hasChildren,
				ref: child.ref,
			};
			node.children.push(mapped);
			await this.expand(ctx, mapped, mapped.ref ?? 0, levelsLeft - 1, hasBudget, takeSlot);
		}
	}
}

/**
 * `info registers` parsed into aligned rows. Kept on the console path on
 * purpose: it works on every gdb build and the text columns are stable
 * enough for a table renderer (name / hex value / decimal).
 */
export class RegistersBinding implements Binding {
	readonly kind = "registers" as const;

	identity(): string {
		return "registers";
	}

	describe(): string {
		return "registers";
	}

	async fetch(ctx: FetchCtx): Promise<BindingSnapshot> {
		let text: string;
		try {
			text = await ctx.evaluate("info registers", "repl");
		} catch (error) {
			return { kind: this.kind, error: message(error) };
		}
		const rows = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => line.split(/\t|\s{2,}/).map((cell) => cell.trim()).filter((cell) => cell.length > 0));
		return { kind: this.kind, rows };
	}
}

/** Current source window around the debugger's tracked location. */
export class SourceBinding implements Binding {
	readonly kind = "source" as const;
	readonly lineCount: number;

	constructor(lineCount = 24) {
		this.lineCount = lineCount;
	}

	identity(): string {
		return `source:${this.lineCount}`;
	}

	describe(): string {
		return "source";
	}

	async fetch(ctx: FetchCtx): Promise<BindingSnapshot> {
		const location = ctx.getLocation?.();
		if (!location?.file || location.line < 1) return { kind: this.kind, error: "no source location" };
		if (!ctx.readSource) {
			const assembly = await new AssemblyBinding(this.lineCount).fetch(ctx);
			return assembly.error
				? { kind: this.kind, error: "source reading and disassembly are unavailable" }
				: { ...assembly, info: `Source unavailable for ${location.file}; showing assembly only` };
		}
		const before = Math.floor((this.lineCount - 1) / 2);
		const startLine = Math.max(1, location.line - before);
		try {
			const lines = await ctx.readSource(location.file, startLine, this.lineCount);
			const breakpoints = ctx.getBreakpoints?.().filter((breakpoint) => breakpoint.line >= startLine && breakpoint.line < startLine + lines.length);
			return { kind: this.kind, file: location.file, startLine, currentLine: location.line, lines, breakpoints };
		} catch (error) {
			const assembly = await new AssemblyBinding(this.lineCount).fetch(ctx);
			if (!assembly.error) {
				return {
					...assembly,
					info: `Source unavailable for ${location.file}; showing assembly only`,
				};
			}
			return { kind: this.kind, error: `source unavailable for ${location.file}: ${message(error)}` };
		}
	}
}

/** Disassembly window centered around the current program counter. */
export class AssemblyBinding implements Binding {
	readonly kind = "assembly" as const;
	readonly instructionCount: number;
	private readonly buffer: number;

	constructor(instructionCount = 24, buffer = 10) {
		this.instructionCount = instructionCount;
		this.buffer = buffer;
	}

	identity(): string {
		return `asm:${this.instructionCount}`;
	}

	describe(): string {
		return "assembly";
	}

	async fetch(ctx: FetchCtx, previous?: BindingSnapshot): Promise<BindingSnapshot> {
		if (!ctx.disassemble) return { kind: this.kind, error: "disassembly is unavailable" };
		let pc: string;
		try {
			const info = await ctx.evaluateDetailed("$pc");
			pc = parseAddress(info.memoryReference ?? "") || parseAddress(info.result);
			if (!pc) pc = parseAddress(await ctx.evaluate("p/x (void*)$pc", "repl"));
			if (!pc) return { kind: this.kind, error: "could not resolve $pc" };
			// Start before the PC so the DAP response includes preceding
			// instructions. GDB's DAP adapter does not accept negative instruction
			// offsets, but it can disassemble from an earlier memory reference.
			const backBytes = BigInt(this.buffer * 6);
			const pcValue = BigInt(pc);
			const startAddress = pcValue > backBytes ? `0x${(pcValue - backBytes).toString(16)}` : pc;
			const fetched = await ctx.disassemble(startAddress, this.instructionCount + this.buffer * 3 + 64);
			const fetchedAddresses = new Set(fetched.map((instruction) => parseAddress(instruction.address)));
			const prior = (previous?.instructions ?? []).filter((instruction) => !fetchedAddresses.has(parseAddress(instruction.address)));
			const seen = new Set<string>();
			const combined = [...prior, ...fetched].filter((instruction) => {
				const address = parseAddress(instruction.address);
				if (seen.has(address)) return false;
				seen.add(address);
				return true;
			});
			const currentIndex = combined.findIndex((instruction: AssemblyLine) => sameAddress(instruction.address, pc));
			const first = currentIndex < 0 ? 0 : Math.max(0, currentIndex - this.buffer);
			const instructions = combined.slice(first, first + this.instructionCount + this.buffer * 2);
			let currentSymbol = parseSymbol(info.result);
			return {
				kind: this.kind,
				currentAddress: pc,
				breakpoints: ctx.getBreakpoints?.(),
				instructions: instructions.map((instruction: AssemblyLine) => {
					if (instruction.symbol) currentSymbol = instruction.symbol;
					return {
						...instruction,
						symbol: instruction.symbol ?? currentSymbol,
						current: sameAddress(instruction.address, pc),
					};
				}),
			};
		} catch (error) {
			return { kind: this.kind, error: message(error) };
		}
	}
}

/** Source lines with the instructions mapped to each line directly beneath them. */
export class InterleavedBinding implements Binding {
	readonly kind = "interleaved" as const;
	private lineCount: number;
	readonly instructionCount: number;

	constructor(lineCount = 18, instructionCount = 48) {
		this.lineCount = lineCount;
		this.instructionCount = instructionCount;
	}

	setViewportHeight(rows: number): boolean {
		const next = Math.max(3, Math.floor(rows / 2));
		if (next === this.lineCount) return false;
		this.lineCount = next;
		return true;
	}

	identity(): string {
		return `iasm:${this.lineCount}:${this.instructionCount}`;
	}

	describe(): string {
		return "interleaved assembly";
	}

	async fetch(ctx: FetchCtx, previous?: BindingSnapshot): Promise<BindingSnapshot> {
		const previousAssembly = previous?.interleaved
			? { kind: "assembly" as const, instructions: previous.interleaved.filter((row) => row.kind === "instruction").map((row) => row.instruction) }
			: undefined;
		const assembly = await new AssemblyBinding(this.instructionCount, this.lineCount).fetch(ctx, previousAssembly);
		if (assembly.error) return { kind: this.kind, error: assembly.error };
		const location = ctx.getLocation?.();
		if (!location?.file || location.line < 1) return { kind: this.kind, error: "no source location" };
		if (!ctx.readSource) return { kind: this.kind, error: "source reading is unavailable" };
		const currentInstruction = assembly.instructions?.find((instruction) => instruction.current);
		const currentLine = currentInstruction?.line ?? location.line;
		const before = Math.floor((this.lineCount - 1) / 2);
		const startLine = Math.max(1, currentLine - before);
		let lines: string[];
		try {
			lines = await ctx.readSource(location.file, startLine, this.lineCount);
		} catch (error) {
			return {
				kind: this.kind,
				currentAddress: assembly.currentAddress,
				breakpoints: assembly.breakpoints,
				interleaved: (assembly.instructions ?? []).map((instruction) => ({ kind: "instruction" as const, instruction })),
				info: `Source unavailable for ${location.file}; showing assembly only`,
			};
		}
		const endLine = startLine + lines.length - 1;
		const byLine = new Map<number, AssemblyLine[]>();
		const unmapped: AssemblyLine[] = [];
		for (const instruction of assembly.instructions ?? []) {
			if (instruction.line === undefined || instruction.line < startLine || instruction.line > endLine) unmapped.push(instruction);
			else byLine.set(instruction.line, [...(byLine.get(instruction.line) ?? []), instruction]);
		}
		const rows: InterleavedRow[] = [];
		for (const [index, text] of lines.entries()) {
			const line = startLine + index;
			rows.push({ kind: "source", line, text, current: line === currentLine });
			for (const instruction of byLine.get(line) ?? []) rows.push({ kind: "instruction", instruction });
		}
		for (const instruction of unmapped) rows.push({ kind: "instruction", instruction });
		return {
			kind: this.kind,
			file: location.file,
			startLine,
			currentLine,
			currentAddress: assembly.currentAddress,
			breakpoints: ctx.getBreakpoints?.().filter((breakpoint) => breakpoint.line >= startLine && breakpoint.line <= endLine),
			interleaved: rows,
		};
	}
}

function parseSymbol(value: string): string | undefined {
	return value.match(/<([^>]+)>/)?.[1];
}

/** Strip GDB's symbolic suffix (`0x... <func+N>`) before DAP disassembly. */
function parseAddress(value: string): string {
	const match = value.trim().match(/0[xX][0-9a-fA-F]+/);
	return match?.[0] ?? "";
}

function sameAddress(left: string, right: string): boolean {
	try {
		return BigInt(parseAddress(left)) === BigInt(parseAddress(right));
	} catch {
		return parseAddress(left).toLowerCase() === parseAddress(right).toLowerCase();
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Heuristic for whether gdb might expose a memoryReference for `&<expr>`:
 * array/struct/union/enum types, pointers, and C-strings. Scalars like `int`
 * are skipped so we don't burn an extra evaluate for every simple value.
 */
function looksLikeAddressable(type: string | undefined): boolean {
	if (!type) return false;
	return /\[\d*\]|\*|\b(struct|class|union|enum)\b|\bchar\b/.test(type);
}
