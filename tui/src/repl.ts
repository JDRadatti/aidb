import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { Component } from "@earendil-works/pi-tui";
import type { DebuggerAPI } from "@earendil-works/pi-debugger-core";
import type { WindowManager } from "./window-manager.ts";
import type { SplitDir } from "./split-tree.ts";
import { LivePaneView } from "./views/live-pane.ts";
import { WatchListView } from "./views/watch.ts";
import { AssemblyBinding, InterleavedBinding, MemoryBinding, RegistersBinding, SeriesBinding, SourceBinding, TreeBinding, bindingFromSpec } from "./viz/bindings.ts";
import { INTERPRETERS } from "./viz/interpreters.ts";
import { colors, dimPlaceholders } from "./theme.ts";
import { VIEW_FLAG_META, ViewFlags } from "./viz/types.ts";
import type { Binding, FetchCtx, LivePane } from "./viz/types.ts";
import type { ActivitySpinner } from "./spinner.ts";
import { actionKeyLabel, type Action, type Config, type ConfigSources } from "./config.ts";
import type { LayoutMeta, SessionMeta, SessionLivePane, TargetMeta } from "./session-store.ts";
export type { LayoutMeta, SessionMeta, TargetMeta };
import { openPicker, type PickerItem, relativeTime } from "./picker.ts";
import { renderSettings } from "./views/settings.ts";

/**
 * Session persistence surface supplied by the host (main.ts). Undefined
 * means sessions are disabled (no persisted dir / config knob turned off).
 *
 * The session model: `targets` (what you run), `layouts` (how
 * it's shown), `sessions` (the named binding { target, layout, breakpoints }).
 */
export interface SessionHooks {
	activeName(): string | null;
	list(): SessionMeta[];
	/** Debounced auto-save on any mutation. */
	markDirty(): void;
	/** Force an immediate save under `name` (default: current/active). */
	save(name?: string): Promise<void>;
	setCurrent(name: string): void;
	remove(name: string): Promise<void>;
	/** Start a fresh session under `name` (default: unnamed). */
	startNew(name?: string): Promise<void>;
	/** Restore a session (target ref + layout ref + breakpoints). */
	restore(name: string): Promise<void>;
	targets: TargetHooks;
	layouts: LayoutHooks;
}

/** Named target profiles: the program/args/kind you run. */
export interface TargetHooks {
	/** Name of the active target profile (implied basename when unsaved). */
	current(): string | null;
	list(): TargetMeta[];
	/** Persist the live gdb target as a profile under `name` (default: active). */
	save(name?: string): Promise<void>;
	/** Point gdb at a saved profile (symbols only; never auto-runs). */
	load(name: string): Promise<void>;
	remove(name: string): Promise<void>;
}

/** Named layout profiles: split-tree + watch panes. Explicit save only. */
export interface LayoutHooks {
	/** Name of the active layout profile, or null when none is saved. */
	current(): string | null;
	list(): LayoutMeta[];
	/** Persist the current pane/watch layout as a profile (default: the active one). */
	save(name?: string): Promise<void>;
	/** Restore a layout profile (panes + watch entries). */
	load(name: string): void | Promise<void>;
	remove(name: string): Promise<void>;
}

export interface ReplIO {
	line(text: string): void;
	info(text: string): void;
	success(text: string): void;
	warning(text: string): void;
	error(text: string): void;
}

export interface ReplContext {
	getApi(): DebuggerAPI;
	reset(): Promise<DebuggerAPI>;
	requestExit(): void;
	requestRender(): void;
	io: ReplIO;
	windows: WindowManager;
	spinner?: ActivitySpinner;
	/** Live config; reassigned by `reloadConfig`. */
	config: Config;
	configSources: ConfigSources;
	reloadConfig(): { config: Config; sources: ConfigSources };
	sessions?: SessionHooks;
}

function withActivity<T>(ctx: ReplContext, label: string, operation: () => Promise<T>): Promise<T> {
	return ctx.spinner ? ctx.spinner.run(label, operation) : operation();
}

const HELP = [
	"aidb — GDB-style commands (no slash needed):",
	"  run <program> [args...]    the one start verb: loads + runs the program",
	"  run                        restart the last program (remembers its args)",
	"  attach <pid>                attach to an already-running process",
	"  break <loc> [cond]          set a breakpoint; <loc> is file:line, a line number,",
	"                              or a function name (alias: b)",
	"  info breakpoints            list breakpoints (alias: i b)",
	"  delete [id...]              remove breakpoints, all of them if no ids (alias: d)",
	"  continue                    resume execution (<continue>, alias: c)",
	"  next                        step over (<stepOver>, alias: n)",
	"  step                        step into (<stepInto>, alias: s)",
	"  si                          step one machine instruction (GDB alias: stepi)",
	"  finish                      step out (<stepOut>)",
	"  bt                          backtrace (aliases: backtrace, where)",
	"  print <expr>                evaluate an expression in the current frame (alias: p)",
	"  display <expr>              re-evaluate after every stop (backed by the watch pane);",
	"                              entry number = watch index + 1. bare `display` lists.",
	"  info display                list auto-displays (numbers are undisplay targets)",
	"  undisplay <n>               stop auto-displaying entry n (renumbers, unlike gdb)",
	"  set <var> = <val>           assign in the current frame (uses `set variable` syntax)",
	"  info locals | info args     variables and arguments of the current frame",
	"  set disassembly-flavor intel|att   choose x86 Intel or AT&T syntax",
	"  /win load <pane> iasm      source lines with mapped assembly beneath them",
	"  /watch <expr>               pin an expression to a live watch pane across stops",
	"  /win load <pane> <spec>     bind a live visualizer: regs · mem <expr> [bytes] · plot n · tree s · source · asm",
	"",
	"Windows (manual): /win vsplit [idx] [name] | hsplit [idx] [name] | close <idx|name> | swap <a> [b] | next | list;",
	"  /win pick [idx] [view] swaps how a live pane renders; /win switch <idx|name> focuses a pane.",
	"",
	"Anything else is passed to GDB verbatim: info registers, x/4xw, disassemble, pwd, ...",
	"Relative paths resolve against the directory aidb was started in; Tab completes file paths.",
	"",
	"Saved things — one grammar for all three:",
	"  /session /target /layout (bare)   open a fuzzy picker: pick one to open; type a",
	"                                    new name + Enter to save the current state;",
	"                                    ctrl+d delete · ctrl+r rename.",
	"  /session <name> /target <name> /layout <name>   act on that one directly.",
	"  /open (Alt-O) · `>`               one combined finder over sessions · layouts · targets.",
	"  /settings                         effective config (theme, gdb, keys, sessions).",
	"  /config reload                    re-read ~/.aidbrc + ./.aidb.json.",
	"  terminology: a session = one debugging goal { target + layout + breakpoints };",
	"  targets/layouts are shared profiles; everything saved lives on disk.",
	"  slash commands: /help · /open · /settings · /session · /target · /layout · /win · /config · /watch · /new · /quit",
	"History: Ctrl+P / Ctrl+N, or Up/Down on an empty prompt. Enter on an empty prompt repeats the last command — keep pressing Enter to step. Commands that make no sense to repeat (run, quit, /new, switching sessions/layouts/targets, /win or /watch mutations) are not repeated. Topic help: help <topic> (e.g. help win).",
	"Scroll: Ctrl+Up/Ctrl+Down (or PgUp/PgDn) scroll the active pane; Home/End",
].join("\n");

const WIN_HELP = [
	"Windows — panes addressed by index, driven entirely from the prompt:",
	"",
	"  The prompt always works; panes never capture keys. Every pane shows its",
	"  index as a giant numeral and its own background color; titles read",
	"  'idx name' with * marking the active pane (the default split target).",
	"",
	"  /win vsplit [idx] [name]                    split a pane into columns",
	"                                              (default: active pane); the new",
	"                                              pane appears to the right",
	"  /win hsplit [idx] [name]                    split a pane into rows; new pane",
	"                                              appears below",
	"  /win close <idx|name>                       close that pane (the repl refuses)",
	"  /win next                                   make the next pane active",
	"  /win switch <idx|name>                      make that pane active",
	"  /win swap <idx|name> [idx|name]             exchange two panes' cells (content",
	"                                              follows the pane, weights stay); one",
	"                                              ref swaps the active pane with it",
	"  /win list                                   print idx -> id mapping (indices",
	"                                              shift on close!)",
	"  /watch <expr>                               pin an expression to a live watch",
	"                                              pane (auto-creates 'watch')",
	"  /watch list | cycle [n] | flag <name> [n] | del <n>   manage watch entries:",
	"                                              cycle the renderer or toggle a flag on",
	"                                              entry n (default: the last added)",
	"  /win load <idx|name> <what>                 bind a view into a pane:",
	"                                              watch · regs · mem <expr> · plot <expr>",
	"                                              · tree <expr> · source · asm",
	"                                              mem suffix is raw byte count (default 192),",
	"                                              not tuples — e.g. mem frame 12 = 12 bytes",
	"                                              watch mounts a live watch pane; /watch adds entries",
	"  /win pick [idx|name] [view|+flag]           list interpreters, or swap one in place;",
	"                                              toggle a render flag with /win pick <ref> +flag",
	"",
	"Notes:",
	"  - Indices are positions in /win list order, not permanent ids. Name panes",
	"    on creation (/win vsplit 0 mem) and address them by name instead.",
	"  - Names starting with 'watch' mount a live watch view instead of a blank",
	"  - Max 3 columns x 3 rows; splits beyond that are rejected.",
	"  - Planned: tmux-style leader keys (e.g. Ctrl+a then key) once the",
	"    mechanics here are proven — see windows-plan.html.",
].join("\n");

