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
 * The `theme` section is either a bare preset name (`"theme": "dracula"`),
 * an object of per-role overrides, or `{ "preset": "<name>", ...roles }`
 * (preset plus overrides). Presets are ports of the classic palettes herdr
 * ships (see `THEME_PRESETS`); the hand-tuned default palette stays untouched
 * so nothing changes until you opt in.
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
	/** The prompt zone's frame (divider above the band, left rail). */
	inputBorder: number;
	/** Focused pane outline (white). */
	borderActive: number;
	/** Non-focused pane outline (subtle gray). */
	borderInactive: number;
	/** 256-colour background fill shared by every pane. */
	paneBg: number;
	/* Semantic token roles; source and assembly use the same set. Named to
	 * match nvim's standard treesitter highlight groups (@keyword, @string,
	 * @number, @comment, @function, @type, @preproc, @label) so a theme
	 * ported from nvim maps key-for-key; mnemonic/register keep nvim's legacy
	 * asm syntax names. `directive` is accepted as a deprecated alias for
	 * `preproc`. */
	keyword: number;
	string: number;
	number: number;
	comment: number;
	/** C builtin types (int, char, void, …) — nvim `@type`. */
	type: number;
	/** Preprocessor directives (`#include`) and asm directives (`.section`) — nvim `@preproc`. */
	preproc: number;
	mnemonic: number;
	register: number;
	/** Function/symbol label colour in assembly columns. */
	function: number;
	/** Assembly jump-target suffixes (`<main+77>`) — nvim `@label`; keep dim. */
	label: number;
	/** Light colour for `<placeholder>` args in command help / hints. */
	placeholder: number;
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
	/** Disable auto-saving sessions on every change (default: off — mirroring
	 * layouts, sessions/targets persist only via explicit `/session save` and
	 * `/target save`; flip to true to auto-save on every change). */
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

/** How the prompt + popup zone is framed. `line` draws a divider above the
 * popup band ("the line above the prompt is also above the popups");
 * `line+rail` additionally draws a left rail in theme.inputBorder on the
 * band and the prompt line. `off` keeps the chrome-less look. */
export type PromptZone = "off" | "line" | "line+rail";

export interface UiConfig {
	promptZone: PromptZone;
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
	"clearScreen",
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
	ui: UiConfig;
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
	// cmd/bash-style: clear the terminal transcript (typed input is preserved).
	clearScreen: ["ctrl+l"],
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
		inputBorder: 240,
		borderActive: 255,
		borderInactive: 234,
		paneBg: 235,
		keyword: 36,
		string: 32,
		number: 33,
		comment: 90,
		type: 36,
		preproc: 96,
		mnemonic: 93,
		register: 94,
		function: 95,
		label: 102,
		placeholder: 245,
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
		autoSave: false,
	},
	windows: {},
	agent: {},
	ui: { promptZone: "line" },
};

/* ------------------------------------------------------------------ merge */

/**
 * Built-in named theme presets — ports of the classic palettes herdr ships
 * (herdr `src/app/state.rs` `Palette`, `theme.name = "…"`). Each herdr role
 * maps onto an aidb role: accent→accent, subtext0→muted, green/yellow/red→
 * success/warning/error, overlay0→border+comment, overlay1→inputBorder+
 * placeholder, text→borderActive, surface_dim→borderInactive, panel_bg→
 * paneBg. The semantic token roles are named after nvim's treesitter
 * highlight groups (keyword/string/number/comment/type/preproc/label +
 * asm mnemonic/register) and set to the theme's canonical nvim-token
 * colours where they differ from the UI accent; `label` — the dim
 * assembly jump-target suffix colour — takes the theme's quiet overlay
 * tone. RGB values are converted to the nearest xterm-256 code. `terminal`
 * (herdr's pass-through) is omitted intentionally: aidb's roles are
 * 256-colour codes, so the system palette is the default.
 */
