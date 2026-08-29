/**
 * Settings view — the effective configuration as a transcript render.
 *
 * One pure renderer consumed by `/settings`. It shows every section of the
 * effective config from config.ts — theme roles, gdb, keybindings (rendered
 * from the live action chords, so remaps stay true), sessions paths,
 * defaults, and the reserved windows/agent sections — annotated with the
 * provenance recorded per section (defaults · ~/.aidbrc · ./.aidb.json).
 *
 * Keybinding chords are drawn from the config values rather than the hard
 * defaults, and config/sources are read through getters at render time so a
 * `/config reload` is reflected immediately.
 */

import { keyLabel, type Action, type Config, type ConfigSources } from "../config.ts";
import { colors } from "../theme.ts";

/** Human label for a full chord list, e.g. ["ctrl+up","pageUp"] -> "Ctrl+Up/PgUp". */
function chordLabel(chords: readonly string[]): string {
	if (!chords || chords.length === 0) return "—";
	return chords.map((c) => keyLabel(c)).join("/");
}

/** Short action-name -> readable label. */
const ACTION_LABELS: Record<Action, string> = {
	continue: "continue",
	stepOver: "step over",
	stepInto: "step into",
	stepOut: "step out",
	scrollUp: "scroll up",
	scrollDown: "scroll down",
	open: "/open finder",
};

function themeLine(role: string, code: number): string {
	return `${role}${colors.number(String(code))}`;
}

/**
 * Render the settings sections. Pure: same config + sources => same lines.
 * The returned lines are already coloured; cap at SETTINGS_WIDTH for narrow
 * terminals (the transcript/pane clips anyway).
 */
export function renderSettings(config: Config, sources: ConfigSources): string[] {
	const out: string[] = [];
	const push = (line: string): void => {
		if (line.trim()) out.push(line);
	};
	const origin = (key: keyof Config): string => colors.muted(`(${sources.sectionOrigin[key] ?? "defaults"})`);
	const section = (label: string): void => {
		push(`${colors.accent(label.padEnd(11))} `);
	};

	push(colors.accent(`settings — effective configuration`));
	push(colors.muted(`  /config reload re-applies; files: ${[sources.project, sources.rc].filter(Boolean).join(" + ") || "defaults"}`));

	/* theme */
	push("");
	section("theme");
	const t = config.theme;
	push(`${colors.muted("  roles:")} ${themeLine("accent", t.accent)} · ${themeLine("muted", t.muted)} · ${themeLine("success", t.success)} · ${themeLine("warning", t.warning)} · ${themeLine("error", t.error)}`);
	push(`${colors.muted("  frame:")} ${themeLine("border", t.border)} · ${themeLine("borderActive", t.borderActive)} · ${themeLine("borderInactive", t.borderInactive)} · ${themeLine("paneBg", t.paneBg)}`);
	push(`${colors.muted("  tokens:")} ${themeLine("keyword", t.keyword)} · ${themeLine("string", t.string)} · ${themeLine("number", t.number)} · ${themeLine("comment", t.comment)}`);
	push(`${colors.muted("  asm:")}    ${themeLine("mnemonic", t.mnemonic)} · ${themeLine("register", t.register)} · ${themeLine("directive", t.directive)} ${origin("theme")}`);

	/* gdb */
	push("");
	section("gdb");
	push(`  path ${colors.success(config.gdb.path)} · args ${config.gdb.args.length ? config.gdb.args.join(" ") : `(${colors.muted("none")})`} · env ${Object.keys(config.gdb.env).length ? Object.keys(config.gdb.env).join(",") : `(${colors.muted("none")})`} ${origin("gdb")}`);

	/* keybindings */
	push("");
	section("keybindings");
	for (const action of Object.keys(ACTION_LABELS) as Action[]) {
		const chords = config.keybindings.actions[action];
		push(`  ${ACTION_LABELS[action].padEnd(13)} ${colors.success(chordLabel(chords))}`);
	}
	push(`  ${colors.muted("editor overrides:")} ${Object.keys(config.keybindings.editor).length ? Object.entries(config.keybindings.editor).map(([k, v]) => `${k}=${chordLabel(v)}`).join(" · ") : `(${colors.muted("none")})`} ${origin("keybindings")}`);

	/* sessions */
	push("");
	section("sessions");
	push(`  dir ${colors.success(config.sessions.sessionDir)}`);
	push(`  history ${colors.success(config.sessions.historyPath)} · autoSave ${config.sessions.autoSave ? colors.success("on") : colors.warning("off")} ${origin("sessions")}`);

	/* defaults */
	push("");
	section("defaults");
	push(`  breakStyle ${colors.success(config.defaults.breakStyle)} · stepBehavior ${colors.success(config.defaults.stepBehavior)} ${origin("defaults")}`);

	/* windows / agent (reserved) */
	push("");
	section("windows");
	push(`  ${colors.muted("(reserved — parsed but not yet wired: layout presets, manifest dir, refresh policy)")} ${origin("windows")}`);
	push("");
	section("agent");
	push(`  ${colors.muted("(reserved — parsed but not yet wired: tool permissions, approval gates)")} ${origin("agent")}`);

	if (sources.issues.length > 0) {
		push("");
		push(colors.warning(`config issues (${sources.issues.length}):`));
		for (const issue of sources.issues) push(colors.warning(`  ${issue.path}: ${issue.message}`));
	}

	return out;
}

/**
 * A binding whose snapshot is the rendered settings. The config/sources are
 * read through getters so a `/config reload` is reflected on the next fetch.
 */