/**
 * `help` prints the general sheet; `help <topic>` digs into one area.
 * Action keys are filled in from the live config so remaps stay true.
 */
function showHelp(topic: string | undefined, io: ReplIO, actions: Config["keybindings"]["actions"]): void {
	const normalized = topic?.trim().toLowerCase();
	if (normalized === "win" || normalized === "window" || normalized === "windows") {
		io.line(dimPlaceholders(WIN_HELP));
	} else if (normalized) {
		io.error(`No help topic '${topic}'. Topics: win`);
	} else {
		io.line(dimPlaceholders(fillKeys(HELP, actions)));
	}
}

/** Substitute `<action>` key tokens (continue/step/scroll/open only) with the
 * configured chord labels. Arg placeholders (`<expr>`, `<name>`, ...) are NOT
 * actions and must survive untouched so dimPlaceholders can tint them —
 * before this, `<expr>` etc. were silently replaced with "—". */
function fillKeys(sheet: string, actions: Config["keybindings"]["actions"]): string {
	return sheet.replace(/<(\w+)>/g, (token, name: string) =>
		Object.hasOwn(actions, name) ? actionKeyLabel(actions, name as Action) : token,
	);
}

/**
 * Last program launched, so bare `run` can restart it.
 */
let lastLaunch: { program: string; args: string[] } | null = null;

/**
 * Empty-Enter replay buffer (GDB's "blank Enter repeats last command").
 * Session-local on purpose: the persisted history spans runs, and replaying
 * yesterday's `close 1` against today's layout would be harmful. Set on every
 * non-empty submission (win or lose) and on picker-executed actions; cleared
 * on picker cancel, key-driven actions that don't feed a replay, and `/new`.
 */
let lastReplay: string | null = null;
/** Overwrite the replay buffer (used by picker echoes and keybinding actions). */
export function setLastReplay(line: string): void {
	const trimmed = line.trim();
	lastReplay = trimmed ? trimmed : null;
}
/** Drop the replay buffer (picker cancel, non-command key actions). */
export function clearLastReplay(): void {
	lastReplay = null;
}

/** Read the current target, so the session snapshot can persist it. */
export function getLastLaunch(): { program: string; args: string[] } | null {
	return lastLaunch;
}
/** Set the current target (after `file`/`run`); used by session restore. */
export function setLastLaunch(value: { program: string; args: string[] } | null): void {
	lastLaunch = value ? { program: value.program, args: [...value.args] } : null;
}

/**
 * GDB inherits aidb's working directory, so a relative `./app` only resolves
 * if you started aidb from the right place. Resolve everything to an absolute
 * path up front and show it, so "file not found" is never mysterious.
 */
function resolveProgram(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return path.resolve(process.cwd(), p);
}

function sourcePathKey(file: string): string {
	try {
		const pathValue = file.startsWith("file://") ? decodeURIComponent(new URL(file).pathname) : file;
		return path.normalize(path.resolve(pathValue));
	} catch {
		return path.normalize(file);
	}
}

function cwdHint(io: ReplIO): void {
	io.info(`Relative paths are resolved against: ${process.cwd()} — use an absolute path, or Tab-complete, if that's not where your binary lives.`);
}

/**
 * Live watch panes: names starting with "watch" mount a WatchListView instead
 * of a blank slab. Expressions come from /watch since panes never take keys.
 */
function makeWatchView(ctx: ReplContext, id: string): WatchListView {
	return new WatchListView(makeFetchCtx(ctx), { id, onChange: () => ctx.requestRender() });
}
/** Re-export so the host (main.ts) can re-mount watch panes on session restore. */
export { makeWatchView };

/**
 * Rebuild a live pane (source/asm/regs/mem/plot/tree/iasm) from a layout's
 * saved spec. Mirrors the `/win load` construction so restored panes behave
 * identically: same binding params, interpreter and render flags.
 */
export function makeLivePaneView(ctx: ReplContext, id: string, saved: SessionLivePane): LivePaneView {
	return new LivePaneView(bindingFromSpec(saved.spec), saved.interpreterId, makeFetchCtx(ctx), {
		id,
		onChange: () => ctx.requestRender(),
	}, saved.flags);
}

/** The first unused id in the series "watch", "watch2", "watch3", ... */
export function nextWatchId(windows: WindowManager): string {
	const taken = new Set(windows.list().map((p) => p.id));
	if (!taken.has("watch")) return "watch";
	for (let i = 2; ; i++) {
		if (!taken.has(`watch${i}`)) return `watch${i}`;
	}
}

/** Find an existing live watch pane by id, or undefined. */
function findWatchView(windows: WindowManager): { id: string; view: WatchListView } | undefined {
	for (const pane of windows.list()) {
		const view = windows.component(pane.id);
		if (view instanceof WatchListView) return { id: pane.id, view };
	}
	return undefined;
}

/** Find the live watch pane, creating + mounting one when missing. Shared by
 * `/watch <expr>` and gdb's `display`. Returns pane id + view, or the split's
 * refusal error (both call sites give the user the /win hsplit watch path). */
type EnsureWatchResult = { ok: true; id: string; view: WatchListView } | { ok: false; error: string };
function ensureWatchView(ctx: ReplContext): EnsureWatchResult {
	const found = findWatchView(ctx.windows);
	if (found) return { ok: true, id: found.id, view: found.view };
	const id = nextWatchId(ctx.windows);
	const previous = ctx.windows.active;
	const result = ctx.windows.split("v", undefined, id);
	if (!result.ok) return { ok: false, error: result.error };
	const createdId = result.value;
	ctx.windows.mount(createdId, makeWatchView(ctx, createdId));
	ctx.windows.switchTo(previous);
	const again = findWatchView(ctx.windows);
	if (!again) return { ok: false, error: "split did not mount the watch pane" };
	return { ok: true, id: again.id, view: again.view };
}

/**
 * Structural guard for anything that wants re-evaluation after every stop —
 * watch lists and viz panes alike. No name-prefix sniffing.
 */
export function isLivePane(component: Component | undefined): component is Component & LivePane {
	return typeof (component as Partial<LivePane> | undefined)?.refreshAll === "function";
}

/**
 * Re-run every binding in every live pane. Called whenever the target stops —
 * the equivalent of gdb refreshing `display` expressions.
 */
export function refreshLivePanes(ctx: ReplContext, advance = false): void {
	for (const pane of ctx.windows.list()) {
		const view = ctx.windows.component(pane.id);
		if (isLivePane(view)) void view.refreshAll(advance);
	}
}

/** Reset run-local state while preserving mounted pane definitions. */
export function resetLivePanes(ctx: ReplContext): void {
	for (const pane of ctx.windows.list()) {
		const view = ctx.windows.component(pane.id);
		if (isLivePane(view)) view.reset?.();
	}
}

/** `/win load` mini-syntax → a binding paired with its default interpreter. */
export function parseLoadSpec(spec: string, ctx?: ReplContext): { binding: Binding; interpreterId: string } | undefined {
	const match = /^(\S+)(?:\s+(.+))?$/.exec(spec.trim());
	if (!match) return undefined;
	const keyword = match[1];
	const argument = match[2];
	switch (keyword) {
		case "regs":
			if (argument) return undefined;
			return { binding: new RegistersBinding(), interpreterId: "table" };
		case "mem":
			if (!argument) return undefined;
			return parseMemLoadSpec(argument);
		case "plot":
			if (!argument) return undefined;
			return { binding: new SeriesBinding(argument), interpreterId: "sparkline" };
		case "tree":
			if (!argument) return undefined;
			return { binding: new TreeBinding(argument), interpreterId: "struct-tree" };
		case "source":
		case "src":
			if (argument) return undefined;
			return { binding: new SourceBinding(), interpreterId: "code" };
		case "asm":
		case "disasm":
			if (argument) return undefined;
			return { binding: new AssemblyBinding(), interpreterId: "code" };
		case "iasm":
		case "interleave":
			if (argument) return undefined;
			return { binding: new InterleavedBinding(), interpreterId: "iasm" };
		default:
			return undefined;
	}
}