export const THEME_PRESETS: Record<string, ThemeConfig> = {
	/** Catppuccin Mocha — herdr's default. */
	"catppuccin": {
		accent: 111, muted: 146, success: 151, warning: 223, error: 211, placeholder: 103,
		border: 243, inputBorder: 103, borderActive: 189, borderInactive: 235, paneBg: 234,
		keyword: 111, string: 151, number: 223, comment: 243, type: 223, preproc: 216,
		mnemonic: 183, register: 116, label: 103, function: 111,
	},
	/** Catppuccin Latte — the light Catppuccin flavor. */
	"catppuccin-latte": {
		accent: 27, muted: 243, success: 70, warning: 172, error: 161, placeholder: 246,
		border: 248, inputBorder: 246, borderActive: 240, borderInactive: 255, paneBg: 255,
		keyword: 27, string: 70, number: 172, comment: 248, type: 172, preproc: 202,
		mnemonic: 99, register: 30, label: 103, function: 27,
	},
	/** Tokyo Night — blue-purple. */
	"tokyo-night": {
		accent: 111, muted: 146, success: 149, warning: 179, error: 210, placeholder: 60,
		border: 60, inputBorder: 60, borderActive: 153, borderInactive: 234, paneBg: 234,
		keyword: 111, string: 149, number: 179, comment: 60, type: 141, preproc: 215,
		mnemonic: 141, register: 117, label: 60, function: 111,
	},
	/** Tokyo Night Day — the light Tokyo Night style. */
	"tokyo-night-day": {
		accent: 32, muted: 61, success: 240, warning: 95, error: 197, placeholder: 60,
		border: 103, inputBorder: 60, borderActive: 61, borderInactive: 188, paneBg: 254,
		keyword: 32, string: 240, number: 95, comment: 103, type: 97, preproc: 130,
		mnemonic: 97, register: 6, label: 103, function: 32,
	},
	/** Dracula — purple/pink/green. */
	"dracula": {
		accent: 141, muted: 188, success: 84, warning: 228, error: 203, placeholder: 103,
		border: 61, inputBorder: 103, borderActive: 255, borderInactive: 236, paneBg: 236,
		keyword: 141, string: 84, number: 228, comment: 61, type: 117, preproc: 215,
		mnemonic: 212, register: 117, label: 61, function: 117,
	},
	/** Nord — frosty blue. */
	"nord": {
		accent: 110, muted: 254, success: 144, warning: 186, error: 131, placeholder: 60,
		border: 240, inputBorder: 60, borderActive: 255, borderInactive: 237, paneBg: 237,
		keyword: 110, string: 144, number: 186, comment: 240, type: 109, preproc: 173,
		mnemonic: 139, register: 109, label: 60, function: 109,
	},
	/** Gruvbox Dark — warm retro. */
	"gruvbox": {
		accent: 172, muted: 187, success: 142, warning: 214, error: 203, placeholder: 138,
		border: 8, inputBorder: 138, borderActive: 187, borderInactive: 235, paneBg: 235,
		keyword: 172, string: 142, number: 214, comment: 8, type: 178, preproc: 208,
		mnemonic: 174, register: 108, label: 8, function: 108,
	},
	/** Gruvbox Light — the light retro palette. */
	"gruvbox-light": {
		accent: 24, muted: 239, success: 3, warning: 136, error: 124, placeholder: 242,
		border: 8, inputBorder: 242, borderActive: 237, borderInactive: 223, paneBg: 230,
		keyword: 24, string: 3, number: 136, comment: 8, type: 178, preproc: 130,
		mnemonic: 95, register: 65, label: 242, function: 24,
	},
	/** One Dark — Atom's classic dark theme. */
	"one-dark": {
		accent: 75, muted: 247, success: 108, warning: 180, error: 168, placeholder: 8,
		border: 241, inputBorder: 8, borderActive: 249, borderInactive: 236, paneBg: 236,
		keyword: 75, string: 108, number: 180, comment: 241, type: 180, preproc: 173,
		mnemonic: 176, register: 73, label: 59, function: 75,
	},
	/** One Light — Atom's classic light theme. */
	"one-light": {
		accent: 69, muted: 242, success: 71, warning: 136, error: 167, placeholder: 242,
		border: 247, inputBorder: 242, borderActive: 237, borderInactive: 255, paneBg: 15,
		keyword: 69, string: 71, number: 136, comment: 247, type: 180, preproc: 94,
		mnemonic: 127, register: 31, label: 247, function: 69,
	},
	/** Solarized Dark — Ethan Schoonover's classic. */
	"solarized": {
		accent: 32, muted: 245, success: 100, warning: 136, error: 166, placeholder: 66,
		border: 242, inputBorder: 66, borderActive: 247, borderInactive: 234, paneBg: 234,
		keyword: 32, string: 100, number: 136, comment: 242, type: 136, preproc: 166,
		mnemonic: 168, register: 36, label: 242, function: 32,
	},
	/** Solarized Light — Ethan Schoonover's light variant. */
	"solarized-light": {
		accent: 32, muted: 245, success: 100, warning: 136, error: 166, placeholder: 242,
		border: 247, inputBorder: 242, borderActive: 66, borderInactive: 254, paneBg: 230,
		keyword: 32, string: 100, number: 136, comment: 247, type: 136, preproc: 166,
		mnemonic: 168, register: 36, label: 242, function: 32,
	},
	/** Kanagawa — inspired by Katsushika Hokusai. */
	"kanagawa": {
		accent: 110, muted: 250, success: 101, warning: 143, error: 131, placeholder: 8,
		border: 242, inputBorder: 8, borderActive: 187, borderInactive: 235, paneBg: 235,
		keyword: 110, string: 101, number: 143, comment: 242, type: 179, preproc: 215,
		mnemonic: 103, register: 110, label: 242, function: 110,
	},
	/** Kanagawa Lotus — the light Kanagawa variant. */
	"kanagawa-lotus": {
		accent: 60, muted: 239, success: 65, warning: 95, error: 167, placeholder: 102,
		border: 247, inputBorder: 102, borderActive: 240, borderInactive: 187, paneBg: 229,
		keyword: 60, string: 65, number: 95, comment: 247, type: 95, preproc: 166,
		mnemonic: 60, register: 67, label: 248, function: 60,
	},
	/** Rosé Pine — muted, elegant. */
	"rose-pine": {
		accent: 182, muted: 252, success: 66, warning: 216, error: 168, placeholder: 103,
		border: 60, inputBorder: 103, borderActive: 189, borderInactive: 236, paneBg: 234,
		keyword: 182, string: 66, number: 216, comment: 60, type: 216, preproc: 174,
		mnemonic: 182, register: 152, label: 60, function: 66,
	},
	/** Rosé Pine Dawn — the light Rosé Pine variant. */
	"rose-pine-dawn": {
		accent: 103, muted: 8, success: 24, warning: 179, error: 132, placeholder: 8,
		border: 247, inputBorder: 8, borderActive: 239, borderInactive: 255, paneBg: 255,
		keyword: 103, string: 24, number: 179, comment: 247, type: 179, preproc: 174,
		mnemonic: 103, register: 67, label: 102, function: 24,
	},
	/** Vesper — minimal high-contrast monochrome with peach accents. */
	"vesper": {
		accent: 222, muted: 247, success: 122, warning: 222, error: 210, placeholder: 8,
		border: 59, inputBorder: 8, borderActive: 15, borderInactive: 233, paneBg: 234,
		keyword: 222, string: 122, number: 222, comment: 59, type: 222, preproc: 222,
		mnemonic: 223, register: 80, label: 59, function: 145,
	},
};

