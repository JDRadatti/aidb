/**
 * Layered configuration for aidb (TODO P1: "Layered config").
 *
 * Load order (later wins, deep-merged per field):
 *   defaults < ~/.aidbrc < ./.aidb.json
 *
 * Both files are JSON (config is data, not commands). A malformed file or an
 * unknown/invalid field never crashes the REPL: validation coerces or drops a
 * bad field with an actionable `Issue`, falling back to the default for that
 * field. The loader also records *where* each top-level section came from so
 * `/config show` can print provenance.
 *
 * Not every section is wired into the running app yet; `windows` and `agent`
 * are parsed-and-ignored (reserved), so the schema is the stable public
 * contract and only the fields we can back with real behaviour are honoured.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

/* ------------------------------------------------------------------ types */

export interface ThemeConfig {
	/** ANSI SGR colour codes (e.g. 36 = cyan) for each colour role. */
	accent: number;
	muted: number;
	success: number;
	warning: number;
	error: number;
	/** Border / scrollbar edge colour. */
	border: number;
	/** Focused pane outline (white). */
	borderActive: number;
	/** Non-focused pane outline (subtle gray). */
	borderInactive: number;
	/** 256-colour background fill shared by every pane. */
	paneBg: number;
	/* Semantic token roles; source and assembly use the same set. */
	keyword: number;
	string: number;
	number: number;
	comment: number;
	mnemonic: number;
	register: number;
	directive: number;
}

export interface GdbConfig {
	/** Path to the gdb binary. */
	path: string;
	/** Extra argv passed to gdb. */
	args: string[];
	/** Environment variables to set for gdb. */
	env: Record<string, string>;
}

export interface SessionsConfig {
	/** File the REPL history is persisted to. */
	historyPath: string;
	/** Directory future session snapshots (breakpoints/layout) will live in. */
	sessionDir: string;
	/** Disable auto-saving sessions on every change (default: on). */
	autoSave: boolean;
}

export interface DefaultsConfig {
	/** Reserved placeholders for user-editable command defaults. */
	breakStyle: string;
	stepBehavior: string;
}

/** Reserved: layout presets, manifest dir, refresh policy. Parsed but unused. */
export interface WindowsConfig {
	[key: string]: unknown;
}

/** Reserved: tool permissions, approval gates. Parsed but unused. */
export interface AgentConfig {
	[key: string]: unknown;
}

export type ConfigIssue = { path: string; message: string };

/** Actions the TUI dispatches on input; config maps these to key chords. */
export const ACTIONS = [
	"continue",
	"stepOver",
	"stepInto",
	"stepOut",
	"scrollUp",
	"scrollDown",
	"open",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface KeybindingsConfig {
	/** aidb action -> key chords. */
	actions: Record<Action, KeyId[]>;
	/** pi-tui built-in keybinding overrides (editor history etc.). */
	editor: Record<string, KeyId[]>;
}

export interface Config {
	theme: ThemeConfig;
	gdb: GdbConfig;
	keybindings: KeybindingsConfig;
	defaults: DefaultsConfig;
	sessions: SessionsConfig;
	windows: WindowsConfig;
	agent: AgentConfig;
}

/* ------------------------------------------------------------ default config */

const HOME = os.homedir();

export const DEFAULT_ACTIONS: Record<Action, KeyId[]> = {
	continue: ["f5"],
	stepOver: ["f10"],
	stepInto: ["f11"],
	stepOut: ["shift+f11"],
	scrollUp: ["ctrl+up", "pageUp"],
	scrollDown: ["ctrl+down", "pageDown"],
	open: ["alt+o"],
};

export const DEFAULT_EDITOR_BINDINGS: Record<string, KeyId[]> = {
	"tui.editor.historyPrevious": ["ctrl+p"],
	"tui.editor.historyNext": ["ctrl+n"],
};

export const DEFAULT_CONFIG: Config = {
	theme: {
		accent: 36,
		muted: 90,
		success: 32,
		warning: 33,
		error: 31,
		border: 90,
		borderActive: 255,
		borderInactive: 234,
		paneBg: 235,
		keyword: 36,
		string: 32,
		number: 33,
		comment: 90,
		mnemonic: 93,
		register: 94,
		directive: 96,
	},
	gdb: { path: "gdb", args: [], env: {} },
	keybindings: {
		actions: { ...DEFAULT_ACTIONS },
		editor: { ...DEFAULT_EDITOR_BINDINGS },
	},
	defaults: { breakStyle: "line", stepBehavior: "continue" },
	sessions: {
		historyPath: path.join(HOME, ".aidb_history"),
		sessionDir: path.join(HOME, ".config", "aidb", "sessions"),
		autoSave: true,
	},
	windows: {},
	agent: {},
};

/* ------------------------------------------------------------------ merge */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge patch into target. Arrays and scalars are replaced wholesale. */
function deepMerge<T>(target: T, patch: unknown): T {
	if (!isPlainObject(patch)) return target;
	if (!isPlainObject(target)) return patch as unknown as T;
	const out: Record<string, unknown> = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		const base = (target as Record<string, unknown>)[key];
		out[key] = isPlainObject(value) && isPlainObject(base) ? deepMerge(base, value) : value;
	}
	return out as unknown as T;
}