/** `mem frame`, `mem frame 48` (bytes), or `mem buf + 4` → binding + default hexdump. */
function parseMemLoadSpec(argument: string): { binding: Binding; interpreterId: string } {
	const parts = argument.trim().split(/\s+/);
	let byteCount = 192;
	let expr = argument.trim();
	const last = parts.at(-1);
	if (parts.length > 1 && last && /^\d+$/.test(last)) {
		const candidate = parts.slice(0, -1).join(" ");
		// Avoid treating address arithmetic (`buf + 4`) as a byte-count suffix.
		if (!/[+\-*/&]/.test(candidate)) {
			byteCount = Number.parseInt(last, 10);
			expr = candidate;
		}
	}
	return { binding: new MemoryBinding(expr, byteCount), interpreterId: "hexdump" };
}

/** Resolve a `/win pick +<name>` flag name to its ViewFlags bit. */
function flagBit(name: string): ViewFlags | undefined {
	for (const [raw, meta] of Object.entries(VIEW_FLAG_META)) {
		if (meta.name === name) {
			const value = Number(raw);
			return Number.isInteger(value) && Number.isFinite(value) ? value : undefined;
		}
	}
	return undefined;
}

/**
 * Hosts the bindings' FetchCtx over DebuggerAPI. The api handle is fetched
 * per call so sessions replaced by `reset` are picked up transparently.
 * Core Variables are mapped to VarNodes here so the viz layer never imports
 * debugger types.
 */

/** Split-once file cache for `readSource`: a whole file is read and split
 * on the FIRST fetch, then every later window (step, scroll, viewport change)
 * slices the cached lines instead of re-reading + re-splitting the file each
 * stop. Bounded LRU; a file edited mid-session keeps its start-of-session
 * view, which matches the short-lived debugging session model. */
const SOURCE_LINES_CACHE = new Map<string, string[]>();
const MAX_SOURCE_FILES = 16;

function cachedFileLines(file: string): Promise<string[]> {
	const hit = SOURCE_LINES_CACHE.get(file);
	if (hit) return Promise.resolve(hit);
	return readFile(file, "utf8").then((source) => {
		const lines = source.split(/\r?\n/);
		if (SOURCE_LINES_CACHE.size >= MAX_SOURCE_FILES) {
			const oldest = SOURCE_LINES_CACHE.keys().next().value;
			if (oldest !== undefined) SOURCE_LINES_CACHE.delete(oldest);
		}
		SOURCE_LINES_CACHE.set(file, lines);
		return lines;
	});
}

function makeFetchCtx(ctx: ReplContext): FetchCtx {
	return {
		evaluate: (expression, context) => ctx.getApi().evaluate(expression, context ?? "watch"),
		evaluateDetailed: (expression) => ctx.getApi().evaluateDetailed(expression),
		getLocation: () => ({ file: ctx.getApi().sourceFile, line: ctx.getApi().currentLine }),
		getBreakpoints: () => {
			const source = ctx.getApi().sourceFile;
			if (!source) return [];
			return Array.from(ctx.getApi().breakpoints.values())
				.map(({ file, line, verified, condition }) => ({ file, line, verified, condition }))
				.filter((breakpoint) => breakpoint.file && sourcePathKey(breakpoint.file) === sourcePathKey(source));
		},
		readSource: async (file, startLine, count) => {
			const lines = await cachedFileLines(file);
			return lines.slice(Math.max(0, startLine - 1), Math.max(0, startLine - 1) + count);
		},
		getVariableChildren: async (reference, start, count) => {
			const children = await ctx.getApi().getVariableChildren(reference, start, count);
			return children.map((child) => ({
				name: child.name,
				value: child.value,
				type: child.type || undefined,
				evaluateName: child.evaluateName,
				memoryReference: child.memoryReference,
				variablesReference: child.variablesReference,
				namedVariables: child.namedVariables,
				indexedVariables: child.indexedVariables,
				presentationHint: child.presentationHint,
				hasChildren: child.variablesReference > 0,
				ref: child.variablesReference > 0 ? child.variablesReference : undefined,
			}));
		},
		readMemory: (expression, count, offset) => ctx.getApi().readMemory(expression, count, offset),
		disassemble: (memoryReference, instructionCount) => ctx.getApi().disassemble(memoryReference, instructionCount),
	};
}

function requireStopped(api: DebuggerAPI, io: ReplIO): boolean {
	const state = api.getState();
	if (state === "stopped") return true;
	if (state === "running") {
		io.error("Program is running. Wait for it to stop first (breakpoint, step, or exit).");
	} else {
		io.error(`No stopped target (state: ${state}). Start one with: run <program>`);
	}
	return false;
}

function runningBlocked(api: DebuggerAPI, io: ReplIO): boolean {
	if (api.getState() === "running") {
		io.error("Program is running. Wait for it to stop before running this.");
		return true;
	}
	return false;
}


async function passthrough(input: string, ctx: ReplContext): Promise<void> {
	const { getApi, io } = ctx;
	const api = getApi();
	if (runningBlocked(api, io)) return;
	const result = await withActivity(ctx, "evaluating", () => api.evaluate(input, "repl"));
	if (result !== undefined && result !== "") {
		io.line(String(result));
	}
}

/**
 * GDB treats `set frame` as the frame-filter subcommand, not an array write.
 * Rewrite `set lhs = rhs` to `set variable lhs=rhs`.
 */
async function handleSet(args: string, ctx: ReplContext): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed) {
		await passthrough("set", ctx);
		return;
	}
	const assign = /^(.+?)\s*=\s*(.+)$/.exec(trimmed);
	if (assign) {
		const lhs = assign[1]!.trim();
		const rhs = assign[2]!.trim();
		await passthrough(`set variable ${lhs}=${rhs}`, ctx);
		return;
	}
	await passthrough(`set ${trimmed}`, ctx);
}

/**
 * Launch (or relaunch) the target. The core keeps a single GDB process per
 * session and re-running `launch` restarts the program while preserving
 * breakpoints — matching GDB's own `run` semantics.
 */
async function startTarget(program: string, args: string[], ctx: ReplContext): Promise<DebuggerAPI> {
	const api = ctx.getApi();
	const absolute = resolveProgram(program);
	ctx.io.info(`Starting ${[absolute, ...args].join(" ")}...`);
	try {
		await withActivity(ctx, `launching ${path.basename(absolute)}`, () => api.launch(absolute, args));
	} catch (error) {
		ctx.io.error(error instanceof Error ? error.message : String(error));
		cwdHint(ctx.io);
		return api;
	}
	setLastLaunch({ program: absolute, args });
	ctx.sessions?.markDirty();
	if (api.breakpoints.size === 0) {
		ctx.io.warning(`No breakpoints in ${absolute} — it will run straight through to exit.`);
		ctx.io.info("Tip: break <file:line> first, then run again to inspect state.");
	} else {
		ctx.io.success(`Running — waiting for breakpoint hit...`);
	}
	return api;
}

/**
 * gdb-style `file <program>`: kept as a hidden alias for the one start verb
 * `run` (GDB muscle memory); completion never suggests it. `file` alone
 * restarts the last program like bare `run`.
 */

async function handleFile(args: string, ctx: ReplContext): Promise<void> {
	await handleRun(args, ctx);
}

async function handleRun(args: string, ctx: ReplContext): Promise<void> {
	const words = args.split(/\s+/).filter(Boolean);
	if (words.length > 0) {
		await startTarget(words[0], words.slice(1), ctx);
		return;
	}
	if (!lastLaunch) {
		ctx.io.error("No program loaded yet. Usage: run <program> [args...]");
		return;
	}
	await startTarget(lastLaunch.program, lastLaunch.args, ctx);
}

/**
 * Breakpoint locations:
 *   break file.c:12 [if cond]   -> structured DAP breakpoint
 *   break 12 [if cond]          -> line in the current source file
 *   break main                  -> handled natively by GDB
 */
function normalizeCondition(cond?: string): string | undefined {
	if (!cond) return undefined;
	return cond.replace(/^if\s+/, "");
}

