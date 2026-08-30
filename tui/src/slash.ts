/**
 * Slash-command registry + hierarchical completer.
 *
 * This is the single review surface for every slash command: its name, help
 * line, argument hint, and — critically — the completion source for each
 * argument position. Wiring it into `CombinedAutocompleteProvider` gives us
 * pi-tui's native fuzzy command-name matching plus our own per-token argument
 * completion (panes, visualizer types, interpreters, saved names).
 *
 * Why a custom provider pass? The stock `CombinedAutocompleteProvider` treats
 * the whole post-space argument text as a single completion token, so
 * completing `/win load m` would overwrite "load". We intercept the
 * slash-argument context ourselves, compute the exact token under the cursor,
 * and let everything else (command-name fuzzy completion, non-slash file
 * paths, `@` fuzzy files) fall through to stock.
 */

import {
	CombinedAutocompleteProvider,
	fuzzyMatch,
	type AutocompleteItem,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { ReplContext } from "./repl.ts";
import { THEME_PRESET_MODE, THEME_PRESET_NAMES } from "./config.ts";
import { INTERPRETERS } from "./viz/interpreters.ts";
import { VIEW_FLAG_META, ViewFlags } from "./viz/types.ts";
import { dimPlaceholders } from "./theme.ts";

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
	{ value: "switch", label: "switch", description: "make a pane active" },
	{ value: "swap", label: "swap", description: "exchange two panes' cells" },
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
		case "switch":
		case "close":
		case "vsplit":
		case "hsplit":
			if (pos === 1) return paneItems(ctx, current);
			return null;
		case "swap":
			if (pos === 1 || pos === 2) return paneItems(ctx, current);
			return null;
		default:
			return null;
	}
}


/** `/session` — `save` only, or a saved session name to restore. */
function sessionCompletion(ctx: ReplContext, tokens: string[], pos: number, current: string): AutocompleteItem[] | null {
	if (pos === 0) return sessionNameItems(ctx, current);
	const first = tokens[0];
	if (first === "save") return sessionNameItems(ctx, current);
	return null;
}

/** `/target` — subcommands, or a program path (subcommand wins on the exact word). */
/** `/target` — `save` only, or a saved target profile name to load. */
function targetCompletion(ctx: ReplContext, tokens: string[], pos: number, current: string): AutocompleteItem[] | null {
	if (pos === 0) return targetNameItems(ctx, current);
	const first = tokens[0];
	if (first === "save") return targetNameItems(ctx, current);
	return null;
}

/** Saved target profile names (for `/target switch <name>` etc.). */
function targetNameItems(ctx: ReplContext, current: string): AutocompleteItem[] {
	const items = (ctx.sessions?.targets.list() ?? []).map((t) => ({
		value: t.name,
		label: t.name,
		description: `${t.program ?? (t.kind === "attach" ? `attach pid ${t.pid}` : "")}${t.args.length ? `  ${t.args.join(" ")}` : ""}`.trim(),
	}));
	return fuzzyItems(items, current);
}

/** `/layout` — subcommands (no free-form first token). */
/** `/layout` — `save` only, or a saved layout name to apply. */
function layoutCompletion(ctx: ReplContext, tokens: string[], pos: number, current: string): AutocompleteItem[] | null {
	if (pos === 0) return layoutNameItems(ctx, current);
	const first = tokens[0];
	if (first === "save") return layoutNameItems(ctx, current);
	return null;
}

/** Saved layout profile names (for `/layout switch <name>` etc.). */
function layoutNameItems(ctx: ReplContext, current: string): AutocompleteItem[] {
	const items = (ctx.sessions?.layouts.list() ?? []).map((l) => ({
		value: l.name,
		label: l.name,
		description: `${l.panes} pane(s) · ${l.watchEntries} watch${l.livePaneCount ? ` · ${l.livePaneCount} live` : ""}`,
	}));
	return fuzzyItems(items, current);
}

/** Saved session names (for `/session switch <name>` etc.). */
function sessionNameItems(ctx: ReplContext, current: string): AutocompleteItem[] {
	const items = (ctx.sessions?.list() ?? []).map((s) => ({
		value: s.name,
		label: s.name,
		description: `${s.target ? `${s.target} · ` : ""}${s.layout ? `[${s.layout}] · ` : ""}bp ${s.breakpoints}`.trim(),
	}));
	return fuzzyItems(items, current);
}