/** Canonical preset names, for `/config`, help text and the settings view. */
export const THEME_PRESET_NAMES: readonly string[] = Object.keys(THEME_PRESETS);

/**
 * Resolve a preset name to its canonical key, accepting herdr's aliases
 * (catppuccin-mocha, tokyonight, one-dark/onedark, ...) so configs written
 * against herdr's `theme.name` work unchanged. Returns `null` when unknown.
 */
export function canonicalThemeName(name: string): string | null {
	const key = name.toLowerCase().replace(/[ _]/g, "-");
	const alias: Record<string, string> = {
		"catppuccin-mocha": "catppuccin",
		latte: "catppuccin-latte",
		light: "catppuccin-latte",
		tokyonight: "tokyo-night",
		"tokyo-day": "tokyo-night-day",
		"tokyonight-day": "tokyo-night-day",
		"gruvbox-dark": "gruvbox",
		"solarized-dark": "solarized",
		"one-dark": "one-dark",
		"one-light": "one-light",
		"onedark": "one-dark",
		"onelight": "one-light",
		lotus: "kanagawa-lotus",
		rosepine: "rose-pine",
		"rosepine-dawn": "rose-pine-dawn",
		dawn: "rose-pine-dawn",
	};
	return alias[key] ?? (key in THEME_PRESETS ? key : null);
}

/** Dark/light classification for the preset picker rows and completions. */
export const THEME_PRESET_MODE: Record<string, "dark" | "light"> = {
	"catppuccin": "dark", "catppuccin-latte": "light",
	"tokyo-night": "dark", "tokyo-night-day": "light",
	"dracula": "dark", "nord": "dark",
	"gruvbox": "dark", "gruvbox-light": "light",
	"one-dark": "dark", "one-light": "light",
	"solarized": "dark", "solarized-light": "light",
	"kanagawa": "dark", "kanagawa-lotus": "light",
	"rose-pine": "dark", "rose-pine-dawn": "light",
	"vesper": "dark",
};

/** The rc file `/theme` persists to (same resolution as `loadConfig`). */
function defaultRcFile(): string {
	return path.join(os.homedir(), ".aidbrc");
}