async function handleBreak(argStr: string, api: DebuggerAPI, io: ReplIO): Promise<void> {
	const match = argStr.match(/^(?:(\S+?):(\d+)|(\d+))(?:\s+(.+))?$/);
	if (!match) {
		if (!argStr) {
			io.error("Usage: break <file:line | line | function> [if condition]");
			return;
		}
		// Function-name form: GDB resolves it natively. Track the created
		// breakpoint so the count, `info breakpoints` and `delete` stay honest.
		const result = await api.evaluate(`break ${argStr}`, "repl");
		const text = String(result ?? "").replace(/\x1b\[[0-9;]*m/g, "");
		if (text) io.line(text);
		const created = text.match(/Breakpoint (\d+)/);
		if (created) {
			const resolved = text.match(/\bfile\s+(.+?)[,:]\s*line\s+(\d+)/);
			const file = resolved?.[1] ? resolveProgram(resolved[1].trim()) : undefined;
			const line = resolved?.[2] ? Number.parseInt(resolved[2], 10) : undefined;
			api.trackExternalBreakpoint(Number(created[1]), argStr, file, line);
		}
		return;
	}

	const file = match[1] ?? api.sourceFile;
	const line = Number.parseInt(match[2] ?? match[3]!, 10);
	if (!file) {
		io.error("No source file loaded yet. Use: break <file>:<line>");
		return;
	}
	const bp = await api.setBreakpoint(file, line, normalizeCondition(match[4]));
	io.success(
		bp.verified
			? `Breakpoint ${bp.id} at ${bp.file}:${bp.line}`
			: `Breakpoint ${bp.id} pending at ${bp.file}:${bp.line}`,
	);
}

async function handleDelete(ids: string[], api: DebuggerAPI, io: ReplIO): Promise<void> {
	const parsed = ids.map(Number).filter((n) => !Number.isNaN(n));
	if (parsed.length > 0) {
		for (const id of parsed) await api.removeBreakpoint(id);
		io.success(`Deleted breakpoint(s) ${parsed.join(", ")}`);
		return;
	}
	const bps = await api.listBreakpoints();
	if (bps.length === 0) {
		io.info("No breakpoints.");
		return;
	}
	for (const bp of bps) await api.removeBreakpoint(bp.id);
	io.success(`Deleted ${bps.length} breakpoint(s)`);
}

async function printLocals(api: DebuggerAPI, io: ReplIO, scope: "local" | "args"): Promise<void> {
	if (!requireStopped(api, io)) return;
	const vars = await api.getVariables(scope);
	if (vars.length === 0) {
		io.info(scope === "args" ? "No arguments." : "No locals.");
		return;
	}
	for (const v of vars) {
		io.line(`${v.name} = ${v.value}`);
	}
}

async function printBreakpoints(api: DebuggerAPI, io: ReplIO): Promise<void> {
	const bps = await api.listBreakpoints();
	if (bps.length === 0) {
		io.info("No breakpoints.");
		return;
	}
	for (const bp of bps) {
		const where = bp.location ?? `${bp.file}:${bp.line}`;
		io.line(`${bp.id}\t${where}${bp.condition ? ` if ${bp.condition}` : ""}${bp.verified ? "" : " (pending)"}`);
	}
}

async function printStack(api: DebuggerAPI, io: ReplIO): Promise<void> {
	if (!requireStopped(api, io)) return;
	const frames = await api.getStack();
	frames.forEach((frame, i) => {
		io.line(`#${i} ${frame.name} at ${frame.file || "?"}:${frame.line}`);
	});
}

/**
 * Handle `info` with structured output for the useful subcommands;
 * everything else goes to GDB verbatim.
 */
async function handleInfo(subcommand: string, input: string, ctx: ReplContext): Promise<void> {
	const api = ctx.getApi();
	const { io } = ctx;
	switch (subcommand) {
		case "locals":
		case "local":
			await printLocals(api, io, "local");
			break;
		case "args":
			await printLocals(api, io, "args");
			break;
		case "breakpoints":
		case "break":
			await printBreakpoints(api, io);
			break;
		case "display":
			// gdb `info display` lists the auto-displays (watch-pane entries).
			await handleWatch("list", ctx);
			break;
		default:
			await passthrough(input, ctx);
	}
}

const ALIASES: Record<string, string> = {
	r: "run",
	b: "break",
	d: "delete",
	c: "continue",
	n: "next",
	s: "step",
	"si": "stepi",
	f: "finish",
	i: "info",
	p: "print",
	bt: "backtrace",
	where: "backtrace",
	q: "quit",
	h: "help",
};

/**
 * Bare GDB-style commands (no slash).
 */
async function handleGdbCommand(input: string, ctx: ReplContext): Promise<void> {
	const words = input.split(/\s+/);
	let command = words[0];
	const rest = words.slice(1);
	const args = rest.join(" ");
	const io = ctx.io;
	let api = ctx.getApi();

	command = ALIASES[command] ?? command;

	switch (command) {
		case "file":
			await handleFile(args, ctx);
			break;

		case "run":
			await handleRun(args, ctx);
			break;

		case "break":
			await handleBreak(args, api, io);
			break;

		case "delete":
			await handleDelete(rest, api, io);
			break;

		case "continue":
			if (requireStopped(api, io)) await withActivity(ctx, "continuing", () => api.continue());
			break;

		case "next":
			if (requireStopped(api, io)) await withActivity(ctx, "stepping over", () => api.stepOver());
			break;

		case "step":
			if (requireStopped(api, io)) await withActivity(ctx, "stepping into", () => api.stepInto());
			break;

		case "stepi":
			if (requireStopped(api, io)) await withActivity(ctx, "stepping instruction", () => api.evaluate("si", "repl"));
			break;

		case "finish":
			if (requireStopped(api, io)) await withActivity(ctx, "stepping out", () => api.stepOut());
			break;

		case "info":
			await handleInfo(rest[0] ?? "", input, ctx);
			break;

		case "backtrace":
		case "print":
			await passthrough(input, ctx);
			break;

		case "display":
			await handleDisplay(args, ctx);
			break;

		case "undisplay":
			await handleUndisplay(args, ctx);
			break;

		case "set":
			if (requireStopped(api, io)) await handleSet(args, ctx);
			break;

		case "attach": {
			const pid = Number.parseInt(rest[0] ?? "", 10);
			if (Number.isNaN(pid)) {
				io.error("Usage: attach <pid>");
				return;
			}
			io.info(`Attaching to ${pid}...`);
			await withActivity(ctx, `attaching to pid ${pid}`, () => api.attach(pid));
			io.success(`Attached to ${pid}`);
			break;
		}

		case "detach":
			await api.detach();
			io.success("Detached.");
			break;

		case "quit":
			io.info("Shutting down...");
			ctx.requestExit();
			break;

		case "help":
			showHelp(args, io, ctx.config.keybindings.actions);
			break;

		case "status":
		case "locals":
		case "stack":
			io.error(`'${command}' needs its slash form: /${command} ...`);
			break;

		default:
			await passthrough(input, ctx);
	}
}

/**
 * `/win` — pane management, all explicit: splits act on the pane at the given
 * index (default: active), closes and switches take an index or a name.
 */
async function handleWin(args: string, ctx: ReplContext): Promise<void> {
	const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
	const windows = ctx.windows;
	const io = ctx.io;
	switch (sub) {
		case "vsplit":
		case "hsplit": {
			// Accept "[idx] [name]" in either order; extra words are a typo.
			let idx: number | undefined;
			let name: string | undefined;
			for (const word of rest) {
				if (idx === undefined && /^\d+$/.test(word)) idx = Number.parseInt(word, 10);
				else if (name === undefined) name = word;
				else {
					io.error(`Usage: /win ${sub} [idx] [name]`);
					return;
				}
			}
			const dir: SplitDir = sub === "vsplit" ? "v" : "h";
			const result = windows.split(dir, idx, name);
			if (!result.ok) {
				io.error(result.error);
				return;
			}
			if (name?.startsWith("watch")) {
				windows.mount(result.value, makeWatchView(ctx, result.value));
				io.success(`Created '${result.value}' — a live watch pane. /watch <expr> adds expressions.`);
			} else {
				io.success(`Created '${result.value}' — /win list shows indices.`);
			}
			return;
		}
		case "close": {
			if (rest[0] === undefined || rest.length > 1) {
				io.error("Usage: /win close <idx|name>");
				return;
			}
			const result = windows.close(rest[0]);
			if (result.ok) io.info(`Closed '${rest[0]}' — now: ${windows.list().map((p) => p.id).join(", ")}`);
			else io.error(result.error);
			return;
		}
		case "next": {
			io.info(`Active pane: ${windows.cycle()}`);
			return;
		}
		case "switch": {
			const ref = rest[0];
			if (ref === undefined) {
				openPanePicker(ctx);
				return;
			}
			if (rest.length > 1) {
				io.error("Usage: /win switch <idx|name> — /win list shows indices");
				return;
			}
			if (!windows.switchTo(ref)) {
				io.error(/^\d+$/.test(ref) ? `No pane at index ${ref}. /win list shows indices.` : `No pane named '${ref}'.`);
				return;
			}
			io.info(`Active pane: ${windows.active}`);
			return;
		}
		case "swap": {
			if (rest.length === 0 || rest.length > 2) {
				io.error("Usage: /win swap <idx|name> [idx|name] — one ref swaps the active pane");
				return;
			}
			const result = windows.swap(rest[0]!, rest[1]);
			if (!result.ok) {
				io.error(result.error);
				return;
			}
			const other = rest[1] === undefined ? windows.active : rest[1]!;
			io.success(`'${rest[0]}' and '${other}' exchanged places — active: ${windows.active}`);
			return;
		}
		case "list": {
			for (const pane of windows.list()) {
				io.line(`${pane.idx}\t${pane.id}${pane.active ? " *" : ""}`);
			}
			return;
		}
		case "load": {
			if (rest.length < 2) {
				io.error("Usage: /win load <idx|name> watch | regs | mem <expr> | plot <expr> | tree <expr> | source | asm");
				return;
			}
			const target = windows.resolve(rest[0]);
			if (!target) {
				io.error(/^\d+$/.test(rest[0]) ? `No pane at index ${rest[0]}. /win list shows indices.` : `No pane named '${rest[0]}'.`);
				return;
			}
			if (target === "repl") {
				io.error("'repl' hosts the transcript — split first: /win vsplit live");
				return;
			}
			// A lone `watch` binds a live watch window (WatchListView) into the
			// pane, converting it in place — same content a `watch`-named split
			// or /watch auto-creation would mount.
			const specWords = rest.slice(1);
			if ((specWords[0] ?? "") === "watch" && specWords.length === 1) {
				windows.mount(target, makeWatchView(ctx, target));
				windows.switchTo(target);
				io.success(`Bound '${target}' to a live watch pane. /watch <expr> adds expressions.`);
				return;
			}
			const parsed = parseLoadSpec(specWords.join(" "), ctx);
			if (!parsed) {
				io.error("Cannot visualize " + JSON.stringify(specWords.join(" ")) + `. Try: watch · regs · mem <expr> · plot <expr> · tree <expr> · source · asm`);
				return;
			}
			const view = new LivePaneView(parsed.binding, parsed.interpreterId, makeFetchCtx(ctx), {
				id: target,
				onChange: () => ctx.requestRender(),
			});
			windows.mount(target, view);
			windows.switchTo(target);
			void view.refreshAll();
			io.success(`Bound '${target}' to ${parsed.binding.describe()} (${parsed.interpreterId}).`);
			return;
		}
		case "pick": {
			let ref: string | undefined;
			let interpreterId: string | undefined;
			let flagName: string | undefined;
			for (const word of rest) {
				if (INTERPRETERS[word]) interpreterId = word;
				else if (word.startsWith("+") && flagName === undefined && flagBit(word.slice(1)) !== undefined) flagName = word.slice(1);
				else if (ref === undefined) ref = word;
				else {
					io.error(`Usage: /win pick [idx|name] [${Object.keys(INTERPRETERS).join("|")}] [+flag]`);
					return;
				}
			}
			if (interpreterId === undefined && flagName === undefined) {
				const current = ref === undefined ? undefined : windows.component(windows.resolve(ref) ?? "");
				io.line("Interpreters:");
				for (const { id, title } of Object.values(INTERPRETERS)) {
					const marker = current instanceof LivePaneView && current.getInterpreterId() === id ? " *" : "";
					io.line(`  ${(id + marker).padEnd(15)} ${title}`);
				}
				io.line("Flags:");
				for (const { name, description } of Object.values(VIEW_FLAG_META)) io.line(`  +${name}  ${description}`);
				io.info("Swap one: /win pick <idx|name> <interpreter>; toggle: /win pick <idx|name> +flag");
				return;
			}
			const target = windows.resolve(ref ?? windows.active);
			if (!target) {
				io.error(/^\d+$/.test(ref ?? "") ? `No pane at index ${ref}.` : ref ? `No pane named '${ref}'.` : "No pane to pick on.");
				return;
			}
			const component = windows.component(target);
			if (!(component instanceof LivePaneView)) {
				io.error(`Pane '${target}' is not a live pane. Bind one first: /win load ${target} regs`);
				return;
			}
			if (flagName !== undefined) {
				const bit = flagBit(flagName)!;
				component.toggleFlag(bit);
				ctx.requestRender();
				io.success(`'${target}' ${VIEW_FLAG_META[bit]!.description}`);
				return;
			}
			if (interpreterId === undefined) {
				io.error("Nothing to pick: specify an interpreter or a +flag.");
				return;
			}
			component.setInterpreter(interpreterId);
			windows.switchTo(target);
			ctx.requestRender();
			io.success(`'${target}' now renders with ${interpreterId} (${INTERPRETERS[interpreterId]!.title}).`);
			return;
		}
		default:
			io.error(
				`Usage: /win vsplit|hsplit [idx] [name] | load <idx|name> <spec> | pick [idx|name] [view] | switch <idx|name> | swap <idx|name> [idx|name] | close <idx|name> | next | list — 'help win' for details.`,
			);
	}
}

/**
 * Management subcommands for the live watch pane. The editor owns the keys,
 * so watch entry actions are commands (same model as /watch <expr> adding).
 * Anything that isn't a reserved subcommand is treated as an expression to add.
 */
async function handleWatch(args: string, ctx: ReplContext): Promise<void> {
	const io = ctx.io;
	const sub = args.trim();
	const rest = sub.split(/\s+/);
	let found = findWatchView(ctx.windows);

	// `list` or bare `/watch` → show the current entries and their renderers.
	if (rest[0] === "list" || sub === "") {
		if (!found) {
			io.info("No watch pane yet. Use /watch <expr> to create one.");
			return;
		}
		const entries = found.view.getEntries();
		if (entries.length === 0) {
			io.line(`${found.id}: <empty>`);
			return;
		}
		io.line(`${found.id}:`);
		entries.forEach((entry, index) => {
			const flags = entry.renderSpec.flags ?? 0;
			const flagNames = Object.entries(VIEW_FLAG_META)
				.filter(([, meta]) => meta.name !== "none" && (flags & Number(flagBit(meta.name)!)) !== 0)
				.map(([, meta]) => meta.name)
				.join("|");
			io.line(`  ${index}. ${entry.renderSpec.rendererId.padEnd(12)} ${entry.expr}${flagNames ? `  +${flagNames}` : ""}`);
		});
		io.info("cycle: /watch cycle [n] · flags: /watch flag <name> [n] · delete: /watch del <n>");
		return;
	}

	if (!found) {
		const created = ensureWatchView(ctx);
		if (!created.ok) {
			io.error(`${created.error} — create a pane first: /win hsplit watch`);
			return;
		}
		found = created;
		io.info(`Created live watch pane '${created.id}'.`);
	}
	if (!found) return;
	const view = found.view;

	if (rest[0] === "cycle") {
		const index = resolveIndex(rest[1]) ?? view.getEntries().length - 1;
		if (index >= view.getEntries().length) {
			io.error("Watch entry index out of range.");
			return;
		}
		view.cycleRendererAt(index);
		ctx.requestRender();
		io.success(entrySummary(view, index));
		return;
	}
	if (rest[0] === "flag") {
		const bit = flagBit(rest[1] ?? "");
		if (bit === undefined) {
			io.error("Usage: /watch flag <name> [n] — names: " + Object.values(VIEW_FLAG_META).map((m) => m.name).join(", "));
			return;
		}
		const index = resolveIndex(rest[2]) ?? view.getEntries().length - 1;
		if (index >= view.getEntries().length) {
			io.error("Watch entry index out of range.");
			return;
		}
		view.toggleFlagAt(index, bit);
		ctx.requestRender();
		io.success(`${entrySummary(view, index)} · ${VIEW_FLAG_META[bit]!.name}`);
		return;
	}
	if (rest[0] === "del") {
		const index = resolveIndex(rest[1]);
		if (index === undefined || index >= view.getEntries().length) {
			io.error("Usage: /watch del <n> — a valid entry index");
			return;
		}
		const removed = view.getEntries()[index]!.expr;
		view.removeAt(index);
		ctx.requestRender();
		io.success(`Stopped watching ${removed}.`);
		return;
	}

	// Otherwise it's an expression to add.
	if (!sub) {
		io.error("Usage: /watch <expr> | list | cycle [n] | flag <name> [n] | del <n>");
		return;
	}
	view.add(sub);
	ctx.requestRender();
	io.success(`Watching ${sub}.`);
}

/**
 * gdb `display` — re-evaluate an expression after EVERY stop. Backed by the
 * watch pane: entries re-fetch on each stop (refreshLivePanes is "the
 * equivalent of gdb refreshing display expressions"), so `display x` is
 * "watch x forever". Numbering is the watch entry index + 1 (undisplay
 * renumbers, unlike gdb's persistent slots — noted in help).
 * gdb format displays (`display /x *p`) can't be represented in the pane;
 * they pass through to gdb's own display list.
 */
async function handleDisplay(args: string, ctx: ReplContext): Promise<void> {
	const io = ctx.io;
	const expr = args.trim();
	if (expr === "") {
		// bare `display` lists the auto-displays (gdb parity).
		await handleWatch("list", ctx);
		return;
	}
	if (expr.startsWith("/")) {
		await passthrough(`display ${args.trim()}`, ctx);
		return;
	}
	const created = ensureWatchView(ctx);
	if (!created.ok) {
		io.error(`${created.error} — create a pane first: /win hsplit watch`);
		return;
	}
	created.view.add(expr);
	ctx.requestRender();
	io.success(`display ${created.view.getEntries().length}: ${expr} — re-evaluated on every stop.`);
}

/** gdb `undisplay <n>` — stop auto-displaying entry n (1-based, gdb-style). */
async function handleUndisplay(args: string, ctx: ReplContext): Promise<void> {
	const io = ctx.io;
	const n = resolveIndex(args.trim());
	if (n === undefined || n < 1) {
		io.error("Usage: undisplay <n> — a display index (info display lists them)");
		return;
	}
	const found = findWatchView(ctx.windows);
	if (!found) {
		io.info("Nothing to undisplay — no watchers.");
		return;
	}
	const view = found.view;
	// Display numbers are 1-based watch indices (gdb-style): entry n-1.
	const index = n - 1;
	if (index >= view.getEntries().length) {
		io.error(`No display ${n}. info display lists them.`);
		return;
	}
	const expr = view.getEntries()[index]!.expr;
	view.removeAt(index);
	ctx.requestRender();
	io.success(`Undisplayed ${n} (${expr}).`);
}

/**
 * `/session` — the flattened collection grammar:
 *   `/session` (bare)      → fuzzy finder over saved sessions
 *   `/session <name>`      → restore that saved session directly
 *   `/session save <name>`   → persist the current state now
 * The finder adds `+ create` (saves current state under the typed name,
 * Enter), ctrl+d (delete, inline confirm) and ctrl+r (rename).
 */
async function handleSession(args: string, ctx: ReplContext): Promise<void> {
	const hooks = ctx.sessions;
	const io = ctx.io;
	if (!hooks) {
		io.error("Sessions are not enabled in this build.");
		return;
	}
	const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
	const name = rest.join(" ").trim();

	if (!verb) {
		openSessionPicker(ctx);
		return;
	}

	if (verb === "save") {
		try {
			await hooks.save(name || undefined);
		} catch (error) {
			io.error(error instanceof Error ? error.message : String(error));
		}
		return;
	}

	// `switch` is tolerated as an invisible alias (`/session switch <name>`).
	if (verb === "switch") {
		if (!name) {
			openSessionPicker(ctx);
			return;
		}
		await hooks.restore(name);
		return;
	}

	// Anything else is a saved session name to restore directly.
	try {
		await hooks.restore(verb);
	} catch (error) {
		io.error(error instanceof Error ? error.message : String(error));
	}
}

/** Parse an entry index; omitted → undefined (caller applies a default). */
function resolveIndex(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) || n < 0 ? undefined : n;
}

