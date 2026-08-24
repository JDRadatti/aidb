import * as os from "node:os";
import * as path from "node:path";
import type { DebuggerAPI } from "@earendil-works/pi-debugger-core";
import type { WindowManager } from "./window-manager.ts";
import type { SplitDir } from "./split-tree.ts";
import { WatchListView, type WatchEvaluator } from "./views/watch.ts";

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
	"  finish                      step out (Shift+F11)",
	"  bt                          backtrace (aliases: backtrace, where)",
	"  print <expr>                evaluate an expression in the current frame (alias: p)",
	"  info locals | info args     variables and arguments of the current frame",
	"  /watch <expr>               pin an expression to a live watch pane across stops",
	"",
	"Windows (manual): /win vsplit [idx] [name] | hsplit [idx] [name] | close <idx|name> | next | list;",
	"  /switch <idx|name> focuses a pane. Blank panes show their index. See: help win.",
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

function cwdHint(io: ReplIO): void {
	io.info(`Relative paths are resolved against: ${process.cwd()} — use an absolute path, or Tab-complete, if that's not where your binary lives.`);
}

/**
 * Live watch panes: names starting with "watch" mount a WatchListView instead
 * of a blank slab. Expressions come from /watch since panes never take keys.
 */
function makeWatchView(ctx: ReplContext, id: string): WatchListView {
	const evaluator: WatchEvaluator = async (expr) => String(await ctx.getApi().evaluate(expr, "watch"));
	return new WatchListView(evaluator, { id, onChange: () => ctx.requestRender() });
}

/** The first unused id in the series "watch", "watch2", "watch3", ... */
export function nextWatchId(windows: WindowManager): string {
	const taken = new Set(windows.list().map((p) => p.id));
	if (!taken.has("watch")) return "watch";
	for (let i = 2; ; i++) {
		if (!taken.has(`watch${i}`)) return `watch${i}`;
	}
}

/** All live watch panes currently mounted. */
export function findWatchViews(windows: WindowManager): Array<{ id: string; view: WatchListView }> {
	const found: Array<{ id: string; view: WatchListView }> = [];
	for (const pane of windows.list()) {
		if (!pane.id.startsWith("watch")) continue;
		const view = windows.component(pane.id);
		if (view instanceof WatchListView) found.push({ id: pane.id, view });
	}
	return found;
}

/** Find an existing live watch pane by id, or undefined. */
export function findWatchView(windows: WindowManager): { id: string; view: WatchListView } | undefined {
	return findWatchViews(windows)[0];
}

/**
 * Re-evaluate every expression in every watch pane. Called whenever the
 * target stops — the equivalent of gdb refreshing `display` expressions.
 */
export function refreshWatchPanes(ctx: ReplContext): void {
	for (const { view } of findWatchViews(ctx.windows)) void view.refreshAll();
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

async function passthrough(input: string, api: DebuggerAPI, io: ReplIO): Promise<void> {
	if (runningBlocked(api, io)) return;
	const result = await api.evaluate(input, "repl");
	if (result !== undefined && result !== "") {
		io.line(String(result));
	}
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
		await api.launch(absolute, args);
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
async function handleFile(program: string, api: DebuggerAPI, io: ReplIO): Promise<void> {
	if (!program) {
		io.info(lastLaunch ? `Current target: ${lastLaunch.program}` : "No target file. Usage: file <program>");
		return;
	}
	if (runningBlocked(api, io)) return;
	const absolute = resolveProgram(program);
	io.info(`Reading symbols from ${absolute}...`);
	try {
		await api.evaluate(`file ${absolute}`, "repl");
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
		await passthrough(`break ${argStr}`, api, io);
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
		io.line(`${bp.id}\t${bp.file}:${bp.line}${bp.condition ? ` if ${bp.condition}` : ""}${bp.verified ? "" : " (pending)"}`);
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
async function handleInfo(subcommand: string, input: string, api: DebuggerAPI, io: ReplIO): Promise<void> {
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
			await passthrough(input, api, io);
	}
}

const ALIASES: Record<string, string> = {
	r: "run",
	b: "break",
	d: "delete",
	c: "continue",
	n: "next",
	s: "step",
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
			await handleFile(args, api, io);
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
			if (requireStopped(api, io)) await api.continue();
			break;

		case "next":
			if (requireStopped(api, io)) await api.stepOver();
			break;

		case "step":
			if (requireStopped(api, io)) await api.stepInto();
			break;

		case "finish":
			if (requireStopped(api, io)) await api.stepOut();
			break;

		case "info":
			await handleInfo(rest[0] ?? "", input, api, io);
			break;

		case "backtrace":
		case "print":
			await passthrough(input, api, io);
			break;

		case "attach": {
			const pid = Number.parseInt(rest[0] ?? "", 10);
			if (Number.isNaN(pid)) {
				io.error("Usage: attach <pid>");
				return;
			}
			io.info(`Attaching to ${pid}...`);
			await api.attach(pid);
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
			await passthrough(input, api, io);
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
		default:
			io.error(`Usage: /win vsplit|hsplit [idx] [name] | close <idx|name> | next | list — 'help win' for details.`);
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
			if (requireStopped(api, io)) await api.stepInto();
			break;

		case "next":
			if (requireStopped(api, io)) await api.stepOver();
			break;

		case "finish":
			if (requireStopped(api, io)) await api.stepOut();
			break;

		case "continue":
			if (requireStopped(api, io)) await api.continue();
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
