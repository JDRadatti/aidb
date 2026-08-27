/**
 * Slash-command registry + hierarchical completer.
 *
 * This is the single review surface for every slash command: its name, help
 * line, argument hint, and — critically — the completion source for each
 * argument position. Wiring it into `CombinedAutocompleteProvider` gives us
 * pi-tui's native fuzzy command-name matching plus our own per-token argument
 * completion (panes, visualizer types, interpreters, files, breakpoints).
 *
 * Why a custom provider pass? The stock `CombinedAutocompleteProvider` treats
 * the whole post-space argument text as a single completion token, so
 * completing `/win load m` would overwrite "load". We intercept the
 * slash-argument context ourselves, compute the exact token under the cursor,
 * and let everything else (command-name fuzzy completion, non-slash file
 * paths, `@` fuzzy files) fall through to stock.
 */

import * as os from "node:os";
import * as path from "node:path";
import { readdirSync, statSync } from "node:fs";
import {
	CombinedAutocompleteProvider,
	fuzzyMatch,
	type AutocompleteItem,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { ReplContext } from "./repl.ts";
import { INTERPRETERS } from "./viz/interpreters.ts";
import { VIEW_FLAG_META, ViewFlags } from "./viz/types.ts";

/** A registry entry with an argument completer per token position. */
interface Cmd {
	name: string;
	description?: string;
	argumentHint?: string;
	/**
	 * `tokens` is every command argument token (the command name itself
	 * excluded). `pos` is the index of the token being completed (works even
	 * when that token is empty, i.e. the caret sits after a trailing space).
	 */
	args?: (
		ctx: ReplContext,
		tokens: string[],
		pos: number,
		current: string,
	) => AutocompleteItem[] | null;
}

const HOME = os.homedir();

// ---------- fuzzy helpers ---------- (score: lower = better)

function fuzzyItems<T extends AutocompleteItem>(
	items: T[],
	query: string,
	getText: (item: T) => string = (item) => item.value,
	limit = 20,
): T[] {
	if (!query) return items.slice(0, limit);
	return items
		.map((item) => ({ item, m: fuzzyMatch(query, getText(item)) }))
		.filter((x) => x.m.matches)
		.sort((a, b) => a.m.score - b.m.score)
		.slice(0, limit)
		.map((x) => x.item);
}

// ---------- file completion ----------

function isDirectory(fullPath: string): boolean {
	try {
		return statSync(fullPath).isDirectory();
	} catch {
		return false;
	}
}
/** List a directory, producing display-paths in the same style as `input`. */
function listDir(
	absDir: string,
	makeValue: (name: string, isDir: boolean) => string,
	fileBase: string,
): AutocompleteItem[] {
	let entries;
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: AutocompleteItem[] = [];
	for (const entry of entries) {
		if (fileBase && !entry.name.toLowerCase().startsWith(fileBase.toLowerCase())) continue;
		const isDirEntry = entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(absDir, entry.name)));
		out.push({
			value: makeValue(entry.name, isDirEntry),
			label: entry.name + (isDirEntry ? "/" : ""),
			description: path.join(absDir, entry.name),
		});
	}
	out.sort(
		(a, b) =>
			Number(b.label.endsWith("/")) - Number(a.label.endsWith("/")) || a.label.localeCompare(b.label),
	);
	return out;
}

/** Complete a path token, mirroring the user's `~ /` absolute/relative style. */
function completePath(input: string): AutocompleteItem[] {
	if (input === "~") return withParentPrefix(listDir(HOME, (n, d) => `~/${n}${d ? "/" : ""}`, ""), "~/..");
	if (input === "~/") return withParentPrefix(listDir(HOME, (n, d) => `~/${n}${d ? "/" : ""}`, ""), "~/..");
	if (input.startsWith("~/")) {
		const rel = input.slice(2);
		const idx = rel.lastIndexOf("/");
		if (idx === -1) return withParentPrefix(listDir(HOME, (n, d) => `~/${n}${d ? "/" : ""}`, rel), "~/..");
		const dirPart = rel.slice(0, idx + 1);
		const base = rel.slice(idx + 1);
		return withParentPrefix(
			listDir(path.join(HOME, dirPart), (n, d) => `~/${dirPart}${n}${d ? "/" : ""}`, base),
			`~/${dirPart}..`,
		);
	}
	if (input.startsWith("/")) {
		const idx = input.lastIndexOf("/");
		const dirPart = input.slice(0, idx + 1);
		const base = input.slice(idx + 1);
		const items = listDir(dirPart, (n, d) => `${dirPart}${n}${d ? "/" : ""}`, base);
		return dirPart === "/" ? items : withParentPrefix(items, `${dirPart}..`);
	}
	const idx = input.lastIndexOf("/");
	const dirPart = idx >= 0 ? input.slice(0, idx + 1) : "";
	const base = idx >= 0 ? input.slice(idx + 1) : input;
	const items = listDir(path.join(process.cwd(), dirPart), (n, d) => `${dirPart}${n}${d ? "/" : ""}`, base);
	return withParentPrefix(items, `${dirPart}..`);
}