/** "frame → renderer tuple +types" · "hp → renderer lines" */
function entrySummary(view: WatchListView, index: number): string {
	const entry = view.getEntries()[index];
	if (!entry) return "no entry";
	const flags = entry.renderSpec.flags ?? 0;
	const names = Object.values(VIEW_FLAG_META).filter((m) => m.name !== "none" && (flags & flagBit(m.name)!) !== 0).map((m) => m.name);
	return `${entry.expr}: renderer ${entry.renderSpec.rendererId}${names.length ? ` +${names.join("|")}` : ""}`;
}


/**
 * `/new [name]` — a genuinely fresh session. Resets the live gdb (new
 * process, no breakpoints), drops the target, and collapses the layout back
 * to the bare repl pane, then starts a (optionally named) session. This is
 * the material implementation; `/session new`, `/target new` and `/layout new`
 * all delegate here.
 */
async function handleNew(ctx: ReplContext, name?: string): Promise<void> {
	// A fresh session must not inherit a replay from the old one.
	clearLastReplay();
	const hooks = ctx.sessions;
	if (!hooks) {
		// Sessions off: still reset the live debugger + layout in place.
		await ctx.reset();
		setLastLaunch(null);
		ctx.io.success("Fresh target — break a line, then run.");
		return;
	}
	await hooks.startNew(name?.trim() || undefined);
}