/**
 * Persist a theme preset selection into the user config file (~/.aidbrc by
 * default). If the rc file already carries a `theme` OBJECT (per-role
 * overrides with or without a `preset`), only the `preset` key is swapped so
 * the user's overrides survive; a bare string `theme` is replaced. The rest
 * of the file is preserved verbatim. Best-effort: returns `{ wrote: false,
 * error }` on any read/parse/write failure so the caller can still apply the
 * theme live.
 */
export function persistThemePreset(name: string, file = defaultRcFile()): { wrote: boolean; error?: string } {
	try {
		let root: Record<string, unknown> = {};
		if (fs.existsSync(file)) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			if (isPlainObject(parsed)) root = parsed;
		}
		const existing = root.theme;
		if (isPlainObject(existing)) {
			existing.preset = name;
		} else {
			root.theme = name;
		}
		fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
		return { wrote: true };
	} catch (error) {
		return { wrote: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** The preset name currently selected in the rc file (`theme` as a string or
 * `theme.preset`), canonicalized, or null when none is set. */
export function currentThemePreset(file = defaultRcFile()): string | null {
	try {
		if (!fs.existsSync(file)) return null;
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isPlainObject(parsed)) return null;
		const theme = parsed.theme;
		const raw =
			typeof theme === "string"
				? theme
				: isPlainObject(theme) && typeof theme.preset === "string"
					? theme.preset
					: null;
		return raw ? canonicalThemeName(raw) : null;
	} catch {
		return null;
	}
}

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
	const uiRaw = section("ui");

	/* theme — a bare string names a built-in preset; an object may carry a
	 * `"preset"` plus per-role overrides layered on top of the preset. */
	const namedPreset =
		typeof themeRaw === "string"
			? themeRaw
			: isPlainObject(themeRaw) && typeof themeRaw.preset === "string"
				? themeRaw.preset
				: undefined;
	let themeBase: ThemeConfig = DEFAULT_CONFIG.theme;
	let themeOverrides: unknown = themeRaw;
	if (namedPreset !== undefined) {
		const preset = canonicalThemeName(namedPreset);
		if (preset) {
			themeBase = THEME_PRESETS[preset];
		} else {
			issues.push({
				path: typeof themeRaw === "string" ? "theme" : "theme.preset",
				message: `unknown theme preset ${JSON.stringify(namedPreset)}; use one of: ${THEME_PRESET_NAMES.join(", ")}`,
			});
		}
		if (isPlainObject(themeRaw)) {
			themeOverrides = { ...themeRaw };
			delete (themeOverrides as Record<string, unknown>).preset;
		} else {
			themeOverrides = undefined;
		}
	}
	const pickColor = (key: keyof ThemeConfig, fallback: number): number => {
		const v = isPlainObject(themeOverrides) ? themeOverrides[key] : undefined;
		if (v === undefined) return fallback;
		if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 256) return v;
		issues.push({ path: `theme.${key}`, message: `expected an ANSI colour code (0-256), got ${JSON.stringify(v)}` });
		return fallback;
	};
	const themeKeys = [
		"accent", "muted", "success", "warning", "error", "border", "inputBorder",
		"borderActive", "borderInactive", "paneBg", "keyword", "string", "number", "comment", "type", "preproc", "label", "mnemonic", "register", "function", "placeholder",
	] as const;
	const theme = {} as ThemeConfig;
	for (const key of themeKeys) {
		theme[key] = pickColor(key, themeBase[key]);
	}
	/* `directive` was the role's name before the nvim-aligned rename to
	 * `preproc`; accept it as an alias so old rc files keep working (only
	 * honoured when the user didn't already override `preproc` itself). */
	if (theme.preproc === themeBase.preproc) {
		const legacy = isPlainObject(themeOverrides) ? themeOverrides.directive : undefined;
		if (typeof legacy === "number" && Number.isInteger(legacy) && legacy >= 0 && legacy <= 256) {
			theme.preproc = legacy;
		}
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

	/* ui */
	const promptZoneRaw = isPlainObject(uiRaw) ? uiRaw.promptZone : undefined;
	const ui: UiConfig = {
		promptZone:
			promptZoneRaw === "off" || promptZoneRaw === "line" || promptZoneRaw === "line+rail"
				? promptZoneRaw
				: (() => {
						if (promptZoneRaw !== undefined) {
							issues.push({ path: "ui.promptZone", message: `expected "off" | "line" | "line+rail", got ${JSON.stringify(promptZoneRaw)}` });
						}
						return DEFAULT_CONFIG.ui.promptZone;
					})(),
	};

	return { theme, gdb, defaults, sessions, keybindings: { actions, editor }, windows: {}, agent: {}, ui };
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