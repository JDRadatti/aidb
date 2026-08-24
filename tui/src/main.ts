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
import { AidbEditor, attachDropdownOverlay } from "./completion-overlay.ts";
import { colors, createEditorTheme } from "./theme.ts";
import { handleReplInput, refreshWatchPanes, type ReplContext, type ReplIO } from "./repl.ts";
import { SplitTree } from "./split-tree.ts";
import { WindowManager } from "./window-manager.ts";

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);

setKeybindings(
	new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.editor.historyPrevious": ["ctrl+p"],
		"tui.editor.historyNext": ["ctrl+n"],
	}),
);

const transcript = new Container();
const statusBar = new Text("", 0, 0);

/**
 * The window system is being proven in isolation: blank panes render as
 * colored index slabs (see windows-plan.html). Real views register here once
 * the mechanics are trusted.
 */
const panesById = new Map<string, Component>();
panesById.set("repl", transcript);
const windows = new WindowManager(new SplitTree("repl"), {
	panes: panesById,
	getViewRows: () => terminal.rows,
	onChange: () => tui.requestRender(),
});

function addLine(text: string): void {
	if (!text) return;
	transcript.addChild(new Text(text.replace(/\n$/, "")));
	tui.requestRender();
}

const io: ReplIO = {
	line: (text) => addLine(text),
	info: (text) => addLine(colors.muted(text)),
	success: (text) => addLine(colors.success(text)),
	warning: (text) => addLine(colors.warning(text)),
	error: (text) => addLine(colors.error(text)),
};

let dbg = createDebugger();

function wireSession(api: DebuggerAPI): void {
	api.on("output", ({ category, output }) => {
		const text = output.trimEnd();
		if (!text) return;
		if (category === "stderr") io.error(text);
		else if (category === "console") io.info(text);
		else io.line(text);
	});

	api.on("process", ({ name, systemProcessId }) => {
		io.info(`Started ${name ?? "target"}${systemProcessId ? ` (pid ${systemProcessId})` : ""}`);
		updateStatus();
	});

	api.on("stopped", ({ reason }) => {
		io.info(`Stopped (${reason}).`);
		updateStatus();
		// Watches re-evaluate on every stop, like gdb's `display`.
		refreshWatchPanes(replCtx);
	});

	api.on("continued", () => updateStatus());

	api.on("location", ({ file, line }) => {
		if (file) io.info(`→ ${file}:${line}`);
		updateStatus();
	});

	api.on("session:exited", ({ exitCode }) => {
		if (exitCode === 0 || exitCode === undefined) {
			io.info("Program exited normally (code 0). Type run to start it again.");
		} else {
			io.error(`Program exited with code ${exitCode}. Type run to start it again.`);
		}
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
	dbg = createDebugger();
	wireSession(dbg.api);
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
		process.exit(0);
	}
}

const replCtx: ReplContext = {
	getApi: () => dbg.api,
	reset: resetDebugger,
	requestExit: () => void shutdown(),
	requestRender: () => tui.requestRender(),
	io,
	windows,
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
	await handleReplInput(text, replCtx);
	updateStatus();
}

const editor = new AidbEditor(tui, createEditorTheme());
editor.setAutocompleteProvider(new CombinedAutocompleteProvider(undefined, process.cwd()));
editor.onSubmit = (text: string) => {
	void submit(text);
};
// The suggestion list renders as an overlay docked above the prompt instead
// of inline rows, so opening/closing it never scrolls the document or leaves
// a gap at the bottom of the screen.
attachDropdownOverlay(tui, editor, {
	rowsBelow: () => statusBar.render(terminal.columns).length,
});

tui.addChild(windows);
tui.addChild(statusBar);
tui.addChild(editor);

/**
 * The editor keeps focus permanently — panes never capture keys, so the
 * prompt works no matter what the window layout looks like. Window commands
 * (/switch, /win ...) are typed like everything else.
 */
tui.setFocus(editor);

tui.addInputListener((data): { consume: boolean } | undefined => {
	if (matchesKey(data, "ctrl+c")) {
		if (editor.getText()) {
			editor.setText("");
			tui.requestRender();
			return { consume: true };
		}
		void shutdown();
		return { consume: true };
	}

	const api = dbg.api;
	const guard = (): boolean => {
		if (api.getState() !== "stopped") {
			io.error("Target is not stopped.");
			return false;
		}
		return true;
	};

	if (matchesKey(data, "f5")) {
		if (guard()) void api.continue().catch((e) => io.error(String(e.message ?? e)));
		return { consume: true };
	}
	if (matchesKey(data, "f10")) {
		if (guard()) void api.stepOver().catch((e) => io.error(String(e.message ?? e)));
		return { consume: true };
	}
	if (matchesKey(data, "f11")) {
		if (guard()) void api.stepInto().catch((e) => io.error(String(e.message ?? e)));
		return { consume: true };
	}
	if (matchesKey(data, "shift+f11")) {
		if (guard()) void api.stepOut().catch((e) => io.error(String(e.message ?? e)));
		return { consume: true };
	}
	return undefined;
});

transcript.addChild(new Text(colors.bold("aidb — GDB via DAP")));
transcript.addChild(new Text(colors.muted("file <program> to load, break <file:line> to stop, run to start. /help for more.")));
updateStatus();

tui.start();
