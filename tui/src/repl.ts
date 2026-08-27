import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { Component } from "@earendil-works/pi-tui";
import type { DebuggerAPI } from "@earendil-works/pi-debugger-core";
import type { WindowManager } from "./window-manager.ts";
import type { SplitDir } from "./split-tree.ts";
import { LivePaneView } from "./views/live-pane.ts";
import { WatchListView } from "./views/watch.ts";
import { AssemblyBinding, InterleavedBinding, MemoryBinding, RegistersBinding, SeriesBinding, SourceBinding, TreeBinding } from "./viz/bindings.ts";
import { INTERPRETERS } from "./viz/interpreters.ts";
import type { Binding, FetchCtx, LivePane } from "./viz/types.ts";
import type { ActivitySpinner } from "./spinner.ts";

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
}

function withActivity<T>(ctx: ReplContext, label: string, operation: () => Promise<T>): Promise<T> {
	return ctx.spinner ? ctx.spinner.run(label, operation) : operation();
}

const HELP = [
	"aidb — GDB-style commands (no slash needed):",
	"  file <program>              load a program's symbols; then `run` starts it",
	"  run [program] [args...]     start or restart the target (remembers the last one)",
	"  break <loc> [cond]          set a breakpoint; <loc> is file:line, a line number,",
	"                              or a function name (alias: b)",
	"  info breakpoints            list breakpoints (alias: i b)",
	"  delete [id...]              remove breakpoints, all of them if no ids (alias: d)",
	"  continue                    resume execution (F5, alias: c)",
	"  next                        step over (F10, alias: n)",
	"  step                        step into (F11, alias: s)",
	"  si                          step one machine instruction (GDB alias: stepi)",
	"  finish                      step out (Shift+F11)",
	"  bt                          backtrace (aliases: backtrace, where)",
	"  print <expr>                evaluate an expression in the current frame (alias: p)",
	"  set <var> = <val>           assign in the current frame (uses `set variable` syntax)",
	"  info locals | info args     variables and arguments of the current frame",
	"  set disassembly-flavor intel|att   choose x86 Intel or AT&T syntax",
	"  /win load <pane> iasm      source lines with mapped assembly beneath them",
	"  /watch <expr>               pin an expression to a live watch pane across stops",
	"  /win load <pane> <spec>     bind a live visualizer: regs · mem <expr> [bytes] · plot n · tree s · source · asm",
	"",
	"Windows (manual): /win vsplit [idx] [name] | hsplit [idx] [name] | close <idx|name> | next | list;",
	"  /win pick [idx] [view] swaps how a live pane renders; /switch <idx|name> focuses a pane.",
	"",
	"Anything else is passed to GDB verbatim: info registers, x/4xw, disassemble, pwd, ...",
	"Relative paths resolve against the directory aidb was started in; Tab completes file paths.",
	"",
	"Slash aliases still work: /launch /attach /break /breaks /remove /stack /locals /status /help /quit",
	"History: Ctrl+P / Ctrl+N, or Up/Down on an empty prompt. Topic help: help <topic> (e.g. help win).",
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
	"  /switch <idx|name>                          make that pane active",
	"  /win list                                   print idx -> id mapping (indices",
	"                                              shift on close!)",
	"  /watch <expr>                               pin an expression to a live watch",
	"                                              pane (auto-creates 'watch')",
	"  /win load <idx|name> <what>                 bind a live visualizer into a pane:",
	"                                              regs · mem <expr> [bytes] · plot n ·",
	"                                              tree player · source · asm",
	"                                              mem suffix is raw byte count (default 192),",
	"                                              not tuples — e.g. mem frame 12 = 12 bytes",
	"  /win pick [idx|name] [view]                 list interpreters, or swap one in place",
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
 */
function showHelp(topic: string | undefined, io: ReplIO): void {
	const normalized = topic?.trim().toLowerCase();
	if (normalized === "win" || normalized === "window" || normalized === "windows") {
		io.line(WIN_HELP);
	} else if (normalized) {
		io.error(`No help topic '${topic}'. Topics: win`);
	} else {
		io.line(HELP);
	}
}

/**
 * Last program launched, so bare `run` can restart it.
 */
let lastLaunch: { program: string; args: string[] } | null = null;

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
export function refreshLivePanes(ctx: ReplContext): void {
	for (const pane of ctx.windows.list()) {
		const view = ctx.windows.component(pane.id);
		if (isLivePane(view)) void view.refreshAll();
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
export function parseLoadSpec(spec: string): { binding: Binding; interpreterId: string } | undefined {
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

/**
 * Hosts the bindings' FetchCtx over DebuggerAPI. The api handle is fetched
 * per call so sessions replaced by `reset` are picked up transparently.
 * Core Variables are mapped to VarNodes here so the viz layer never imports
 * debugger types.
 */
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
			const source = await readFile(file, "utf8");
			return source.split(/\r?\n/).slice(Math.max(0, startLine - 1), Math.max(0, startLine - 1) + count);
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
	lastLaunch = { program: absolute, args };
	if (api.breakpoints.size === 0) {
		ctx.io.warning(`No breakpoints in ${absolute} — it will run straight through to exit.`);
		ctx.io.info("Tip: break <file:line> first, then run again to inspect state.");
	} else {
		ctx.io.success(`Running — waiting for breakpoint hit...`);
	}
	return api;
}

/**
 * gdb-style `file <program>`: load symbols now so breakpoints bind
 * immediately, and remember the program so bare `run` can start it.
 */

async function handleFile(program: string, ctx: ReplContext): Promise<void> {
	const { getApi, io } = ctx;
	const api = getApi();
	if (!program) {
		io.info(lastLaunch ? `Current target: ${lastLaunch.program}` : "No target file. Usage: file <program>");
		return;
	}
	if (runningBlocked(api, io)) return;
	const absolute = resolveProgram(program);
	io.info(`Reading symbols from ${absolute}...`);
	try {
		await withActivity(ctx, "loading symbols", () => api.evaluate(`file ${absolute}`, "repl"));
	} catch (error) {
		io.error(error instanceof Error ? error.message : String(error));
		cwdHint(io);
		return;
	}
	lastLaunch = { program: absolute, args: lastLaunch?.program === absolute ? lastLaunch.args : [] };
	io.success(`Symbols loaded. Set breakpoints, then type run.`);
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
			showHelp(args, io);
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
		case "list": {
			for (const pane of windows.list()) {
				io.line(`${pane.idx}\t${pane.id}${pane.active ? " *" : ""}`);
			}
			return;
		}
		case "load": {
			if (rest.length < 2) {
				io.error("Usage: /win load <idx|name> regs | mem <expr> | plot <expr> | tree <expr> | source | asm");
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
			const parsed = parseLoadSpec(rest.slice(1).join(" "));
			if (!parsed) {
				io.error(`Cannot visualize '${rest.slice(1).join(" ")}'. Try: regs · mem &buf · plot n · tree player · source · asm`);
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
			for (const word of rest) {
				if (INTERPRETERS[word]) interpreterId = word;
				else if (ref === undefined) ref = word;
				else {
					io.error(`Usage: /win pick [idx|name] [${Object.keys(INTERPRETERS).join("|")}]`);
					return;
				}
			}
			if (!interpreterId) {
				const current = ref === undefined ? undefined : windows.component(windows.resolve(ref) ?? "");
				io.line("Interpreters:");
				for (const { id, title } of Object.values(INTERPRETERS)) {
					const marker = current instanceof LivePaneView && current.getInterpreterId() === id ? " *" : "";
					io.line(`  ${(id + marker).padEnd(15)} ${title}`);
				}
				io.info("Swap one with: /win pick <idx|name> <interpreter>");
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
			component.setInterpreter(interpreterId);
			windows.switchTo(target);
			ctx.requestRender();
			io.success(`'${target}' now renders with ${interpreterId} (${INTERPRETERS[interpreterId]!.title}).`);
			return;
		}
		default:
			io.error(
				`Usage: /win vsplit|hsplit [idx] [name] | load <idx|name> <spec> | pick [idx|name] [view] | close <idx|name> | next | list — 'help win' for details.`,
			);
	}
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
			showHelp(args, io);
			break;

		case "run":
			await handleRun(args, ctx);
			break;

		case "launch": {
			const program = rest[0];
			if (!program) {
				io.error("Usage: /launch <program> [args...]");
				return;
			}
			api = await startTarget(program, rest.slice(1), ctx);
			break;
		}

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

		case "switch": {
			const ref = rest[0];
			if (ref === undefined || rest.length > 1) {
				io.error("Usage: /switch <idx|name> — /win list shows indices");
				return;
			}
			if (!ctx.windows.switchTo(ref)) {
				io.error(/^\d+$/.test(ref) ? `No pane at index ${ref}. /win list shows indices.` : `No pane named '${ref}'.`);
				return;
			}
			io.info(`Active pane: ${ctx.windows.active}`);
			break;
		}

		case "win":
			await handleWin(args, ctx);
			break;

		case "watch": {
			const expr = args.trim();
			if (!expr) {
				io.error("Usage: /watch <expr> — re-evaluated after every stop");
				return;
			}
			let found = findWatchView(ctx.windows);
			if (!found) {
				const id = nextWatchId(ctx.windows);
				const previous = ctx.windows.active;
				const result = ctx.windows.split("v", undefined, id);
				if (!result.ok) {
					io.error(`${result.error} — create a pane first: /win hsplit watch`);
					return;
				}
				ctx.windows.mount(result.value, makeWatchView(ctx, result.value));
				ctx.windows.switchTo(previous); // auto-create must not steal focus
				found = findWatchView(ctx.windows);
				io.info(`Created live watch pane '${id}'.`);
			}
			if (!found) return;
			found.view.add(expr);
			ctx.requestRender();
			break;
		}

		case "quit":
			io.info("Shutting down...");
			ctx.requestExit();
			break;

		default:
			io.error(`Unknown command: /${command}. Type /help for commands.`);
	}
}

export async function handleReplInput(rawInput: string, ctx: ReplContext): Promise<void> {
	const input = rawInput.trim();
	if (!input) return;

	try {
		if (input.startsWith("/")) {
			await handleSlashCommand(input, ctx);
		} else {
			await handleGdbCommand(input, ctx);
		}
	} catch (error) {
		ctx.io.error(error instanceof Error ? error.message : String(error));
	}
}