/* ------------------------------------------------------- fuzzy pickers ---- */

/**
 * A "named collection" the generic picker operates on (sessions, targets,
 * layouts). For every collection the grammar is identical:
 *   bare command → finder (pick to open, type a new name + Enter to save
 *   current, ctrl+d to delete, ctrl+r to rename).
 */
interface CollectionSpec {
	/** Canonical command used in echoes, e.g. "/session". */
	command: string;
	/** Overlay title, e.g. "sessions". */
	title: string;
	/** Noun for the create/save row, e.g. "session". */
	term: string;
	items(ctx: ReplContext): PickerItem[];
	/** Whether the picker should offer a "save current" row. */
	canCreate?(ctx: ReplContext): boolean;
	onPick(ctx: ReplContext, name: string): Promise<void> | void;
	/** Persist the current state under `name` (the picker's Enter-on-new). */
	onCreate(ctx: ReplContext, name: string): Promise<void> | void;
	onDelete(ctx: ReplContext, name: string): Promise<void> | void;
	onRename?(ctx: ReplContext, oldName: string, newName: string): Promise<void> | void;
}

const SESSIONS_SPEC: CollectionSpec = {
	command: "/session",
	title: "sessions",
	term: "session",
	items: (ctx) => {
		const hooks = ctx.sessions!;
		const current = hooks.activeName();
		return hooks.list().map((s) => ({
			value: s.name,
			search: s.name,
			label: `${s.name}${current === s.name ? " ✳" : ""}`,
			description: `${s.target ?? "no target"} · ${s.layout ?? "no layout"} · bp ${s.breakpoints} · ${relativeTime(s.savedAt ?? Date.now())}`,
		}));
	},
	onPick: (ctx, name) => ctx.sessions!.restore(name),
	// Enter on a fresh name saves the CURRENT state (not a blank session).
	onCreate: (ctx, name) => ctx.sessions!.save(name),
	onDelete: (ctx, name) => ctx.sessions!.remove(name),
	onRename: async (ctx, oldName, newName) => {
		await ctx.sessions!.save(newName);
		if (oldName && oldName !== newName) await ctx.sessions!.remove(oldName);
	},
};

const TARGETS_SPEC: CollectionSpec = {
	command: "/target",
	title: "targets",
	term: "target",
	items: (ctx) => {
		const hooks = ctx.sessions!;
		const current = hooks.targets.current();
		return hooks.targets.list().map((t) => ({
			value: t.name,
			search: t.name,
			label: `${t.name}${current === t.name ? " ✳" : ""}`,
			description: `${t.kind === "launch" ? (t.program ?? "?") : `attach pid ${t.pid}`}${t.args.length ? ` ${t.args.join(" ")}` : ""}`,
		}));
	},
	// Naming a profile needs a live target to snapshot.
	canCreate: () => getLastLaunch() !== null,
	onPick: (ctx, name) => {
		ctx.sessions!.targets.load(name);
		ctx.sessions!.markDirty();
	},
	onCreate: (ctx, name) => {
		ctx.sessions!.targets.save(name);
		ctx.sessions!.markDirty();
	},
	onDelete: (ctx, name) => {
		ctx.sessions!.targets.remove(name);
		ctx.sessions!.markDirty();
	},
	onRename: (ctx, oldName, newName) => ctx.sessions!.targets.save(newName),
};

function hooks(ctx: ReplContext): NonNullable<ReplContext["sessions"]> {
	return ctx.sessions!;
}

/**
 * Open the fuzzy picker for a named collection: pick an item to open, type a
 * fresh name + Enter to save current, ctrl+d to delete, ctrl+r to rename.
 */