/* --------------------------------------------------------------- validate */

/** Fill in missing sections/fields from defaults, drop invalid fields. */
export function validateConfig(raw: unknown, issues: ConfigIssue[] = []): Config {
	const section = (name: keyof Config): unknown =>
		isPlainObject(raw) && raw[name] !== undefined ? raw[name] : DEFAULT_CONFIG[name];

	const themeRaw = section("theme");
	const gdbRaw = section("gdb");
	const defaultsRaw = section("defaults");
	const sessionsRaw = section("sessions");
	const keyRaw = section("keybindings");

	/* theme */
	const pickColor = (key: keyof ThemeConfig, fallback: number): number => {
		const v = isPlainObject(themeRaw) ? themeRaw[key] : undefined;
		if (v === undefined) return fallback;
		if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 256) return v;
		issues.push({ path: `theme.${key}`, message: `expected an ANSI colour code (0-256), got ${JSON.stringify(v)}` });
		return fallback;
	};
	const themeKeys = [
		"accent", "muted", "success", "warning", "error", "border",
		"borderActive", "borderInactive", "paneBg", "keyword", "string", "number", "comment", "mnemonic", "register", "directive",
	] as const;
	const theme = {} as ThemeConfig;
	for (const key of themeKeys) {
		theme[key] = pickColor(key, DEFAULT_CONFIG.theme[key]);
	}

	/* gdb */
	const asString = (v: unknown, p: string, fallback: string): string => {
		if (v === undefined) return fallback;
		if (typeof v === "string") return v;
		issues.push({ path: p, message: `expected a string, got ${JSON.stringify(v)}` });
		return fallback;
	};
	const asStringArray = (v: unknown, p: string, fallback: string[]): string[] => {
		if (v === undefined) return fallback;
		if (Array.isArray(v) && v.every((x) => typeof x === "string")) return [...v];
		issues.push({ path: p, message: `expected an array of strings, got ${JSON.stringify(v)}` });
		return fallback;
	};
	const asBoolean = (v: unknown, p: string, fallback: boolean): boolean => {
		if (v === undefined) return fallback;
		if (typeof v === "boolean") return v;
		issues.push({ path: p, message: `expected a boolean, got ${JSON.stringify(v)}` });
		return fallback;
	};
	const gdb: GdbConfig = {
		path: asString(isPlainObject(gdbRaw) ? gdbRaw.path : undefined, "gdb.path", DEFAULT_CONFIG.gdb.path),
		args: asStringArray(isPlainObject(gdbRaw) ? gdbRaw.args : undefined, "gdb.args", []),
		env: isPlainObject(gdbRaw) && isPlainObject(gdbRaw.env) ? { ...(gdbRaw.env as Record<string, string>) } : {},
	};

	/* defaults */
	const defaults: DefaultsConfig = {
		breakStyle: asString(
			isPlainObject(defaultsRaw) ? defaultsRaw.breakStyle : undefined,
			"defaults.breakStyle",
			DEFAULT_CONFIG.defaults.breakStyle,
		),
		stepBehavior: asString(
			isPlainObject(defaultsRaw) ? defaultsRaw.stepBehavior : undefined,
			"defaults.stepBehavior",
			DEFAULT_CONFIG.defaults.stepBehavior,
		),
	};

	/* sessions */
	const sessions: SessionsConfig = {
		historyPath: asString(
			isPlainObject(sessionsRaw) ? sessionsRaw.historyPath : undefined,
			"sessions.historyPath",
			DEFAULT_CONFIG.sessions.historyPath,
		),
		sessionDir: asString(
			isPlainObject(sessionsRaw) ? sessionsRaw.sessionDir : undefined,
			"sessions.sessionDir",
			DEFAULT_CONFIG.sessions.sessionDir,
		),
		autoSave: asBoolean(
			isPlainObject(sessionsRaw) ? sessionsRaw.autoSave : undefined,
			"sessions.autoSave",
			DEFAULT_CONFIG.sessions.autoSave,
		),
	};

	/* keybindings */
	const bindingsRaw = isPlainObject(keyRaw) ? keyRaw : {};
	const actionsRaw = isPlainObject(bindingsRaw.actions) ? bindingsRaw.actions : undefined;
	const editorRaw = isPlainObject(bindingsRaw.editor) ? bindingsRaw.editor : undefined;

	const isChordArray = (v: unknown): v is KeyId[] =>
		Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
	const pickChords = (
		v: unknown,
		p: string,
		fallback: KeyId[],
	): KeyId[] => {
		if (v === undefined) return fallback;
		if (isChordArray(v)) return [...v];
		issues.push({ path: p, message: `expected a key chord array like ["f5","ctrl+r"], got ${JSON.stringify(v)}` });
		return fallback;
	};

	const actions = {} as Record<Action, KeyId[]>;
	for (const action of ACTIONS) {
		const fallback = DEFAULT_CONFIG.keybindings.actions[action];
		actions[action] = pickChords(
			isPlainObject(actionsRaw) ? actionsRaw[action] : undefined,
			`keybindings.actions.${action}`,
			fallback,
		);
	}

	const editor: Record<string, KeyId[]> = {};
	if (isPlainObject(editorRaw)) {
		for (const [k, v] of Object.entries(editorRaw)) {
			if (isChordArray(v)) editor[k] = [...v];
			else issues.push({ path: `keybindings.editor.${k}`, message: `invalid chord array ${JSON.stringify(v)}` });
		}
	}

	return { theme, gdb, defaults, sessions, keybindings: { actions, editor }, windows: {}, agent: {} };
}

