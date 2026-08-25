/**
 * Built-in source bindings: the "what do we observe" half of a watch window.
 * Each fetch produces one BindingSnapshot; failures become `error` snapshots
 * so panes can display them and retry on the next stop instead of throwing.
 */

import type { AssemblyLine, Binding, BindingSnapshot, FetchCtx, VarNode } from "./types.ts";

/** Parse a gdb value string ("42", "0x10", "3.5e2", "100 'd'") to a number. */
export function parseGdbNumber(text: string): number | null {
	const trimmed = text.trim();
	const hex = trimmed.match(/^[-+]?0x[0-9a-fA-F]+/);
	if (hex) return Number.parseInt(hex[0], 16);
	const dec = trimmed.match(/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?/);
	return dec ? Number.parseFloat(dec[0]) : null;
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
			hasChildren: info.variablesReference > 0,
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
		if (!ctx.readSource) return { kind: this.kind, error: "source reading is unavailable" };
		const before = Math.floor((this.lineCount - 1) / 2);
		const startLine = Math.max(1, location.line - before);
		try {
			const lines = await ctx.readSource(location.file, startLine, this.lineCount);
			return { kind: this.kind, file: location.file, startLine, currentLine: location.line, lines };
		} catch (error) {
			return { kind: this.kind, error: message(error) };
		}
	}
}

/** Disassembly window centered around the current program counter. */
export class AssemblyBinding implements Binding {
	readonly kind = "assembly" as const;
	readonly instructionCount: number;
	private static readonly buffer = 10;

	constructor(instructionCount = 24) {
		this.instructionCount = instructionCount;
	}

	identity(): string {
		return `asm:${this.instructionCount}`;
	}

	describe(): string {
		return "assembly";
	}

	async fetch(ctx: FetchCtx): Promise<BindingSnapshot> {
		if (!ctx.disassemble) return { kind: this.kind, error: "disassembly is unavailable" };
		let pc: string;
		try {
			const info = await ctx.evaluateDetailed("$pc");
			pc = parseAddress(info.memoryReference ?? info.result);
			if (!pc) return { kind: this.kind, error: "could not resolve $pc" };
			const before = Math.floor((this.instructionCount - 1) / 2) + AssemblyBinding.buffer;
			// Leave extra byte room before the requested instruction count; x86
			// instructions are variable length, so a nominal instruction-sized
			// offset can otherwise leave $pc just beyond the returned block.
			const start = addressBefore(pc, before + 2);
			const fetched = await ctx.disassemble(start, this.instructionCount + AssemblyBinding.buffer * 2 + 64);
			const currentIndex = fetched.findIndex((instruction: AssemblyLine) => sameAddress(instruction.address, pc));
			const first = currentIndex < 0 ? 0 : Math.max(0, currentIndex - before);
			const instructions = fetched.slice(first, first + this.instructionCount + AssemblyBinding.buffer * 2);
			return {
				kind: this.kind,
				currentAddress: pc,
				instructions: instructions.map((instruction: AssemblyLine) => ({
					...instruction,
					current: sameAddress(instruction.address, pc),
				})),
			};
		} catch (error) {
			return { kind: this.kind, error: message(error) };
		}
	}
}

/** Strip GDB's symbolic suffix (`0x... <func+N>`) before DAP disassembly. */
function parseAddress(value: string): string {
	const match = value.trim().match(/0[xX][0-9a-fA-F]+/);
	return match?.[0] ?? value.trim().split(/\s+/, 1)[0]!;
}

function sameAddress(left: string, right: string): boolean {
	try {
		return BigInt(parseAddress(left)) === BigInt(parseAddress(right));
	} catch {
		return parseAddress(left).toLowerCase() === parseAddress(right).toLowerCase();
	}
}

function addressBefore(address: string, instructions: number): string {
	try {
		const value = BigInt(parseAddress(address));
		return `0x${(value - BigInt(instructions * 16)).toString(16)}`;
	} catch {
		return address;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