function openCollectionPicker(spec: CollectionSpec, ctx: ReplContext, itemEcho = (n: string) => `${spec.command} ${n}`): void {
	const hooksApi = ctx.sessions;
	if (!hooksApi) {
		ctx.io.error("Sessions are not enabled in this build.");
		return;
	}
	const items = spec.items(ctx);
	const canCreate = spec.canCreate?.(ctx) ?? true;

	if (items.length === 0 && !canCreate) {
		items.push({ value: "", label: `no saved ${spec.term}s`, description: "set one up in the transcript, then reopen this picker" });
	}
	openPicker({
		title: spec.title,
		items,
		...(canCreate
			? {
					createLabel: (query: string) => `save current ${spec.term} "${query}"`,
					onCreate: (query: string) => {
						const echo = `${spec.command} save ${query}`;
						ctx.io.line(`${colors.accent("› ")}${echo}`);
						setLastReplay(echo);
						void spec.onCreate(ctx, query);
					},
				}
			: {}),
		onPick: (item) => {
			if (!item.value) return;
			const echo = itemEcho(item.value);
			ctx.io.line(`${colors.accent("› ")}${echo}`);
			setLastReplay(echo);
			void spec.onPick(ctx, item.value);
		},
		onDelete: (item) => {
			if (!item.value) return;
			ctx.io.line(`${colors.accent("› ")}${spec.command} delete ${item.value}`);
			// The delete echo is informative (no `delete` verb exists); replaying
			// it would just error, so the buffer must not hold it.
			clearLastReplay();
			void spec.onDelete(ctx, item.value);
		},
		onRename: (item, newName) => {
			if (!item.value || !newName) return;
			const echo = `${spec.command} save ${newName}`;
			ctx.io.line(`${colors.accent("› ")}${echo}`);
			setLastReplay(echo);
			void spec.onRename?.(ctx, item.value, newName);
		},
		onCancel: () => clearLastReplay(),
	});
}

/** `› /session <name>` echo; used by bare `/session`. */
export function openSessionPicker(ctx: ReplContext): void {
	openCollectionPicker(SESSIONS_SPEC, ctx);
}

/** `› /target <name>` echo; used by bare `/target`. */
function openTargetPicker(ctx: ReplContext): void {
	openCollectionPicker(TARGETS_SPEC, ctx);
}

const LAYOUTS_SPEC: CollectionSpec = {
	command: "/layout",
	title: "layouts",
	term: "layout",
	items: (ctx) => {
		const hooksApi = ctx.sessions!;
		const current = hooksApi.layouts.current();
		return hooksApi.layouts.list().map((l) => ({
			value: l.name,
			search: l.name,
			label: `${l.name}${current === l.name ? " ✳" : ""}`,
			description: `${l.panes} pane(s) · ${l.watchEntries} watch${l.livePaneCount ? ` · ${l.livePaneCount} live` : ""}`,
		}));
	},
	onPick: (ctx, name) => {
		ctx.sessions!.layouts.load(name);
		ctx.sessions!.markDirty();
	},
	onCreate: (ctx, name) => {
		ctx.sessions!.layouts.save(name);
		ctx.sessions!.markDirty();
	},
	onDelete: (ctx, name) => {
		ctx.sessions!.layouts.remove(name);
		ctx.sessions!.markDirty();
	},
	onRename: (ctx, oldName, newName) => {
		ctx.sessions!.layouts.save(newName);
		if (oldName && oldName !== newName) ctx.sessions!.layouts.remove(oldName);
	},
};

/** `› /layout <name>` echo; used by bare `/layout`. */
function openLayoutPicker(ctx: ReplContext): void {
	openCollectionPicker(LAYOUTS_SPEC, ctx);
}

/** `› /win switch <pane>` on pick; used by bare `/win switch`. */
function openPanePicker(ctx: ReplContext): void {
	const items: PickerItem[] = ctx.windows.list().map((p) => ({
		value: p.id,
		label: `${p.idx} · ${p.id}${p.active ? " ✳" : ""}`,
		description: p.title,
	}));
	openPicker({
		title: "switch pane",
		items,
		onPick: (item) => {
			if (!item.value) return;
			const echo = `/win switch ${item.value}`;
			ctx.io.line(`${colors.accent("› ")}${echo}`);
			setLastReplay(echo);
			ctx.windows.switchTo(item.value);
		},
		onCancel: () => clearLastReplay(),
	});
}

/**
 * `/open` — one combined finder over sessions · layouts · targets. A single
 * fuzzy pass across all three saved collections; Enter opens the right one.
 * Items are tagged with their group in the LABEL only (visual); the picker
 * fuzzy-matches the raw NAME (`search`), so `e` surfaces the two "example"
 * entries instead of every row whose group tag happens to contain an 'e'.
 * Group tags keep the collections scannable at a glance — narrowing is done
 * by name (`/open mem` → memleak).
 *
 * Also the destination of a leading `>` on the prompt — main.ts opens it
 * live on the first keystroke; a pasted/recalled `> <query>` line arrives
 * through handleReplInput with `seed` = whatever follows the `>`.
 */
type OpenItem = PickerItem & { open(ctx: ReplContext): Promise<void> | void };

export async function handleOpen(ctx: ReplContext, seed?: string): Promise<void> {
	const h = ctx.sessions;
	if (!h) {
		ctx.io.error("Sessions are not enabled in this build.");
		return;
	}
	const items: OpenItem[] = [
		...SESSIONS_SPEC.items(ctx).map((s) => ({
			...s,
			label: `${colors.muted("session")}  ${s.label}`,
			open: () => h.restore(s.value),
		})),
		...LAYOUTS_SPEC.items(ctx).map((l) => ({
			...l,
			label: `${colors.muted("layout")}   ${l.label}`,
			open: () => {
				h.layouts.load(l.value);
				h.markDirty();
			},
		})),
		...TARGETS_SPEC.items(ctx).map((t) => ({
			...t,
			label: `${colors.muted("target")}   ${t.label}`,
			open: () => {
				h.targets.load(t.value);
				h.markDirty();
			},
		})),
	];
	if (items.length === 0) {
		ctx.io.info("Nothing saved yet. run <program> to start, then /session save <name>.");
		return;
	}
	openPicker({
		title: "open — sessions · layouts · targets",
		items,
		...(seed ? { initialFilter: seed } : {}),
		onPick: (item) => {
			// The picker hands back row copies ({value,label,description}) — the
			// `open` callback lives on the original item, so re-find it here.
			const openItem = items.find((i) => i.value === item.value);
			if (!openItem) return;
			const echo = `/open ${item.value}`;
			ctx.io.line(`${colors.accent("› ")}${echo}`);
			setLastReplay(echo);
			void openItem.open(ctx);
		},
		onCancel: () => clearLastReplay(),
	});
}

/**
 * Slash commands that open the fuzzy picker when they carry no argument.
 * main.ts defers the transcript echo for these — the picker echoes the
 * resolved line itself on pick.
 */
export function isBarePickerCommand(input: string): boolean {
	const text = input.trim();
	return (
		text === "/win switch" ||
		text === "/session" ||
		text === "/target" ||
		text === "/layout" ||
		text === "/open"
	);
}

/**
 * `/target` — the flattened collection grammar for stored target profiles.
 *   `/target` (bare)      → fuzzy finder over saved profiles
 *   `/target <name>`      → load that saved profile (symbols; never auto-runs)
 *   `/target save <name>` → persist the live target as a profile
 * The finder adds `+ save current` (Enter on a fresh name), ctrl+d delete,
 * ctrl+r rename. Stored profiles are seeded by `run <program> [args…]`.
 */
async function handleTarget(args: string, ctx: ReplContext): Promise<void> {
	const hooks = ctx.sessions;
	const io = ctx.io;
	if (!hooks) {
		io.error("Sessions are not enabled — /target needs the persistence store.");
		return;
	}
	const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
	const name = rest.join(" ").trim();

	if (!verb) {
		openTargetPicker(ctx);
		return;
	}

	if (verb === "save") {
		if (!name) {
			io.error("Usage: /target save <name>");
			return;
		}
		await hooks.targets.save(name);
		io.success(`Target profile '${name}' saved.`);
		hooks.markDirty();
		return;
	}

	// Anything else is a saved profile name to load directly.
	await hooks.targets.load(verb === "switch" ? name || "" : verb);
	hooks.markDirty();
}

/**
 * `/layout` — the flattened collection grammar for stored layout profiles.
 *   `/layout` (bare)      → fuzzy finder over saved layouts
 *   `/layout <name>`      → apply that saved layout
 *   `/layout save <name>` → persist the current panes/watch as a profile
 * The finder adds `+ save current` (Enter on a fresh name), ctrl+d delete,
 * ctrl+r rename.
 */
async function handleLayout(args: string, ctx: ReplContext): Promise<void> {
	const hooks = ctx.sessions;
	const io = ctx.io;
	if (!hooks) {
		io.error("Sessions are not enabled — /layout needs the persistence store.");
		return;
	}
	const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
	const name = rest.join(" ").trim();

	if (!verb) {
		openLayoutPicker(ctx);
		return;
	}

	if (verb === "save") {
		const active = hooks.layouts.current();
		const target = name || active || "";
		if (!target) {
			io.error("No active layout profile — /layout save <name>");
			return;
		}
		await hooks.layouts.save(target);
		io.success(`Layout '${target}' saved.`);
		hooks.markDirty();
		return;
	}

	// Anything else is a saved layout name to apply directly.
	await hooks.layouts.load(verb === "switch" ? name || "" : verb);
	hooks.markDirty();
}



