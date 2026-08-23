import { Container, Editor, ProcessTerminal, Text, TuiMainScreen, matchesKey } from "@earendil-works/pi-tui";
import { createDebugger } from "@earendil-works/pi-debugger-core";
import type { DebuggerAPI } from "@earendil-works/pi-debugger-core";
import { colors, createEditorTheme } from "./theme.ts";
import { handleReplInput, type ReplContext, type ReplIO } from "./repl.ts";

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);

const transcript = new Container();
const statusBar = new Text("", 0, 0);

function addLine(text: string): void {
	if (!text) return;
	transcript.addChild(new Text(text.replace(/\n$/, "")));
	tui.requestRender();
}

const io: ReplIO = {
	line: (text) => addLine(text),
	info: (text) => addLine(colors.muted(text)),
	success: (text) => addLine(colors.success(text)),
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

	api.on("stopped", ({ reason }) => {
		io.info(`Stopped (${reason}).`);
		updateStatus();
	});

	api.on("continued", () => updateStatus());

	api.on("location", ({ file, line }) => {
		if (file) io.info(`→ ${file}:${line}`);
		updateStatus();
	});

	api.on("session:exited", ({ exitCode }) => {
		io.info(`Target exited (code ${exitCode}).`);
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
	statusBar.setText(
		`${dot} ${state} │ bp: ${api.breakpoints.size} │ thread: ${api.activeThreadId} │ ${location}`,
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
	io,
};

async function submit(raw: string): Promise<void> {
	const text = raw.trim();
	editor.setText("");
	if (!text) {
		tui.requestRender();
		return;
	}
	addLine(colors.accent("› ") + text);
	await handleReplInput(text, replCtx);
	updateStatus();
}

const editor = new Editor(tui, createEditorTheme());
editor.onSubmit = (text: string) => {
	void submit(text);
};
tui.addChild(transcript);
tui.addChild(statusBar);
tui.addChild(editor);
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
transcript.addChild(new Text(colors.muted("Type /help for commands, or GDB commands directly.")));
updateStatus();

tui.start();
