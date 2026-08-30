/**
 * Startup banner — pi-style bracketed capability tags, annotated with the
 * *saved* state: one indented line per saved session / target / layout. One
 * pure generator: the host (main.ts) builds an IntroState from the stores
 * and prints each returned line to the transcript.
 *
 * Rules:
 *  - Every `[tag]` line names a collection (sessions/targets/layouts) and is
 *    followed by one indented line per saved item, `✳` marking the current
 *    one (same mark the pickers use).
 *  - After the divider the banner only points at /help (the full command
 *    sheet lives there); it doesn't duplicate the list.
 *  - Lines are capped so the tags survive narrow terminals.
 *
 * Unit/golden testable: no terminal, no debugger, no stores.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { colors } from "./theme.ts";

export const INTRO_WIDTH = 76;

export interface IntroSessionItem {
	name: string;
	/** True for the session currently restored. */
	current: boolean;
	target: string | null;
	layout: string | null;
	breakpoints: number;
}
export interface IntroTargetItem {
	name: string;
	current: boolean;
	kind: "launch" | "attach";
	program?: string;
	args: string[];
	pid?: number;
}
export interface IntroLayoutItem {
	name: string;
	current: boolean;
	panes: number;
	watchEntries: number;
	livePaneCount: number;
}

export interface IntroState {
	/** Debugger label, e.g. "GDB debugger via DAP". */
	debuggerLabel: string;
	/** Whether session state auto-saves (config.sessions.autoSave). */
	autoSave: boolean;
	sessions: IntroSessionItem[];
	targets: IntroTargetItem[];
	layouts: IntroLayoutItem[];
}

const tag = (label: string): string => colors.accent(`[${label}]`);
const indent = (line: string): string => `  ${line}`;
const DIVIDER = colors.muted("\u2500".repeat(Math.min(INTRO_WIDTH, 52)));

/** Truncate a colored line to INTRO_WIDTH (ANSI-aware; no ellipsis). */
function cap(line: string): string {
	return truncateToWidth(line, INTRO_WIDTH, "", false);
}

/** `name ✳` when the item is the one currently open; plain name otherwise. */
function nameTag(name: string, current: boolean): string {
	const base = colors.bold(colors.accent(name));
	return current ? `${base}${colors.muted(" ✳")}` : base;
}

/** `name ✳ · target · layout · bp 3` (bare names, same grammar as the pickers). */
function sessionItem(s: IntroSessionItem): string {
	const tail = `${s.target ?? "no target"} · ${s.layout ?? "no layout"} · bp ${s.breakpoints}`;
	return `${nameTag(s.name, s.current)} · ${colors.muted(tail)}`;
}

/** `name ✳ · ./game --seed 42` (or `attach pid 1234`). */
function targetItem(t: IntroTargetItem): string {
	const cmd = t.kind === "launch" ? (t.program ?? "?") : `attach pid ${t.pid ?? "?"}`;
	const args = t.args.length > 0 ? ` ${t.args.join(" ")}` : "";
	return `${nameTag(t.name, t.current)} · ${colors.muted(`${cmd}${args}`)}`;
}

/** `name ✳ · 4 panes · 2 watch · 1 live`. */
function layoutItem(l: IntroLayoutItem): string {
	const parts = [`${l.panes} ${l.panes === 1 ? "pane" : "panes"}`, `${l.watchEntries} watch`];
	if (l.livePaneCount > 0) parts.push(`${l.livePaneCount} live`);
	return `${nameTag(l.name, l.current)} · ${colors.muted(parts.join(" · "))}`;
}

/** A `[tag]` line + its saved item lines (or a hint when the collection is empty). */
function collectionLines(tagName: string, items: string[], empty: string): string[] {
	const lines = [tag(tagName)];
	if (items.length === 0) {
		lines.push(indent(colors.muted(empty)));
	} else {
		for (const item of items) lines.push(indent(item));
	}
	return lines;
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

	push(colors.accent(state.debuggerLabel));
	push(DIVIDER);

	/* [sessions] — one indented line per saved session. */
	for (const line of collectionLines(
		"sessions",
		state.sessions.map(sessionItem),
		state.autoSave ? "none yet — set up a target and this session auto-saves here"
			: "off — sessions.autoSave is false in the config",
	)) push(line);

	/* [targets] */
	for (const line of collectionLines(
		"targets",
		state.targets.map(targetItem),
		"none yet — run <program> [args…] creates one",
	)) push(line);

	/* [layouts] */
	for (const line of collectionLines(
		"layouts",
		state.layouts.map(layoutItem),
		"none yet — /layout save <name> keeps your panes",
	)) push(line);

	push(DIVIDER);

	/* The full command sheet lives in /help; the banner only points at it. */
	push(`${colors.muted("/help")} — full command reference: debugging verbs, windows, slash commands`);
	return out;
}