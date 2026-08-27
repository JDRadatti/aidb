import {
	CombinedAutocompleteProvider,
	Container,
	KeybindingsManager,
	ProcessTerminal,
	Text,
	TUI_KEYBINDINGS,
	TuiMainScreen,
	matchesKey,
	setKeybindings,
	type Component,
} from "@earendil-works/pi-tui";
import { createDebugger } from "@earendil-works/pi-debugger-core";
import type { DebuggerAPI } from "@earendil-works/pi-debugger-core";
import * as fs from "node:fs";
import { AidbEditor, attachDropdownOverlay } from "./completion-overlay.ts";
import { colors, applyTheme, createEditorTheme } from "./theme.ts";
import {
	loadConfig,
	resolveAction,
	type Action,
	type Config,
	type ConfigSources,
} from "./config.ts";
import { handleReplInput, refreshLivePanes, resetLivePanes, type ReplContext, type ReplIO } from "./repl.ts";
import { SplitTree } from "./split-tree.ts";
import { View } from "./view.ts";
import { WindowManager } from "./window-manager.ts";
import { ReplTranscript } from "./repl-log.ts";
import { ActivitySpinner } from "./spinner.ts";

const traceDap = process.argv.includes("--trace-dap");

// ---------- config (load once; /config reload re-runs this) ----------
let config: Config;
let configSources: ConfigSources;

/** Load config files, then apply theme + keybindings. */
function loadAndApplyConfig(): { config: Config; sources: ConfigSources } {
	const loaded = loadConfig();
	applyTheme(loaded.config.theme);
	setupKeyBindings(loaded.config);
	return loaded;
}
function setupKeyBindings(cfg: Config): void {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, cfg.keybindings.editor),
	);
}
{
	const loaded = loadAndApplyConfig();
	config = loaded.config;
	configSources = loaded.sources;
	for (const issue of configSources.issues) {
		console.error(`aidb config: ${issue.path}: ${issue.message}`);
	}
}

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);

const transcript = new ReplTranscript();
const statusBar = new Text("", 0, 0);
const spinner = new ActivitySpinner(tui, transcript);

const panesById = new Map<string, Component>();
panesById.set("repl", transcript);
const windows = new WindowManager(new SplitTree("repl"), {
	panes: panesById,
	getViewRows: () => terminal.rows,
	onChange: () => tui.requestRender(),
});

function addLine(text: string): void {
	if (!text) return;
	transcript.addLine(text);
	tui.requestRender();
}

const io: ReplIO = {
	line: (text) => addLine(text),
	info: (text) => addLine(colors.muted(text)),
	success: (text) => addLine(colors.success(text)),
	warning: (text) => addLine(colors.warning(text)),
	error: (text) => addLine(colors.error(text)),
};

let dbg = createDebugger(dapConfig());

function dapConfig() {
	return {
		traceDap,
		gdbPath: config.gdb.path,
		...(Object.keys(config.gdb.env).length > 0 ? { env: config.gdb.env } : {}),
	};
}

function wireSession(api: DebuggerAPI): void {
	api.on("output", ({ category, output }) => {
		const text = output.trimEnd();
		if (!text) return;
		if (category === "stderr") io.error(text);
		else if (category === "console") io.info(text);
		else io.line(text);
	});

	api.on("process", ({ name, systemProcessId }) => {
		resetLivePanes(replCtx);
		io.info(`Started ${name ?? "target"}${systemProcessId ? ` (pid ${systemProcessId})` : ""}`);
		updateStatus();
	});

	api.on("stopped", ({ reason }) => {
		io.info(`Stopped (${reason}).`);
		updateStatus();
		refreshLivePanes(replCtx);
	});

	api.on("continued", () => updateStatus());

	api.on("breakpoints-changed", () => {
		updateStatus();
		refreshLivePanes(replCtx);
	});

	api.on("location", ({ file, line }) => {
		if (file) io.info(`→ ${file}:${line}`);
		updateStatus();
		if (file && line > 0) refreshLivePanes(replCtx);
	});

	api.on("session:exited", ({ exitCode }) => {
		if (exitCode === 0 || exitCode === undefined) {
			io.info("Program exited normally (code 0). Type run to start it again.");
		} else {
			io.error(`Program exited with code ${exitCode}. Type run to start it again.`);
		}
		updateStatus();
	});

	api.on("session:error", ({ error }) => {
		io.error(error.message);
		updateStatus();
	});
}

wireSession(dbg.api);

function updateStatus(): void {
	const api = dbg.api;
	const state = api.getState();
	const dot =
		state === "stopped" ? colors.warning("●") :
		state === "running" ? colors.success("●") :
		colors.muted("○");
	const location = api.sourceFile ? `${api.sourceFile}:${api.currentLine}` : "—";
	const panes = windows.list().map((p) => `${p.idx}${p.active ? "*" : ""}·${p.id}`).join(" ");
	statusBar.setText(
		`${dot} ${state} │ ${panes} │ bp: ${api.breakpoints.size} │ ${location}`,
	);
	tui.requestRender();
}

async function resetDebugger(): Promise<DebuggerAPI> {
	await dbg.cleanup();
	dbg = createDebugger(dapConfig());
	wireSession(dbg.api);
	resetLivePanes(replCtx);
	return dbg.api;
}