async function handleSlashCommand(input: string, ctx: ReplContext): Promise<void> {
	const words = input.slice(1).split(/\s+/);
	const command = words[0] ?? "";
	const rest = words.slice(1);
	const args = rest.join(" ");
	const io = ctx.io;
	let api = ctx.getApi();

	switch (command) {
		case "help":
			showHelp(args, io, ctx.config.keybindings.actions);
			break;

		case "run":
		case "launch":
			// `run` is the one start verb; `launch` is an invisible alias.
			await handleRun(args, ctx);
			break;

		case "attach": {
			const pid = Number.parseInt(rest[0] ?? "", 10);
			if (Number.isNaN(pid)) {
				io.error("Usage: /attach <pid>");
				return;
			}
			io.info(`Attaching to ${pid}...`);
			await api.attach(pid);
			io.success(`Attached to ${pid}`);
			break;
		}

		case "break": {
			if (!args) {
				io.error("Usage: /break <file:line> [condition]");
				return;
			}
			await handleBreak(args, api, io);
			break;
		}

		case "breaks":
			await printBreakpoints(api, io);
			break;

		case "remove": {
			await handleDelete(rest, api, io);
			break;
		}

		case "step":
			if (requireStopped(api, io)) await withActivity(ctx, "stepping into", () => api.stepInto());
			break;

		case "next":
			if (requireStopped(api, io)) await withActivity(ctx, "stepping over", () => api.stepOver());
			break;

		case "finish":
			if (requireStopped(api, io)) await withActivity(ctx, "stepping out", () => api.stepOut());
			break;

		case "continue":
			if (requireStopped(api, io)) await withActivity(ctx, "continuing", () => api.continue());
			break;

		case "stack":
			await printStack(api, io);
			break;

		case "locals":
			await printLocals(api, io, "local");
			break;

		case "status": {
			const state = api.getState();
			const location = api.sourceFile ? `${api.sourceFile}:${api.currentLine}` : "no location";
			io.line(`state: ${state} | breakpoints: ${api.breakpoints.size} | thread: ${api.activeThreadId} | ${location}`);
			break;
		}

		case "win":
			await handleWin(args, ctx);
			break;

		case "config":
			await handleConfig(args, ctx);
			break;

		case "watch":
			await handleWatch(args, ctx);
			break;

		case "session":
			await handleSession(args, ctx);
			break;

		case "open":
			handleOpen(ctx);
			break;

		case "settings": {
			for (const line of renderSettings(ctx.config, ctx.configSources)) io.line(line);
			break;
		}

		case "new":
			await handleNew(ctx, args || undefined);
			break;

		case "target":
			await handleTarget(args, ctx);
			break;

		case "layout":
			await handleLayout(args, ctx);
			break;

		case "quit":
			io.info("Shutting down...");
			ctx.requestExit();
			break;

		default:
			io.error(`Unknown command: /${command}. Type /help for commands.`);
	}
}

/**
 * `/config` — inspect (default) or reload (~/.aidbrc + ./.aidb.json) files.
 */
async function handleConfig(args: string, ctx: ReplContext): Promise<void> {
	const io = ctx.io;
	const terms = args.trim().split(/\s+/);
	if (terms[0] === "reload") {
		const { sources } = ctx.reloadConfig();
		io.success("Config reloaded (theme + keybindings applied).");
		for (const issue of sources.issues) io.warning(`config ${issue.path}: ${issue.message}`);
		return;
	}
	const { theme, gdb, sessions, ui } = ctx.config;
	const origin = (k: string) => ctx.configSources.sectionOrigin[k as keyof Config];
	io.line("aidb config");
	io.info(`  theme      (${origin("theme")}): accent=${theme.accent} muted=${theme.muted} border=${theme.border} inputBorder=${theme.inputBorder} borderActive=${theme.borderActive} borderInactive=${theme.borderInactive} placeholder=${theme.placeholder}`);
	io.info(`  tokens     (theme): keyword=${theme.keyword} string=${theme.string} number=${theme.number} comment=${theme.comment} type=${theme.type} preproc=${theme.preproc}`);
	io.info(`  asm        (theme): mnemonic=${theme.mnemonic} register=${theme.register} label=${theme.label} function=${theme.function}`);
	io.info(`  gdb        (${origin("gdb")}): path=${gdb.path}`);
	io.info(`  sessions   (${origin("sessions")}): history=${sessions.historyPath}`);
	io.info(`  ui         (${origin("ui")}): promptZone=${ui.promptZone}`);
	if (ctx.configSources.issues.length > 0) {
		io.info("config issues:");
		for (const issue of ctx.configSources.issues) io.warning(`  ${issue.path}: ${issue.message}`);
	}
}

/**
 * GDB's `dont_repeat()` table, flattened: whether an empty-Enter replay of
 * `input` makes sense. The first token decides, with sub-token cases for the
 * positional pane/watch commands and named profile switches. Replay still
 * routes through the full dispatcher, so state guards (`requireStopped`,
 * `runningBlocked`) apply to replays too — this only refuses commands whose
 * *second* execution would act on a changed world (index-shifting,
 * layout-mutating, one-shot profile switches, destructive) or re-enter gdb's
 * definition modes and hang the DAP channel.
 */
export function canReplayCommand(input: string): boolean {
	const words = input.trim().split(/\s+/).filter(Boolean);
	const command = words[0] ?? "";
	const sub = words[1];

	switch (command) {
		// One-shot / destructive start verbs — never replay (gdb's `run` is
		// dont_repeat too). `file` is the hidden alias of `run` in aidb.
		case "run":
		case "r":
		case "file":
		case "attach":
		case "detach":
		case "quit":
		case "q":
		case "/run":
		case "/launch":
		case "/attach":
		case "/quit":
		case "/new":
			return false;

		// Pane ops are positional: replayed against a shifted layout they'd hit a
		// different pane (gdb's `layout next/prev` analog). `/win list` is pure.
		case "/win":
			return sub === "list";

		// `/watch` mutations renumber entries / duplicate expressions; the
		// listing forms (bare or `list`) are pure reads and repeat.
		case "/watch":
			return sub === undefined || sub === "list";

		// gdb `display <expr>` registers a NEW auto-display every run — never
		// repeat an add. The bare listing form repeats; `undisplay <n>`
		// renumbers entries so a second run would hit the wrong one.
		case "display":
			return sub === undefined;
		case "undisplay":
			return false;

		// Named profile switches are one-shot "move the whole world" verbs:
		// re-applying a layout rebuilds the pane tree (wiping any tweaks made
		// since), re-restoring a session clobbers live working state with the
		// snapshot, re-loading a target re-reads symbols and unsettles
		// breakpoints. Bare forms reopen the finder; `save` is idempotent.
		case "/layout":
		case "/session":
		case "/target":
			return sub === undefined || sub === "save";

		// `/open <name>` restores whatever was picked (session/layout/target);
		// bare `/open` (or a `> query` seed) just reopens the finder.
		case "/open":
			return sub === undefined;

		// gdb definition-mode / interactive passthroughs — replaying would
		// re-enter an editor block in the inferior gdb and can hang DAP.
		case "commands":
		case "define":
		case "document":
		case "python":
		case "guile":
		case "while":
		case "if":
		case "layout":
		case "focus":
		case "refresh":
		case "update":
		case "tui":
			return false;

		// Everything else (steps, prints, info, profile saves, listings,
		// read-only slash commands, arbitrary gdb passthrough) repeats.
		default:
			return true;
	}
}

/**
 * Enter on an empty prompt: replay the last command when it still makes sense.
 * Echoes the line like a typed submit (the transcript is aidb's record of what
 * happened), then dispatches through the identical `handleReplInput` path so
 * every existing guard and picker behavior applies unchanged.
 */
export async function replayLastCommand(ctx: ReplContext): Promise<void> {
	if (!lastReplay) return; // nothing executed this session → stay silent (gdb parity)
	if (!canReplayCommand(lastReplay)) {
		ctx.io.info(`(not repeated: ${lastReplay})`);
		return;
	}
	ctx.io.line(`${colors.accent("› ")}${lastReplay}`);
	await handleReplInput(lastReplay, ctx);
}

export async function handleReplInput(rawInput: string, ctx: ReplContext): Promise<void> {
	const input = rawInput.trim();
	if (!input) return;

	try {
		if (input.startsWith("/")) {
			await handleSlashCommand(input, ctx);
		} else if (input.startsWith(">")) {
			// Leading `>` opens the combined fuzzy finder. main.ts catches a
			// freshly-typed `>` on an empty prompt live; a pasted/recalled
			// `> mem` line lands here, opening the finder pre-narrowed to
			// whatever follows the `>` instead of reaching gdb as a command.
			await handleOpen(ctx, input.slice(1).trim() || undefined);
		} else {
			await handleGdbCommand(input, ctx);
		}
	} catch (error) {
		ctx.io.error(error instanceof Error ? error.message : String(error));
	}
}