/** `/theme` — built-in preset names (one token only). */
function themeCompletion(_ctx: ReplContext, tokens: string[], pos: number, current: string): AutocompleteItem[] | null {
	if (pos === 0) {
		return fuzzyItems(
			THEME_PRESET_NAMES.map((name) => ({
				value: name,
				label: name,
				description: `${THEME_PRESET_MODE[name] ?? ""} palette`.trim(),
			})),
			current,
		);
	}
	return null;
}

// ---------- registry ----------

/**
 * THE slash-command registry — ONLY aidb's own organizing commands.
 * GDB verbs (run, break, step, continue, print, ...) are BARE commands
 * handled by the non-slash dispatcher in repl.ts; they are deliberately NOT
 * offered as slash commands. Their old slash forms still work as invisible
 * aliases in handleSlashCommand, but completion never suggests them, so
 * `/` shows a clean, small menu: the two finders, the three nouns, and a
 * few universal verbs.
 */
const COMMANDS: Cmd[] = [
	{ name: "help", description: "show help", argumentHint: "[topic]" },
	{ name: "session", description: "saved debugger sessions", argumentHint: "[name] | save <name>",
		args: sessionCompletion },
	{ name: "target", description: "saved target profiles", argumentHint: "[name] | save <name>",
		args: targetCompletion },
	{ name: "layout", description: "saved layout profiles", argumentHint: "[name] | save <name>",
		args: layoutCompletion },
	{ name: "open", description: "one finder over sessions · layouts · targets", argumentHint: "" },
	{ name: "theme", description: "built-in theme presets", argumentHint: "[name]",
		args: themeCompletion },
	{ name: "settings", description: "effective configuration", argumentHint: "" },
	{ name: "win", description: "pane management", argumentHint: "<sub> [...]",
		args: winCompletion },
	{ name: "watch", description: "pin an expression to a watch pane", argumentHint: "<expr> | cycle [n] | flag <n> [n] | del <n>" },
	{ name: "config", description: "inspect or reload config", argumentHint: "[reload]" },
	{ name: "new", description: "create a fresh session/target", argumentHint: "[name]" },
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
		// The suggestions render the hint + description in the dropdown's muted
		// `description` role. Tint the `<placeholder>` args (e.g. `<name>`)
		// lighter up front (`restoreMuted` re-opens the muted wrap after each
		// token so a hint's reset can't kill the wrap for the rest of the row),
		// and pre-fuse hint + description so stock doesn't re-concatenate them.
		super(
			cmds.map((c) => ({
				name: c.name,
				...(c.description && {
					description: dimPlaceholders(
						c.argumentHint ? `${c.argumentHint} — ${c.description}` : c.description,
						true,
					),
				}),
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

	/**
	 * Tab on bare (non-slash) text offers file completion only when a path is
	 * actually expected. Stock pi-tui triggers it for ANY bare line — Tab after
	 * `continue` or `print x` would pop up an irrelevant file list. Exceptions:
	 *  - the program-loading verbs (`run`/`file`) take a bare basename in the
	 *    cwd as their first argument;
	 *  - any token already shaped like a path (@file, ./ ../ ~/, absolute, or
	 *    containing a separator) is fair game anywhere.
	 * Slash lines always pass through so the position-aware argument completion
	 * above keeps working (the editor gates Tab with this hook).
	 */
	override shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] ?? "";
		const trimmed = currentLine.slice(0, cursorCol).trimStart();
		if (trimmed.startsWith("/")) return true;
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		const current = trimmed.endsWith(" ") ? "" : (tokens[tokens.length - 1] ?? "");
		if (
			current.startsWith("@") ||
			current.startsWith("./") ||
			current.startsWith("../") ||
			current.startsWith("~/") ||
			current.startsWith("/") ||
			current.includes("/")
		) {
			return true;
		}
		const verb = tokens[0] ?? "";
		return (verb === "run" || verb === "file") && tokens.length === 2 && current !== "";
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