let exiting = false;

async function shutdown(): Promise<void> {
	if (exiting) return;
	exiting = true;
	try {
		await dbg.cleanup();
	} finally {
		tui.stop();
		if (traceDap) {
			const trace = dbg.dumpDapTrace();
			if (trace) process.stderr.write(`\n--- DAP trace ---\n${trace}\n`);
		}
		process.exit(0);
	}
}

/**
 * Reload config files and re-apply theme + keybindings live. The editor's
 * theme (border/autocomplete) is fixed at construction, so those roles take
 * effect on restart; output/colour roles and all keybindings apply at once.
 */
function reloadConfig(): { config: Config; sources: ConfigSources } {
	const loaded = loadAndApplyConfig();
	config = loaded.config;
	configSources = loaded.sources;
	return loaded;
}

const replCtx: ReplContext = {
	getApi: () => dbg.api,
	reset: resetDebugger,
	requestExit: () => void shutdown(),
	requestRender: () => tui.requestRender(),
	io,
	windows,
	spinner,
	config,
	configSources,
	reloadConfig,
};

async function submit(raw: string): Promise<void> {
	const text = raw.trim();
	editor.setText("");
	if (!text) {
		tui.requestRender();
		return;
	}
	editor.addToHistory(text);
	addLine(colors.accent("› ") + text);
	persistHistory(text);
	await handleReplInput(text, replCtx);
	updateStatus();
}

/** Append a submitted command to the persisted history file (best-effort). */
function persistHistory(entry: string): void {
	const file = config.sessions.historyPath;
	if (!file) return;
	try {
		fs.appendFileSync(file, `${entry}\n`);
	} catch {
		/* history persistence is best-effort */
	}
}

const editor = new AidbEditor(tui, createEditorTheme(config.theme));
editor.setAutocompleteProvider(new CombinedAutocompleteProvider(undefined, process.cwd()));
editor.onSubmit = (text: string) => {
	void submit(text);
};
attachDropdownOverlay(tui, editor);

// Seed this session's history from the persisted file (most-recent-first).
(function seedHistory(): void {
	try {
		if (!fs.existsSync(config.sessions.historyPath)) return;
		const lines = fs.readFileSync(config.sessions.historyPath, "utf8").split("\n");
		editor.loadHistory(lines);
	} catch {
		/* ignore corrupt/inaccessible history */
	}
})();

tui.addChild(windows);
tui.addChild(editor);
tui.addChild(statusBar);

tui.setFocus(editor);

/** vim navigation keys routed to the active pane when the editor is empty. */
const PANE_NAV_KEYS = new Set<string>(["end", "home", "ctrl+d", "ctrl+u"]);

/** Resolve an Action -> handler, guarding on the target being stopped. */
const actionHandlers: Record<Action, (data: string) => void> = {
	continue: () => guard((api) => spinner.run("continuing", () => api.continue())),
	stepOver: () => guard((api) => spinner.run("stepping over", () => api.stepOver())),
	stepInto: () => guard((api) => spinner.run("stepping into", () => api.stepInto())),
	stepOut: () => guard((api) => spinner.run("stepping out", () => api.stepOut())),
	scrollUp: (data) => scrollActivePane(data),
	scrollDown: (data) => scrollActivePane(data),
};

function guard(run: (api: DebuggerAPI) => Promise<unknown>): void {
	const api = dbg.api;
	if (api.getState() !== "stopped") {
		io.error("Target is not stopped.");
		return;
	}
	void run(api).catch((e) => io.error(String(e.message ?? e)));
}

function scrollActivePane(data: string): void {
	const active = windows.component(windows.active);
	if (!active) return;
	if (active instanceof View) active.handleInput(data);
	else if (active instanceof ReplTranscript) active.handleInput(data);
	// Scrolling only mutates pane scroll state synchronously; nothing else
	// schedules a repaint (a consumed key skips the focused editor's path that
	// otherwise triggers requestImmediateRender). Paint the new viewport now.
	tui.requestRender();
}

/** Map raw input to a configured action, or undefined if unbound. */
function actionFor(data: string): Action | null {
	return resolveAction(config.keybindings.actions, data);
}

tui.addInputListener((data): { consume: boolean } | undefined => {
	// Hard binding: cannot be remapped (interrupts takes priority).
	if (matchesKey(data, "ctrl+c")) {
		if (editor.getText()) {
			editor.setText("");
			tui.requestRender();
			return { consume: true };
		}
		void shutdown();
		return { consume: true };
	}

	const action = actionFor(data);
	if (action) {
		actionHandlers[action](data);
		return { consume: true };
	}

	// Unbound pane-navigation keys: when the editor isn't being typed into,
	// end/home and Ctrl+D/U scroll the ACTIVE pane (vim-style) instead of
	// falling through to the editor. Letters stay typable.
	if (!editor.getText() && PANE_NAV_KEYS.has(data)) {
		scrollActivePane(data);
		return { consume: true };
	}

	return undefined;
});

transcript.addChild(new Text(colors.bold("aidb — GDB via DAP"), 1, 0));
transcript.addChild(new Text(colors.muted("file <program> to load, break <file:line> to stop, run to start. /help for more."), 1, 0));
updateStatus();

tui.start();