/* ---------------------------------------------------------------- loading */

export interface ConfigSources {
	/** The project-local config file (./.aidb.json), if present. */
	project?: string;
	/** The user config file (~/.aidbrc), if present. */
	rc?: string;
	/** Invalid fields that were dropped/coerced, plus any unparseable files. */
	issues: ConfigIssue[];
	/** For each top-level section, which source (defaults/rc/project) supplies it. */
	sectionOrigin: Record<keyof Config, string>;
}

type ReadResult = { ok: true; value: unknown } | { ok: false; error: string };

function readJson(file: string): ReadResult {
	try {
		const text = fs.readFileSync(file, "utf8");
		return { ok: true, value: JSON.parse(text) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: /Unexpected|position|parse/i.test(message) ? `not valid JSON (${message})` : message };
	}
}

/** Read a JSON config file, or report why it could not be used. */
export function readConfigFile(file: string): ReadResult {
	const missing = { ok: false as const, error: "missing" };
	if (!fs.existsSync(file)) return missing;
	return readJson(file);
}

/**
 * Load and merge configuration from defaults, ~/.aidbrc and ./.aidb.json.
 * Never throws: read/parse/validation problems surface as `sources.issues`.
 */
export function loadConfig(
	paths?: { home?: string; project?: string },
): { config: Config; sources: ConfigSources } {
	const homeFile = paths?.home ?? path.join(HOME, ".aidbrc");
	const projectFile = paths?.project ?? path.join(process.cwd(), ".aidb.json");

	const homeResult = readConfigFile(homeFile);
	const projectResult = readConfigFile(projectFile);

	// No file loads exactly the last effective doc; start from a copy of defaults.
	const merged: Record<string, unknown> = {};
	// Later (project) sources consulted first so they win over rc over defaults.
	const sectionOrigin: Record<string, string> = {};
	for (const name of Object.keys(DEFAULT_CONFIG)) sectionOrigin[name] = "defaults";

	// Merge order (lowest -> highest precedence) is rc then project, so project
	// wins the deep-merge per field.
	let raw: unknown = { ...DEFAULT_CONFIG };
	const issues: ConfigIssue[] = [];

	for (const [result, label] of [
		[homeResult, "~/.aidbrc"],
		[projectResult, "./.aidb.json"],
	] as const) {
		if (result.ok) raw = deepMerge(raw, result.value);
	}

	// Provenance, processed high->low precedence so the highest source that
	// defines a section claims it.
	const applyOrigin = (value: unknown, label: string) => {
		if (!isPlainObject(value)) return;
		for (const name of Object.keys(sectionOrigin)) {
			if (value[name] !== undefined && sectionOrigin[name] === "defaults") {
				sectionOrigin[name] = label;
			}
		}
	};
	for (const [result, label] of [
		[projectResult, "./.aidb.json"],
		[homeResult, "~/.aidbrc"],
	] as const) {
		if (result.ok) applyOrigin(result.value, label);
	}

	if (!projectResult.ok && projectResult.error !== "missing") {
		issues.push({ path: "./.aidb.json", message: `ignored: ${projectResult.error}` });
	}
	if (!homeResult.ok && homeResult.error !== "missing") {
		issues.push({ path: "~/.aidbrc", message: `ignored: ${homeResult.error}` });
	}

	const config = validateConfig(raw, issues);

	const sources: ConfigSources = {
		project: projectResult.ok ? projectFile : undefined,
		rc: homeResult.ok ? homeFile : undefined,
		issues,
		sectionOrigin: sectionOrigin as Record<keyof Config, string>,
	};
	return { config, sources };
}

/** Resolve a raw input to the configured Action it triggers, or null. */
export function resolveAction(bindings: Record<Action, KeyId[]>, data: string): Action | null {
	for (const action of ACTIONS) {
		if (bindings[action].some((chord) => matchesKey(data, chord))) return action;
	}
	return null;
}

/** Human-readable label for a key id, e.g. "shift+f11" -> "Shift-F11". */
export function keyLabel(chord: string): string {
	return chord
		.split("+")
		.map((part) => {
			if (part === "ctrl") return "Ctrl";
			if (part === "shift") return "Shift";
			if (part === "alt") return "Alt";
			if (part === "super") return "Super";
			if (part.length === 1) return part.toUpperCase();
			return `${part[0].toUpperCase()}${part.slice(1)}`;
		})
		.join("+");
}

/** Label of the first chord bound to an action, or "…" when unbound. */
export function actionKeyLabel(actions: Record<Action, KeyId[]>, action: Action): string {
	const chords = actions[action];
	return chords && chords.length > 0 ? keyLabel(chords[0]) : "—";
}