/** Prepend a “..” parent-directory entry (a navigable dir) to a listing. */
function withParentPrefix(items: AutocompleteItem[], upValue: string): AutocompleteItem[] {
	if (!upValue) return items;
	const value = upValue.endsWith("/") ? upValue : `${upValue}/`;
	return [{ value, label: upValue, description: "parent directory" }, ...items];
}

// ---------- pane & visualizer sources ----------

function paneItems(ctx: ReplContext, current: string): AutocompleteItem[] {
	const panes = ctx.windows.list();
	const items = panes.map((p) => ({
		value: p.id,
		label: `${p.idx} · ${p.id}${p.active ? " *" : ""}`,
		description: p.title,
	}));
	return fuzzyItems(items, current, (item) => `${item.label} ${item.value} ${item.description ?? ""}`);
}

const WIN_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "vsplit", label: "vsplit", description: "split a pane into columns" },
	{ value: "hsplit", label: "hsplit", description: "split a pane into rows" },
	{ value: "close", label: "close", description: "close a pane" },
	{ value: "next", label: "next", description: "make the next pane active" },
	{ value: "list", label: "list", description: "print idx → id mapping" },
	{ value: "load", label: "load", description: "bind a live visualizer into a pane" },
	{ value: "pick", label: "pick", description: "swap an interpreter / toggle a flag" },
];

const VISUALS: AutocompleteItem[] = [
	{ value: "watch", label: "watch", description: "live watch pane (add entries with /watch)" },
	{ value: "regs", label: "regs", description: "registers" },
	{ value: "mem", label: "mem", description: "memory at an expression" },
	{ value: "plot", label: "plot", description: "sparkline samples of an expression" },
	{ value: "tree", label: "tree", description: "struct tree of an expression" },
	{ value: "source", label: "source", description: "source lines" },
	{ value: "asm", label: "asm", description: "assembly" },
	{ value: "iasm", label: "iasm", description: "interleaved source+assembly" },
];

function interpreterItems(current: string): AutocompleteItem[] {
	const items = Object.entries(INTERPRETERS).map(([id, interp]) => ({
		value: id,
		label: id,
		description: interp.title,
	}));
	return fuzzyItems(items, current);
}

/** A `+flag` item per render flag, for `/win pick` and `/watch flag`. */
function flagItems(current: string): AutocompleteItem[] {
	const items = Object.entries(VIEW_FLAG_META)
		.filter(([raw, meta]) => Number(raw) !== ViewFlags.None && meta.name !== "none")
		.map(([, meta]) => ({ value: `+${meta.name}`, label: `+${meta.name}`, description: meta.description }));
	return fuzzyItems(items, current, (it) => it.label);
}

/** `/win` — subcommand, then subcommand-specific pane / visualizer / interpreter */
function winCompletion(ctx: ReplContext, tokens: string[], pos: number, current: string): AutocompleteItem[] | null {
	if (pos === 0) return fuzzyItems(WIN_SUBCOMMANDS, current, (it) => it.value);
	const sub = tokens[0];
	switch (sub) {
		case "load":
			if (pos === 1) return paneItems(ctx, current);
			if (pos === 2) return fuzzyItems(VISUALS, current, (it) => it.value);
			return null;
		case "pick":
			if (pos === 1) return paneItems(ctx, current);
			if (pos === 2) return [...interpreterItems(current), ...flagItems(current)];
			return null;
		case "close":
		case "vsplit":
		case "hsplit":
			if (pos === 1) return paneItems(ctx, current);
			return null;
		default:
			return null;
	}
}

/** `/remove` — breakpoints installed on the current target. */
function breakpointItems(ctx: ReplContext, current: string): AutocompleteItem[] {
	const items = [...ctx.getApi().breakpoints.values()].map((bp) => ({
		value: String(bp.id),
		label: String(bp.id),
		description: bp.location ?? (bp.file ? `${bp.file}:${bp.line}` : bp.file) ?? "",
	}));
	return fuzzyItems(items, current);
}

