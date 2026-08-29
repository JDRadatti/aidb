/**
 * Startup banner — pi-style bracketed capability tags, annotated with live
 * state. One pure generator: the host (main.ts) builds an IntroState from the
 * stores/config/api and prints each returned line to the transcript.
 *
 * Rules:
 *  - Every `[tag]` line is a *capability*: it lists what aidb can do, and the
 *    annotation is current state, not copy.
 *  - `viz` is generated from the interpreter registry at build time (via the
 *    caller passing the list), so it can't advertise something we don't ship.
 *  - `keys` is generated from the action keybindings (already remapped), so
 *    remaps stay true.
 *  - Lines are capped so the tags survive narrow terminals.
 *
 * Unit/golden testable: no terminal, no debugger, no stores.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { colors } from "./theme.ts";

export const INTRO_WIDTH = 76;

export interface IntroTarget {
	name: string | null;
	program: string | null;
	args: string[];
	kind: "launch" | "attach";
	pid?: number;
}

export interface IntroState {
	/** Debugger label, e.g. "GDB debugger via DAP". */
	debuggerLabel: string;
	/** gdb session state ("stopped" | "running" | "idle" | ...). */
	gdbState: string;
	session: {
		name: string | null;
		breakpoints: number;
		pending: number;
		autoSave: boolean;
	};
	target: IntroTarget | null;
	layout: {
		name: string | null;
		paneIds: string[];
	};
	/** The visualizer keywords this build ships (from the registry). */
	viz: string[];
	/** Short key-hint string, e.g. "F5 continue · F10 next". */
	keys: string;
	config: {
		found: string[];
		issues: number;
	};
	/** Persisted command count, or null when unavailable. */
	history: number | null;
}

const tag = (label: string): string => colors.accent(`[${label}]`);

/** Truncate a colored line to INTRO_WIDTH (ANSI-aware; no ellipsis). */
function cap(line: string): string {
	return truncateToWidth(line, INTRO_WIDTH, "", false);
}

/** Plain (uncolored) summary of a target, e.g. `./game --seed 42`. */
function targetLine(target: IntroTarget): string {
	const base = target.program ?? (target.kind === "attach" ? `attach pid ${target.pid ?? "?"}` : "—");
	const args = target.args.length > 0 ? ` ${target.args.join(" ")}` : "";
	return `${base}${args}`;
}

/**
 * Render the banner. Pure: given the same state, produces the same lines.
 * The returned lines are already colored and capped.
 */
export function renderIntro(state: IntroState): string[] {
	const out: string[] = [];
	const push = (line: string): void => {
		if (line.trim()) out.push(cap(line));
	};

	push(colors.accent(`${state.debuggerLabel}`));
	push(colors.muted("\u2500".repeat(Math.min(INTRO_WIDTH, 52))));

	/* [session] — name · bp count · pending · auto-save */
	let sessionLine = `${tag("session")} `;
	const name = state.session.name;
	if (name) {
		sessionLine += `${colors.bold(colors.accent(name))} · `;
	} else {
		sessionLine += `${colors.muted("fresh session")} · `;
	}
	const bpParts: string[] = [];
	if (state.session.pending > 0) {
		bpParts.push(colors.warning(`${state.session.breakpoints} bp (${state.session.pending} pending)`));
	} else {
		bpParts.push(colors.muted(`${state.session.breakpoints} bp`));
	}
	const autoSave = state.session.autoSave
		? colors.success("\u25cf auto-save on")
		: colors.muted("auto-save off");
	sessionLine += `${bpParts.join(" · ")} · ${autoSave} · ${colors.muted(state.gdbState)}`;
	push(sessionLine);

	/* [target] */
	if (state.target) {
		const shared = state.target.name ? ` · ${colors.muted(`profile: ${state.target.name}`)}` : "";
		push(`${tag("target")}  ${colors.muted("—")} ${targetLine(state.target)}${shared}`);
	} else {
		push(`${tag("target")}  ${colors.muted("none yet — file <program> or run <program> [args…]")}`);
	}

	/* [layout] */
	if (state.layout.paneIds.length === 1 && state.layout.paneIds[0] === "repl") {
		push(`${tag("layout")}  ${colors.muted("single-pane repl")}`);
	} else if (state.layout.paneIds.length > 0) {
		const panes = state.layout.paneIds.length === 1 ? "1 pane" : `${state.layout.paneIds.length} panes`;
		const ids = state.layout.name ? `${state.layout.name} · ` : "";
		push(`${tag("layout")}  ${ids}${panes} (${state.layout.paneIds.join(" · ")})`);
	} else {
		push(`${tag("layout")}  ${colors.muted("none")}`);
	}

	/* [windows] — static capability line. */
	push(`${tag("windows")} vsplit · hsplit · close · load · pick — ${colors.muted("/win")}`);

	/* [viz] — generated from the interpreter list the caller passes. */
	if (state.viz.length > 0) {
		push(`${tag("viz")}     ${state.viz.join(" · ")}`);
	}

	/* [keys] — remap-aware. */
	if (state.keys) {
		push(`${tag("keys")}    ${state.keys} · ${colors.muted("remappable in ~/.aidbrc")}`);
	}

	/* [config] */
	const configLine = `${tag("config")}  ${colors.muted(state.config.found.join(" + ") || "defaults")}` +
		(state.config.issues > 0 ? ` · ${colors.warning(`${state.config.issues} issue${state.config.issues === 1 ? "" : "s"}`)}` : "");
	push(configLine);

	/* [history] */
	if (state.history !== null) {
		push(`${tag("history")} ${state.history} command${state.history === 1 ? "" : "s"} remembered · ${colors.muted("Ctrl+P/N to recall")}`);
	}

	push(colors.muted("\u2500".repeat(Math.min(INTRO_WIDTH, 52))));
	push(colors.muted("tip: break <file:line> first, then run. /help for the full sheet."));
	return out;
}