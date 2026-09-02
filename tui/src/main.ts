import {
	Container,
	KeybindingsManager,
	ProcessTerminal,
	Text,
	TUI_KEYBINDINGS,
	TuiMainScreen,
	matchesKey,
	isKeyRelease,
	setKeybindings,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { createDebugger } from "@earendil-works/pi-debugger-core";
import type { DebuggerAPI } from "@earendil-works/pi-debugger-core";
import * as fs from "node:fs";
import { AidbEditor, attachDropdownOverlay } from "./completion-overlay.ts";
import { colors, applyTheme, createEditorTheme } from "./theme.ts";
import { loadConfig, resolveAction, type Action, type Config, type ConfigSources, type ThemeConfig } from "./config.ts";
import {
	handleReplInput,
	refreshLivePanes,
	resetLivePanes,
	getLastLaunch,
	setLastLaunch,
	setLastReplay,
	clearLastReplay,
	replayLastCommand,
	makeWatchView,
	makeLivePaneView,
	isBarePickerCommand,
	handleOpen,
	type ReplContext,
	type ReplIO,
	type SessionHooks,
} from "./repl.ts";
import { AidbCompletionProvider, buildCommandRegistry } from "./slash.ts";
import { renderIntro, type IntroState } from "./intro.ts";
import { installPickerHost, pickerActive, pickerLineSource } from "./picker.ts";
import { SplitTree } from "./split-tree.ts";
import { View } from "./view.ts";
import { WindowManager } from "./window-manager.ts";
import { WatchListView } from "./views/watch.ts";
import { LivePaneView } from "./views/live-pane.ts";
import { specFromBinding } from "./viz/bindings.ts";
import {
	createStores,
	implicitProfileName,
	newSessionId,
	TARGET_SCHEMA_VERSION,
	LAYOUT_SCHEMA_VERSION,
	SESSION_SCHEMA_VERSION,
	type LayoutState,
	type SessionBreakpoint,
	type SessionState,
	type SessionWatchPanes,
	type SessionLivePanes,
	type StateStores,
	type TargetState,
} from "./session-store.ts";
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
	onChange: () => {
		tui.requestRender();
		markDirty();
	},
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
		refreshLivePanes(replCtx, true);
	});

	api.on("continued", () => updateStatus());

	api.on("breakpoints-changed", () => {
		updateStatus();
		refreshLivePanes(replCtx, false);
		markDirty();
	});

	api.on("location", ({ file, line }) => {
		if (file) io.info(`→ ${file}:${line}`);
		updateStatus();
		if (file && line > 0) refreshLivePanes(replCtx, false);
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

/* --------------------------------------------------------- sessions --------
 * Named persistence of debugger *setup* (target + breakpoints + layout +
 * watch panes) into `~/.config/aidb/sessions/<name>.json`. Auto-saves on a
 * ~1s debounce at the three hooks (target change, breakpoints, windows);
 * flushes synchronously on quit.
 *
 * Layouts are the exception: the split-tree/watch arrangement only persists
 * when the user explicitly runs `/layout save <name>` — never implicitly —
 * so every tweak of the panes doesn't leak a near-identical profile. A
 * session simply references the named layout (or none) it binds to.
 * See sessions-plan.html.
 */
let stores: StateStores | null = null;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;

function sessionsEnabled(): boolean {
	return config.sessions.autoSave;
}
function store(): StateStores {
	if (!stores) stores = createStores(config.sessions.sessionDir);
	return stores;
}

/**
 * The active session's stable identity (UUID). Implicit target/layout profiles
 * are named `target_<uuid>` so "session"-named or renamed sessions never collide.
 * A fresh UUID is minted per `startNew`; restoring a session adopts its id.
 */
let sessionId: string | null = null;
function currentSessionId(): string {
	if (!sessionId) sessionId = newSessionId();
	return sessionId;
}
function adoptSessionId(id?: string): void {
	sessionId = id || newSessionId();
}
function resetSessionId(): void {
	sessionId = newSessionId();
}

/** Name the active target profile: explicit active name, else a session-scoped implicit. */
function activeTargetName(): string | null {
	const explicit = store().targets.activeName();
	if (explicit) return explicit;
	const t = getLastLaunch();
	if (!t) return null;
	// Per-session implicit name keyed by the session's stable UUID
	// (`target_<uuid>`), unique across every session it belongs to.
	return implicitProfileName("target", currentSessionId());
}

/**
 * Name of the layout profile bound to this session, or null when the user
 * hasn't saved one. Layouts persist only via explicit `/layout save <name>`;
 * they are never auto-saved, so there is no implicit per-session profile.
 */
function activeLayoutName(): string | null {
	return store().layouts.activeName();
}

/**
 * Name the active session: an explicit active name, else a per-session UUID
 * (`session_<uuid>`). UUID naming keeps every unnamed session's auto-saved
 * file unique — two sessions of the same program never clobber each other —
 * and the result is directly resume-able (`aidb -r session_<uuid>`).
 */
function activeSessionName(): string {
	const named = store().sessions.activeName();
	if (named) return named;
	return implicitProfileName("session", currentSessionId());
}

/** Collect watch entries from every live watch pane (shared by `/layout save` snapshots). */
function collectWatchPanes(): SessionWatchPanes {
	const watchPanes: SessionWatchPanes = {};
	for (const pane of windows.list()) {
		const component = windows.component(pane.id);
		if (component instanceof WatchListView) {
			watchPanes[pane.id] = {
				entries: component.getEntries().map((entry) => ({
					expr: entry.expr,
					renderSpec: entry.renderSpec,
					byteCount: entry.byteCount,
				})),
			};
		}
	}
	return watchPanes;
}

/**
 * Collect live panes (source/asm/regs/mem/plot/tree/iasm bound via
 * `/win load`) so a layout snapshot can rebuild them exactly. Watch lists are
 * handled by `collectWatchPanes`; bindings that can't serialize are skipped.
 */
function collectLivePanes(): SessionLivePanes {
	const livePanes: SessionLivePanes = {};
	for (const pane of windows.list()) {
		const component = windows.component(pane.id);
		if (!(component instanceof LivePaneView)) continue;
		const spec = specFromBinding(component.getBinding());
		if (!spec) continue;
		livePanes[pane.id] = {
			spec,
			interpreterId: component.getInterpreterId(),
			flags: component.getFlags(),
		};
	}
	return livePanes;
}

function snapshotTargetState(): TargetState | undefined {
	const t = getLastLaunch();
	if (!t) return undefined;
	return {
		schemaVersion: TARGET_SCHEMA_VERSION,
		name: activeTargetName() ?? "target",
		kind: "launch",
		program: t.program,
		args: t.args,
		savedAt: Date.now(),
	};
}

function snapshotSessionState(): SessionState {
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		name: activeSessionName(),
		id: currentSessionId(),
		target: activeTargetName(),
		layout: activeLayoutName(),
		breakPoints: [...dbg.api.breakpoints.values()].map((bp) => ({
			file: bp.file || undefined,
			line: bp.line || undefined,
			condition: bp.condition,
			verified: bp.verified,
			location: bp.location,
		})),
		savedAt: Date.now(),
	};
}

/** Debounced auto-save (~1s). Flush synchronously on quit so nothing is lost. */
function markDirty(): void {
	if (!sessionsEnabled()) return;
	if (dirtyTimer) clearTimeout(dirtyTimer);
	dirtyTimer = setTimeout(() => {
		dirtyTimer = null;
		void flushSession();
	}, 1000);
}

/** Immediate save of target + session stores. Clears any pending timer. Layouts are explicit-only. */
async function flushSession(): Promise<void> {
	if (dirtyTimer) {
		clearTimeout(dirtyTimer);
		dirtyTimer = null;
	}
	if (!sessionsEnabled()) return;
	const s = store();
	const target = snapshotTargetState();
	if (target) await s.targets.save(target);
	// Layouts are not auto-saved (explicit `/layout save <name>` only); the
	// session snapshot just records which named layout it binds to, if any.
	await s.sessions.save(snapshotSessionState());
}

/** Rebind a saved breakpoint into the live gdb. */
async function restoreBreakpoint(bp: SessionBreakpoint): Promise<void> {
	if (bp.location) {
		try {
			const out = await dbg.api.evaluate(`break ${bp.location}`, "repl");
			const id = String(out ?? "").match(/Breakpoint (\d+)/);
			if (id) dbg.api.trackExternalBreakpoint(Number(id[1]), bp.location, bp.file, bp.line);
		} catch (error) {
			replCtx.io.error(`break ${bp.location}: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else if (bp.file && bp.line) {
		try {
			await dbg.api.setBreakpoint(bp.file, bp.line, bp.condition);
		} catch (error) {
			replCtx.io.error(`setBreakpoint ${bp.file}:${bp.line}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function applyLayoutProfile(layout: LayoutState, s: StateStores): void {
	windows.restoreTree(SplitTree.deserialize(layout.splitTree));
	for (const [paneId, watchPane] of Object.entries(layout.watchPanes)) {
		if (!watchPane.entries.length) continue;
		const view = makeWatchView(replCtx, paneId);
		view.restore(watchPane.entries);
		windows.mount(paneId, view);
	}
	for (const [paneId, saved] of Object.entries(layout.livePanes ?? {})) {
		const view = makeLivePaneView(replCtx, paneId, saved);
		windows.mount(paneId, view);
		// Fetch once so a restored source/asm pane shows content immediately
		// instead of a blank slab until the next stop (mirrors /win load).
		void view.refreshAll();
	}
	s.layouts.setActive(layout.name);
}

/** Point gdb at a target profile (symbols only; never auto-runs). */
async function loadTargetProfile(name: string): Promise<void> {
	const s = store();
	const tp = s.targets.load(name);
	if ("error" in tp) {
		replCtx.io.error(`target '${name}': ${tp.error}`);
		return;
	}
	s.targets.setActive(name);
	if (tp.state.kind === "launch" && tp.state.program) {
		try {
			await dbg.api.evaluate(`file ${tp.state.program}`, "repl");
			setLastLaunch({ program: tp.state.program, args: [...tp.state.args] });
			replCtx.io.success(`target '${name}': ${tp.state.program} — symbols loaded, type run.`);
		} catch (error) {
			replCtx.io.error(error instanceof Error ? error.message : String(error));
		}
	} else {
		replCtx.io.info(`target '${name}' is an attach profile — use attach <pid>.`);
	}
	updateStatus();
}

/** Restore a layout profile into the live windows. */
function loadLayoutProfile(name: string): void {
	const s = store();
	const lp = s.layouts.load(name);
	if ("error" in lp) {
		replCtx.io.error(`layout '${name}': ${lp.error}`);
		return;
	}
	s.layouts.setActive(name);
	applyLayoutProfile(lp.state, s);
	updateStatus();
	replCtx.io.success(`layout '${name}' — ${windowPaneCount()} panes.`);
}

/** Panes beyond the repl currently mounted. */
function windowPaneCount(): number {
	return Math.max(0, windows.list().length - 1);
}

/** Restore a session: target profile + layout profile + breakpoints. */
async function restoreSession(name: string): Promise<void> {
	const s = store();
	const loaded = s.sessions.load(name);
	if ("error" in loaded) {
		replCtx.io.error(`Cannot restore: ${loaded.error}`);
		return;
	}
	const snap = loaded.state;
	s.sessions.setActive(snap.name);
	// Adopt the session's stable id so its implicit target/layout profiles match.
	adoptSessionId(snap.id);

	// 1. Target profile — symbols only; never auto-run (D4).
	if (snap.target) {
		const tp = s.targets.load(snap.target);
		if ("error" in tp) {
			replCtx.io.error(`target '${snap.target}': ${tp.error}`);
		} else {
			s.targets.setActive(snap.target);
			if (tp.state.kind === "launch" && tp.state.program) {
				try {
					await dbg.api.evaluate(`file ${tp.state.program}`, "repl");
					setLastLaunch({ program: tp.state.program, args: [...tp.state.args] });
					replCtx.io.info(`Reading symbols from ${tp.state.program}...`);
				} catch (error) {
					replCtx.io.error(error instanceof Error ? error.message : String(error));
				}
			} else {
				replCtx.io.info(`target '${snap.target}' is an attach profile — attach <pid> when ready.`);
			}
		}
	} else {
		setLastLaunch(null);
	}

	// 2. Layout profile.
	if (snap.layout) {
		const lp = s.layouts.load(snap.layout);
		if ("error" in lp) {
			replCtx.io.error(`layout '${snap.layout}': ${lp.error}`);
		} else {
			s.layouts.setActive(snap.layout);
			applyLayoutProfile(lp.state, s);
		}
	} else {
		windows.restoreTree(SplitTree.deserialize({ root: "repl", active: "repl" }));
	}

	// 3. Breakpoints.
	for (const bp of snap.breakPoints) await restoreBreakpoint(bp);

	updateStatus();
	replCtx.io.success(`restored "${snap.name}" — ${snap.breakPoints.length} bp · ${windowPaneCount()} panes (target: ${snap.target ?? "—"}, layout: ${snap.layout ?? "—"}). type run`);
}

/** Session / target / layout hooks handed to the REPL. */
const sessionsHooks: SessionHooks = {
	activeName: () => store().sessions.activeName(),
	list: () => store().sessions.list(),
	markDirty,
	save: async (name?: string) => {
		await flushSession();
		if (name) {
			store().sessions.setActive(name);
			await store().sessions.save(snapshotSessionState());
		}
		const finalName = store().sessions.activeName() ?? activeSessionName();
		replCtx.io.success(`Session saved as '${finalName}'.`);
		updateStatus();
	},
	setCurrent: (name: string) => store().sessions.setActive(name),
	remove: async (name: string) => {
		await store().sessions.remove(name);
	},
	restore: restoreSession,
	startNew: async (name?: string) => {
		const chosen = name?.trim();
		// A truly fresh slate: new gdb (no breakpoints), dropped target,
		// single-pane layout, a fresh session and a fresh stable id.
		await resetDebugger();
		setLastLaunch(null);
		windows.restoreTree(SplitTree.deserialize({ root: "repl", active: "repl" }));
		// Named sessions claim their name; unnamed ones stay unclaimed and
		// auto-save under their fresh uuid (`session_<uuid>`).
		if (chosen) store().sessions.setActive(chosen);
		else store().sessions.clearActive();
		store().targets.clearActive();
		store().layouts.clearActive();
		resetSessionId();
		await flushSession();
		updateStatus();
		// A truly fresh session is a fresh slate: the recall history (Ctrl+P/N)
		// starts empty and the transcript is cleared — the only line on screen
		// is the compact `[session '…' activated]` notice (no banner re-print).
		editor.clearHistory();
		transcript.clear();
		addLine(colors.accent(`[session '${activeSessionName()}' activated]`));
	},
	targets: {
		current: () => activeTargetName(),
		list: () => store().targets.list(),
		save: async (name?: string) => {
			const state = snapshotTargetState();
			if (!state) {
				replCtx.io.warning(`No program set — nothing to save as a target profile.`);
				return;
			}
			if (name) state.name = name;
			store().targets.setActive(state.name);
			await store().targets.save(state);
			updateStatus();
		},
		load: loadTargetProfile,
		remove: async (name: string) => {
			await store().targets.remove(name);
		},
	},
	layouts: {
		current: () => store().layouts.activeName(),
		list: () => store().layouts.list(),
		save: async (name?: string) => {
			const active = store().layouts.activeName();
			if (!name) {
				name = active ?? undefined;
				if (!name) {
					replCtx.io.error(`No active layout profile — /layout save <name>`);
					return;
				}
				replCtx.io.info(`Saving changes to layout '${name}'.`);
			}
			store().layouts.setActive(name);
			await store().layouts.save({
				schemaVersion: LAYOUT_SCHEMA_VERSION,
				name,
				splitTree: windows.tree.serialize(),
				watchPanes: collectWatchPanes(),
				livePanes: collectLivePanes(),
				savedAt: Date.now(),
			});
			updateStatus();
		},
		load: loadLayoutProfile,
		remove: async (name: string) => {
			await store().layouts.remove(name);
		},
	},
};

function statusRightTags(): string {
	const tag = (label: string, name: string): string =>
		`${colors.muted(`[${label}: `)}${colors.accent(name)}${colors.muted("]")}`;
	const parts: string[] = [];
	const target = savedTargetName();
	if (target) parts.push(tag("target", target));
	const session = savedSessionName();
	if (session) parts.push(tag("session", session));
	const layout = savedLayoutName();
	if (layout) parts.push(tag("layout", layout));
	return parts.join(" ");
}

function updateStatus(): void {
	const api = dbg.api;
	const state = api.getState();
	const dot =
		state === "stopped" ? colors.warning("●") :
		state === "running" ? colors.success("●") :
		colors.muted("○");
	const location = api.sourceFile ? `${api.sourceFile}:${api.currentLine}` : "—";
	const panes = windows.list().map((p) => `${p.idx}${p.active ? "*" : ""}·${p.id}`).join(" ");
	const sessionHint = store().sessions.list().length > 0 ? ` │ ${colors.muted("[Alt+O open]")}` : "";
	const left = `${dot} ${state} │ ${panes} │ bp: ${api.breakpoints.size} │ ${location}${sessionHint}`;
	// [target: x] [session: y] [layout: z] pinned to the right edge (only while
	// the names exist on disk); drop them rather than let the line wrap.
	const right = statusRightTags();
	if (right && visibleWidth(left) + visibleWidth(right) < terminal.columns) {
		const pad = Math.max(1, terminal.columns - visibleWidth(left) - visibleWidth(right));
		statusBar.setText(`${left}${" ".repeat(pad)}${right}`);
	} else {
		statusBar.setText(left);
	}
	tui.requestRender();
}

async function resetDebugger(): Promise<DebuggerAPI> {
	await dbg.cleanup();
	dbg = createDebugger(dapConfig());
	wireSession(dbg.api);
	resetLivePanes(replCtx);
	return dbg.api;
}

/* ------------------------------------------------------------- intro banner ----- */

function savedSessionName(): string | null {
	const explicit = store().sessions.activeName();
	if (explicit) return explicit;
	const implicit = activeSessionName();
	return store().sessions.list().some((s) => s.name === implicit) ? implicit : null;
}

/** The current target's persisted name (explicit, or its implicit UUID once saved). */
function savedTargetName(): string | null {
	const explicit = store().targets.activeName();
	if (explicit) return explicit;
	const implicit = activeTargetName();
	return implicit && store().targets.list().some((t) => t.name === implicit) ? implicit : null;
}

/** The current layout's persisted name, or null when none is saved. */
function savedLayoutName(): string | null {
	return store().layouts.activeName();
}

/** Build the banner state from the live stores/config. */
function introState(): IntroState {
	const s = store();
	const currentSession = savedSessionName();
	const currentTarget = savedTargetName();
	const currentLayout = savedLayoutName();
	return {
		debuggerLabel: "aidb — GDB debugger via DAP",
		autoSave: config.sessions.autoSave,
		sessions: s.sessions.list().map((m) => ({
			name: m.name,
			current: m.name === currentSession,
			target: m.target ?? null,
			layout: m.layout ?? null,
			breakpoints: m.breakpoints,
		})),
		targets: s.targets.list().map((m) => ({
			name: m.name,
			current: m.name === currentTarget,
			kind: m.kind,
			program: m.program,
			args: m.args,
			pid: m.pid,
		})),
		layouts: s.layouts.list().map((m) => ({
			name: m.name,
			current: m.name === currentLayout,
			panes: m.panes,
			watchEntries: m.watchEntries,
			livePaneCount: m.livePaneCount,
		})),
	};
}

/** Print the startup banner into the transcript. */
function printIntro(): void {
	for (const line of renderIntro(introState())) addLine(line);
}


let exiting = false;

/**
 * Pending "are you sure?" gate — while set, every key is consumed: Enter runs
 * the action, Esc/ctrl+c cancels. Used for destructive/irreversible steps like
 * a `run` that restarts the already-started program. Mirrors the picker's
 * inline delete-confirm affordance (band row + Enter/Esc).
 */
let pendingConfirm: { question: string; onConfirm: () => void | Promise<void> } | null = null;

/** Print a confirm question into the transcript and arm the input gate. */
function askConfirm(question: string, action: () => void | Promise<void>): void {
	pendingConfirm = { question, onConfirm: action };
	addLine(colors.warning(`⚠ ${question}`));
	addLine(colors.muted("  Enter to confirm · Esc to cancel"));
	tui.requestRender();
}

/**
 * Clear the TUI transcript and leave a single copyable resume hint on the
 * terminal: `aidb -r <name>` resurrects exactly this debugging setup. Runs
 * after the TUI is stopped, so it writes straight to the raw terminal.
 */
function printExitResumeHint(): void {
	// Auto-save off means nothing was persisted — no hint to give.
	if (!sessionsEnabled()) return;
	// The name just flushed (explicit name, else `session_<uuid>`).
	const name = activeSessionName();
	transcript.clear();
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write(`Resume session with: aidb -r ${name}\n`);
}

async function shutdown(): Promise<void> {
	if (exiting) return;
	exiting = true;
	try {
		// Flush any pending session save so a clean quit never loses state.
		try {
			await flushSession();
		} catch {
			/* session flush is best-effort */
		}
	} finally {
		await dbg.cleanup().catch(() => undefined);
		tui.stop();
		// Clear the output and print the resume hint as the final screen.
		printExitResumeHint();
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
	// The editor is created after the startup config load; from then on a
	// reload re-themes it live (border + autocomplete dropdown roles) and
	// re-applies the prompt-zone frame level.
	if (editor) {
		const editorTheme = createEditorTheme(config.theme);
		// pi-tui's Editor.theme is a private field with no setter; re-assign it
		// via the shape-probe the dropdown stripper already uses, so an upstream
		// reshuffle degrades to border-only instead of mangling the editor.
		const rec = editor as unknown as { theme?: unknown };
		if (rec.theme) rec.theme = editorTheme;
		editor.borderColor = editorTheme.borderColor;
		editor.promptZone = config.ui.promptZone;
	}
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
	confirm: askConfirm,
	// Getters (not snapshot values) so `reloadConfig` reassigning the module
	// `config`/`configSources` is visible to every consumer on the next read —
	// the settings view renders the fresh values after `/config reload`.
	get config(): Config {
		return config;
	},
	get configSources(): ConfigSources {
		return configSources;
	},
	reloadConfig,
	// Live preview for `/theme`: re-theme colours + editor frame exactly like
	// `reloadConfig` does, but WITHOUT re-reading files or re-binding keys —
	// Esc in the picker hands the old theme back through the same path.
	previewTheme: (theme) => {
		applyTheme(theme);
		if (editor) {
			const editorTheme = createEditorTheme(theme);
			const rec = editor as unknown as { theme?: unknown };
			if (rec.theme) rec.theme = editorTheme;
			editor.borderColor = editorTheme.borderColor;
		}
	},
	sessions: sessionsHooks,
};

async function submit(raw: string): Promise<void> {
	const text = raw.trim();
	if (!text) {
		// Empty prompt: GDB-style replay of the last command — unless it no
		// longer makes sense (run, quit, /new, pane/layout mutations, ...).
		await replayLastCommand(replCtx);
		updateStatus();
		tui.requestRender();
		return;
	}
	// Capture the replay target before dispatch, win or lose (gdb parity: an
	// errored command still occupies the repeat buffer).
	setLastReplay(text);
	editor.setText("");
	editor.addToHistory(text);
	persistHistory(text);
	if (isBarePickerCommand(text) || text.startsWith(">")) {
		// The fuzzy picker echoes the resolved command itself on pick
		// (`› /open <name>` and the noun echoes) and nothing on cancel.
		// Leading `>` is the same finder (a pasted/recalled line) — same
		// deferral so picking echoes once, cancelling echoes nothing.
		// main.ts's listener handles the freshly-typed `>` live instead.
		await handleReplInput(text, replCtx);
		updateStatus();
		return;
	}
	addLine(colors.accent("› ") + text);
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

const editor = new AidbEditor(tui, createEditorTheme(config.theme), undefined, config.ui.promptZone);
editor.setAutocompleteMaxVisible(10);
editor.setAutocompleteProvider(new AidbCompletionProvider(buildCommandRegistry(), replCtx, process.cwd()));
editor.onSubmit = (text: string) => {
	void submit(text);
};
// The single prompt-band overlay. The slash dropdown renders through it on its
// own; the fuzzy picker registers as an extra source so it draws through the
// SAME full-width, chrome-less band with identical geometry (live `offsetY`).
// promptZone frames the whole zone (divider above the band; `line+rail` also
// adds a left rail) — read live so /config reload restyles it immediately.
attachDropdownOverlay(tui, editor, {
	maxHeight: "80%",
	sources: [pickerLineSource],
	promptZone: () => config.ui.promptZone,
});

// The fuzzy picker needs the TUI surface (key capture + a repaint trigger);
// its lines flow through the prompt-band overlay via pickerLineSource.
installPickerHost({
	addInputListener: (listener) => tui.addInputListener(listener),
	requestRender: () => tui.requestRender(),
	// The finder's query lives in the real prompt as `> <query>`, like cursor's
	// fuzzy finder; the editor keeps the block cursor after the text.
	setPromptText: (text) => editor.setText(text),
	// ctrl+a/e/b/f inside the finder move the caret into the query — moved by
	// re-positioning the editor's cursor (pi-tui keeps setCursorCol private;
	// shape-probe like the dropdown stripper, so a reshuffle degrades to the
	// caret staying at the end).
	setPromptCaret: (col) => {
		const rec = editor as unknown as { setCursorCol?: (col: number) => void };
		if (typeof rec.setCursorCol === "function") rec.setCursorCol(col);
	},
});

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
const PANE_NAV_KEYS = ["end", "home", "ctrl+d", "ctrl+u"] as const;

/** Resolve an Action -> handler, guarding on the target being stopped. */
const actionHandlers: Record<Action, (data: string) => void> = {
	// Key-driven steps feed the replay buffer so Enter right after F10/F11 keeps
	// the same cadence (matches gdb's repeat-on-blank-Enter for stepping).
	continue: () => {
		setLastReplay("continue");
		guard((api) => spinner.run("continuing", () => api.continue()));
	},
	stepOver: () => {
		setLastReplay("next");
		guard((api) => spinner.run("stepping over", () => api.stepOver()));
	},
	stepInto: () => {
		setLastReplay("step");
		guard((api) => spinner.run("stepping into", () => api.stepInto()));
	},
	stepOut: () => {
		setLastReplay("finish");
		guard((api) => spinner.run("stepping out", () => api.stepOut()));
	},
	// Non-command actions must not leave a stale line in the buffer: an old
	// `break main` replaying after a scroll/finder would duplicate a breakpoint.
	scrollUp: (data) => {
		clearLastReplay();
		scrollActivePane(data);
	},
	scrollDown: (data) => {
		clearLastReplay();
		scrollActivePane(data);
	},
	open: () => {
		clearLastReplay();
		void handleOpen(replCtx);
	},
	// cmd/bash-style clear: wipe the transcript (the typed prompt survives —
	// like `cls`/`clear`, history and sessions are untouched).
	clearScreen: () => {
		clearLastReplay();
		transcript.clear();
		tui.requestRender();
	},
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

/**
 * Some terminals (kitty-protocol / modifyOtherKeys implementations such as
 * wezterm, foot, Windows Terminal) encode modified navigation keys with CSI-u
 * forms that pi-tui's key parser does not yet recognise:
 *
 *   \x1b[1;5u      Ctrl+Up arrow    (codepoint 1..4 = arrows)
 *   \x1b[5;5u      Ctrl+PgUp        (codepoint 5..8 = pgup/pgdn/home/end)
 *   \x1b[27;4;65~  Ctrl+Up arrow    (xterm modifyOtherKeys mode 2)
 *
 * Rewrite those into the legacy `\x1b[...;...[A-DHF~]` sequences pi-tui
 * understands so scroll and pane-navigation keys work regardless of which
 * keyboard protocol got negotiated. Only modifier-qualified forms are
 * rewritten; bare sequences pass through so typed ESC-prefixed text is never
 * misread as a key.
 */
function normalizeScrollKeySequence(data: string): string {
	if (data.length > 16 || data.includes("\x1b[200~")) return data;
	// Wire modifier encodings: kitty/CSI-u use mask+1 (ctrl=5, ctrl+shift=7),
	// xterm modifyOtherKeys uses the raw mask (ctrl=4, ctrl+shift=6). Fold both
	// onto the legacy `\x1b[1;<mod>X` coding (ctrl=5, ctrl+shift=7).
	const legacyMod = (wire: number): string | null => {
		switch (wire) {
			case 2: case 3: return String(wire);
			case 4: case 5: return "5";
			case 6: case 7: return "7";
			default: return null;
		}
	};
	const arrows = ["A", "B", "C", "D"]; // up/down/right/left
	let m = data.match(/^\x1b\[([1234]);(\d+)u$/);
	if (m) {
		const mod = legacyMod(Number(m[2]));
		return mod ? `\x1b[1;${mod}${arrows[Number(m[1]) - 1]}` : data;
	}
	m = data.match(/^\x1b\[(5|6|7|8);(\d+)u$/);
	if (m) {
		const mod = legacyMod(Number(m[2]));
		if (!mod) return data;
		if (m[1] === "7") return `\x1b[1;${mod}H`;
		if (m[1] === "8") return `\x1b[1;${mod}F`;
		return `\x1b[${m[1]};${mod}~`;
	}
	m = data.match(/^\x1b\[27;(\d+);(6[5-8])~$/);
	if (m) {
		const mod = legacyMod(Number(m[1]));
		return mod ? `\x1b[1;${mod}${arrows[Number(m[2]) - 65]}` : data;
	}
	return data;
}

tui.addInputListener((raw): { consume: boolean; data?: string } | undefined => {
	// kitty-protocol terminals (flag 2 "report event types") deliver a press
	// (:1) AND a release (:3) event for every physical key. pi-tui filters
	// releases only right before the focused component — AFTER input
	// listeners — so without this, every key handled here (actions, pane nav)
	// fires twice per press and releases cancel confirms / recall history.
	if (isKeyRelease(raw) && !raw.includes("\x1b[200~")) return { consume: true };

	const data = normalizeScrollKeySequence(raw);
	// A pending confirm owns every key: Enter confirms, Esc/ctrl+c cancels.
	// Consumed before the picker/editor/actions so nothing else acts mid-gate.
	if (pendingConfirm) {
		const cb = pendingConfirm.onConfirm;
		if (matchesKey(data, "enter")) {
			pendingConfirm = null;
			void cb();
		} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			pendingConfirm = null;
			addLine(colors.muted("Cancelled."));
		}
		tui.requestRender();
		return { consume: true };
	}

	// While the fuzzy picker is open, every key belongs to it (its own
	// listener consumes them; we must not act on them here — including
	// Ctrl+C, which the picker treats as cancel).
	if (pickerActive()) return undefined;

	// `>` on an empty prompt opens the combined fuzzy finder (sessions ·
	// layouts · targets). Consumed so the raw `>` never lands in the editor
	// buffer or history; the picker draws its own `> ` prompt, so the one
	// you typed appears to "stick" seamlessly. Paste/recall of a whole
	// `> <query>` line is routed in repl.ts's handleReplInput instead.
	if (data === ">" && !editor.getText()) {
		void handleOpen(replCtx);
		return { consume: true };
	}

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
	if (!editor.getText() && PANE_NAV_KEYS.some((name) => matchesKey(data, name))) {
		scrollActivePane(data);
		return { consume: true };
	}

	// Let the focused editor see rewritten (legacy) sequences instead of the
	// raw exotic bytes it would otherwise receive unchanged.
	if (data !== raw) return { consume: false, data };
	return undefined;
});

// The startup banner (pi-style [tag] lines) is printed by
// resolveStartupSession once it has decided whether to restore a session,
// so the [session]/[target]/[layout] tags always reflect the live state.
updateStatus();

tui.start();

// Startup sessions (pi-flag style): `--session <name>` / `-r <name>` opens
// that session, `--resume` restores the most recently saved one. Runs after
// the screen is up so the restore's transcript lines land on the visible pipe.
async function resolveStartupSession(): Promise<void> {
	const args = process.argv.slice(2);
	const sessionIndex = args.indexOf("--session");
	const shortIndex = args.indexOf("-r");
	const resume = args.includes("--resume");
	// `-r <name>` is the short alias for `--session <name>` — the form the
	// quit screen prints, so the hint is copy-paste runnable.
	const name =
		(sessionIndex !== -1 && args[sessionIndex + 1] ? args[sessionIndex + 1]! : undefined) ??
		(shortIndex !== -1 && args[shortIndex + 1] ? args[shortIndex + 1]! : undefined);
	if (name) {
		const meta = store().sessions.list().find((s) => s.name === name);
		if (meta) await restoreSession(name);
		else replCtx.io.error(`no saved session '${name}'. /open shows them.`);
	} else if (resume) {
		const list = store().sessions.list();
		if (list.length === 0) {
			replCtx.io.info("No saved sessions to resume. Set up a target and it will auto-save.");
		} else {
			// For now --resume restores the most recent saved session.
			await restoreSession(list[list.length - 1]!.name);
		}
	}
	printIntro();
}
	setTimeout(resolveStartupSession, 0);