// ---------- registry ----------

const COMMANDS: Cmd[] = [
	{ name: "help", description: "show help", argumentHint: "[topic]" },
	{ name: "run", description: "start or restart the target", argumentHint: "[program] [args...]",
		args: (_, tokens, pos, cur) => (pos === 0 ? completePath(cur) : null) },
	{ name: "launch", description: "launch a program", argumentHint: "<program> [args...]",
		args: (_, tokens, pos, cur) => (pos === 0 ? completePath(cur) : null) },
	{ name: "attach", description: "attach to a pid", argumentHint: "<pid>" },
	{ name: "break", description: "set a breakpoint", argumentHint: "<file:line | line | function> [if cond]",
		args: (_, tokens, pos, cur) => (pos === 0 ? completePath(cur) : null) },
	{ name: "breaks", description: "list breakpoints", argumentHint: "" },
	{ name: "remove", description: "remove breakpoint(s)", argumentHint: "[id...]",
		args: (ctx, tokens, pos, cur) => (pos === 0 ? breakpointItems(ctx, cur) : null) },
	{ name: "step", description: "step into (<stepInto>)", argumentHint: "" },
	{ name: "next", description: "step over (<stepOver>)", argumentHint: "" },
	{ name: "finish", description: "step out (<stepOut>)", argumentHint: "" },
	{ name: "continue", description: "resume execution", argumentHint: "" },
	{ name: "stack", description: "backtrace", argumentHint: "" },
	{ name: "locals", description: "variables of the current frame", argumentHint: "" },
	{ name: "status", description: "target state", argumentHint: "" },
	{ name: "switch", description: "make a pane active", argumentHint: "<idx|name>",
		args: (ctx, tokens, pos, cur) => (pos === 0 ? paneItems(ctx, cur) : null) },
	{ name: "win", description: "pane management", argumentHint: "<sub> [...]",
		args: winCompletion },
	{ name: "config", description: "inspect or reload config", argumentHint: "[reload]" },
	{ name: "watch", description: "pin an expression to a watch pane", argumentHint: "<expr> | list | cycle [n] | flag <n> [n] | del <n>" },
	{ name: "quit", description: "exit aidb", argumentHint: "" },
];

/** The review surface: every slash command + its per-argument completer. */
export function buildCommandRegistry(): Cmd[] {
	return COMMANDS;
}

/**
 * Completion provider that:
 *  - completes slash-command *arguments* token-by-token (position-aware),
 *    so `/win load <pane>` never erases "load";
 *  - delegates everything else (command-name fuzzy, paths, `@files`) to stock.
 */
export class AidbCompletionProvider extends CombinedAutocompleteProvider {
	private readonly ctx: ReplContext;
	private readonly cmds: Cmd[];

	constructor(cmds: Cmd[], ctx: ReplContext, basePath: string, fdPath?: string | null) {
		super(
			cmds.map((c) => ({
				name: c.name,
				...(c.description && { description: c.description }),
				...(c.argumentHint && { argumentHint: c.argumentHint }),
			})),
			basePath,
			fdPath,
		);
		this.cmds = cmds;
		this.ctx = ctx;
	}

	override async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const before = currentLine.slice(0, cursorCol);
		const trimmed = before.trimStart();
		if (trimmed.startsWith("/")) {
			const afterSlash = trimmed.slice(trimmed.indexOf("/") + 1);
			if (afterSlash.includes(" ")) {
				const result = this.commandArgumentSuggestions(afterSlash);
				if (result) return result;
			}
		}
		return super.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	/** Position-aware slash-argument completion; returns null when no items. */
	private commandArgumentSuggestions(afterSlash: string): AutocompleteSuggestions | null {
		const atNewArg = /\s$/.test(afterSlash);
		const tokens = afterSlash.split(/\s+/).filter(Boolean);
		const cmdName = tokens[0] ?? "";
		const cmd = this.cmds.find((c) => c.name === cmdName);
		if (!cmd || !cmd.args) return null;
		const rest = tokens.slice(1);
		const pos = atNewArg ? rest.length : Math.max(0, rest.length - 1);
		const current = atNewArg ? "" : (rest[rest.length - 1] ?? "");
		const items = cmd.args(this.ctx, rest, pos, current);
		if (!items || items.length === 0) return null;
		return { items, prefix: current };
	}
}