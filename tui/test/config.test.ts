import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CONFIG,
	canonicalThemeName,
	currentThemePreset,
	loadConfig,
	persistThemePreset,
	readConfigFile,
	validateConfig,
} from "../src/config.ts";
import type { ThemeConfig } from "../src/config.ts";
import { THEME_PRESETS } from "../src/config.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "aidb-config-"));
}

function write(dir: string, name: string, json: unknown): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify(json, null, 2));
	return file;
}

describe("config", () => {
	it("loads defaults when no config files exist", () => {
		const dir = tmpDir();
		const { config, sources } = loadConfig({ home: path.join(dir, "none"), project: path.join(dir, "none.json") });
		assert.deepEqual(config.theme, DEFAULT_CONFIG.theme);
		assert.equal(config.gdb.path, "gdb");
		assert.equal(sources.project, undefined);
		assert.equal(sources.rc, undefined);
		assert.deepEqual(sources.issues, []);
	});

	it("project overrides home over defaults (deep merge)", () => {
		const dir = tmpDir();
		const home = write(dir, ".aidbrc", {
			theme: { accent: 1, muted: 2 },
			gdb: { path: "gdb-14" },
		});
		const project = write(dir, ".aidb.json", {
			theme: { accent: 3 }, // wins over rc's accent, leaves muted from rc
			keybindings: { actions: { stepOver: ["f8"] } },
		});
		const { config, sources } = loadConfig({ home, project });
		assert.equal(config.theme.accent, 3);
		assert.equal(config.theme.muted, 2); // rc level survives
		assert.equal(config.gdb.path, "gdb-14"); // only rc set it
		assert.deepEqual(config.keybindings.actions.stepOver, ["f8"]);
		// provenance: project wins where it defined a section
		assert.equal(sources.sectionOrigin.theme, "./.aidb.json");
		assert.equal(sources.sectionOrigin.gdb, "~/.aidbrc");
		assert.equal(sources.sectionOrigin.sessions, "defaults");
	});

	it("malformed project JSON is ignored with an issue, defaults apply", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, ".aidb.json"), "{ not json !!" );
		const home = write(dir, ".aidbrc", { gdb: { path: "rc-gdb" } });
		const { config, sources } = loadConfig({ home, project: path.join(dir, ".aidb.json") });
		assert.equal(config.gdb.path, "rc-gdb");
		assert.ok(sources.issues.some((i) => i.path === "./.aidb.json" && /not valid JSON/.test(i.message)));
	});

	it("invalid field values coerce back to defaults with actionable issues", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({
			theme: { accent: "red", border: -5 },
			keybindings: { actions: { continue: "f5" } }, // should be an array
			gdb: { path: 42 },
		}, issues);
		assert.equal(config.theme.accent, DEFAULT_CONFIG.theme.accent);
		assert.equal(config.theme.border, DEFAULT_CONFIG.theme.border);
		assert.deepEqual(config.keybindings.actions.continue, ["f5"]); // default
		assert.equal(config.gdb.path, "gdb"); // default
		const paths = issues.map((i) => i.path).sort();
		assert.ok(paths.includes("theme.accent"));
		assert.ok(paths.includes("keybindings.actions.continue"));
		assert.ok(paths.includes("gdb.path"));
	});

	it("partial action and editor overrides merge cleanly", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({
			keybindings: {
				actions: { continue: ["ctrl+b"] },
				editor: { "tui.editor.yank": ["ctrl+y"] },
			},
		}, issues);
		assert.deepEqual(config.keybindings.actions.continue, ["ctrl+b"]);
		assert.deepEqual(config.keybindings.editor["tui.editor.yank"], ["ctrl+y"]);
		// editor override only records issues for non-array values; none here
		assert.deepEqual(issues, []);
	});

	it("invalid ui.promptZone coerces to the default with an actionable issue", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({ ui: { promptZone: "rainbow" } }, issues);
		assert.equal(config.ui.promptZone, DEFAULT_CONFIG.ui.promptZone);
		assert.ok(issues.some((i) => i.path === "ui.promptZone" && /off|line/.test(i.message)));
		assert.equal(validateConfig({ ui: { promptZone: "line" } }).ui.promptZone, "line");
		assert.equal(validateConfig({}).ui.promptZone, DEFAULT_CONFIG.ui.promptZone);
	});

	it("readConfigFile classifies a missing file separately", () => {
		const dir = tmpDir();
		const missing = readConfigFile(path.join(dir, "nope.json"));
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.error, "missing");
		const good = write(dir, "ok.json", { theme: { accent: 5 } });
		const parsed = readConfigFile(good);
		assert.equal(parsed.ok, true);
		if (parsed.ok) assert.deepEqual(parsed.value, { theme: { accent: 5 } });
	});

	it("default keybindings include all actions", () => {
		for (const action of ["continue", "stepOver", "stepInto", "stepOut", "scrollUp", "scrollDown"]) {
			assert.ok(Array.isArray(DEFAULT_CONFIG.keybindings.actions[action as keyof typeof DEFAULT_CONFIG.keybindings.actions]));
			assert.ok(DEFAULT_CONFIG.keybindings.actions[action as keyof typeof DEFAULT_CONFIG.keybindings.actions].length > 0);
		}
	});
});

describe("theme presets", () => {
	it("a bare string selects a herdr-style preset", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({ theme: "dracula" }, issues);
		assert.deepEqual(issues, []);
		assert.equal(config.theme.accent, THEME_PRESETS.dracula.accent);
		assert.equal(config.theme.paneBg, THEME_PRESETS.dracula.paneBg);
		assert.equal(config.theme.function, THEME_PRESETS.dracula.function);
	});

	it("every preset carries the nvim-aligned token roles (type, preproc, label)", () => {
		for (const [name, preset] of Object.entries(THEME_PRESETS)) {
			assert.ok(
				Number.isInteger(preset.type) && preset.type >= 0 && preset.type <= 256,
				`${name}.type`,
			);
			assert.ok(
				Number.isInteger(preset.preproc) && preset.preproc >= 0 && preset.preproc <= 256,
				`${name}.preproc`,
			);
			assert.ok(
				Number.isInteger(preset.label) && preset.label >= 0 && preset.label <= 256,
				`${name}.label`,
			);
		}
	});

	it("`directive` is accepted as a deprecated alias for `preproc`", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({ theme: { directive: 202 } }, issues);
		assert.deepEqual(issues, []);
		assert.equal(config.theme.preproc, 202);
		// The new name wins when both are present.
		const newer = validateConfig({ theme: { directive: 1, preproc: 2 } });
		assert.equal(newer.theme.preproc, 2);
	});

	it("herdr aliases resolve through canonicalThemeName", () => {
		assert.equal(canonicalThemeName("tokyonight"), "tokyo-night");
		assert.equal(canonicalThemeName("onedark"), "one-dark");
		assert.equal(canonicalThemeName("gruvbox-dark"), "gruvbox");
		assert.equal(canonicalThemeName("dawn"), "rose-pine-dawn");
		assert.equal(canonicalThemeName("catppuccin-mocha"), "catppuccin");
		assert.equal(canonicalThemeName("nope"), null);
	});

	it("unknown preset falls back to the default with an issue", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({ theme: "bogus-theme" }, issues);
		assert.deepEqual(config.theme, DEFAULT_CONFIG.theme);
		assert.ok(issues.some((i) => i.path === "theme" && /bogus-theme/.test(i.message)));
	});

	it("object form: preset plus per-role overrides on top", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({ theme: { preset: "nord", accent: 9 } }, issues);
		assert.deepEqual(issues, []);
		assert.equal(config.theme.accent, 9); // override wins
		assert.equal(config.theme.paneBg, THEME_PRESETS.nord.paneBg); // base carries through
	});

	it("object form: invalid preset name is diagnosed under theme.preset", () => {
		const issues: { path: string; message: string }[] = [];
		validateConfig({ theme: { preset: "wat" } }, issues);
		assert.ok(issues.some((i) => i.path === "theme.preset" && /preset/.test(i.message)));
	});

	it("preset bases still validate override role codes", () => {
		const issues: { path: string; message: string }[] = [];
		const config = validateConfig({ theme: { preset: "dracula", accent: "red" } }, issues);
		assert.equal(config.theme.accent, THEME_PRESETS.dracula.accent);
		assert.ok(issues.some((i) => i.path === "theme.accent"));
	});

	it("object overrides without a preset keep the default base", () => {
		const config = validateConfig({ theme: { accent: 5 } });
		assert.equal(config.theme.accent, 5);
		assert.equal(config.theme.border, DEFAULT_CONFIG.theme.border);
	});

	it("every preset is a complete, in-range 256-colour role set", () => {
		for (const [name, preset] of Object.entries(THEME_PRESETS)) {
			for (const key of Object.keys(DEFAULT_CONFIG.theme) as (keyof ThemeConfig)[]) {
				const v = preset[key];
				assert.ok(
					typeof v === "number" && v >= 0 && v <= 256,
					`${name}.${key}=${v}`,
				);
			}
		}
	});
});


	describe("persistThemePreset / currentThemePreset", () => {
		it("creates the rc file when absent", () => {
			const dir = tmpDir();
			const rc = path.join(dir, ".aidbrc");
			const res = persistThemePreset("dracula", rc);
			assert.deepEqual(res, { wrote: true });
			assert.deepEqual(JSON.parse(fs.readFileSync(rc, "utf8")), { theme: "dracula" });
			assert.equal(currentThemePreset(rc), "dracula");
		});

		it("swaps only the preset key, keeping role overrides and other sections", () => {
			const dir = tmpDir();
			const rc = write(dir, ".aidbrc", {
				theme: { preset: "nord", accent: 9 },
				gdb: { path: "gdb-x" },
			});
			persistThemePreset("dracula", rc);
			const onDisk = JSON.parse(fs.readFileSync(rc, "utf8"));
			assert.deepEqual(onDisk.theme, { preset: "dracula", accent: 9 });
			assert.equal(onDisk.gdb.path, "gdb-x");
			assert.equal(currentThemePreset(rc), "dracula");
		});

		it("replaces a bare string theme", () => {
			const dir = tmpDir();
			const rc = write(dir, ".aidbrc", { theme: "nord" });
			persistThemePreset("one-dark", rc);
			assert.deepEqual(JSON.parse(fs.readFileSync(rc, "utf8")).theme, "one-dark");
			assert.equal(currentThemePreset(rc), "one-dark");
		});

		it("turns a preset-less overrides object into a preset + kept overrides", () => {
			const dir = tmpDir();
			const rc = write(dir, ".aidbrc", { theme: { accent: 5 } });
			persistThemePreset("nord", rc);
			assert.deepEqual(JSON.parse(fs.readFileSync(rc, "utf8")).theme, { preset: "nord", accent: 5 });
		});

		it("nonexistent rc has no current preset", () => {
			assert.equal(currentThemePreset(path.join(tmpDir(), "nope")), null);
		});

		it("unwritable rc reports an error instead of throwing", () => {
			const res = persistThemePreset("nord", "/nonexistent/dir/sub/rc");
			assert.equal(res.wrote, false);
			assert.ok(res.error);
		});
	});

	describe("/theme command", () => {
		it("bare /theme is classified as a bare picker command", async () => {
			const { isBarePickerCommand } = await import("../src/repl.ts");
			assert.equal(isBarePickerCommand("/theme"), true);
			assert.equal(isBarePickerCommand("/theme dracula"), false);
			assert.equal(isBarePickerCommand("/theme  "), true);
		});

		it("/theme <name> applies + persists, preserving rc overrides", async () => {
			const dir = tmpDir();
			const rc = write(dir, ".aidbrc", { theme: { preset: "nord", accent: 9 }, gdb: { path: "gdb-x" } });
			const messages: string[] = [];
			const { handleReplInput } = await import("../src/repl.ts");
			await handleReplInput("/theme dracula", makeThemeCtx(rc, messages));
			assert.match(messages.join("\n"), /Theme 'dracula' applied/);
			const onDisk = JSON.parse(fs.readFileSync(rc, "utf8"));
			assert.deepEqual(onDisk.theme, { preset: "dracula", accent: 9 });
			assert.equal(onDisk.gdb.path, "gdb-x"); // untouched
		});

		it("/theme <alias> canonicalizes before persisting", async () => {
			const dir = tmpDir();
			const rc = path.join(dir, ".aidbrc");
			const messages: string[] = [];
			const { handleReplInput } = await import("../src/repl.ts");
			await handleReplInput("/theme tokyonight", makeThemeCtx(rc, messages));
			assert.deepEqual(JSON.parse(fs.readFileSync(rc, "utf8")).theme, "tokyo-night");
		});

		it("/theme <unknown> errors and lists presets", async () => {
			const dir = tmpDir();
			const rc = path.join(dir, ".aidbrc");
			const messages: string[] = [];
			const { handleReplInput } = await import("../src/repl.ts");
			await handleReplInput("/theme bogus", makeThemeCtx(rc, messages));
			assert.match(messages.join("\n"), /Unknown theme 'bogus'/);
			assert.match(messages.join("\n"), /dracula/);
			assert.ok(!fs.existsSync(rc)); // nothing written
		});

		it("bare /theme opens the picker without error (no host in tests)", async () => {
			const messages: string[] = [];
			const { handleReplInput } = await import("../src/repl.ts");
			await handleReplInput("/theme", makeThemeCtx(path.join(tmpDir(), ".aidbrc"), messages));
			assert.deepEqual(messages, []);
		});
	});


describe("/config command", () => {
	it("bare /config prints effective values and provenance", async () => {
		const messages: string[] = [];
		const { handleReplInput } = await import("../src/repl.ts");
		await handleReplInput("/config", makeCtx(messages));
		const text = messages.join("\n");
		assert.match(text, /accent=36/);
		assert.match(text, /gdb/);
		assert.match(text, /sessions/);
	});

	it("/config reload reports success", async () => {
		const messages: string[] = [];
		const { handleReplInput } = await import("../src/repl.ts");
		await handleReplInput("/config reload", makeCtx(messages));
		assert.match(messages.join("\n"), /reloaded/);
	});
});

function makeCtx(messages: string[]) {
	return {
		getApi: () => ({}) as never,
		reset: async () => ({}) as never,
		requestExit: () => {},
		requestRender: () => {},
		io: {
			line: (t: string) => messages.push(t),
			info: (t: string) => messages.push(`i:${t}`),
			success: (t: string) => messages.push(`s:${t}`),
			warning: (t: string) => messages.push(`w:${t}`),
			error: (t: string) => messages.push(`e:${t}`),
		},
		windows: {} as never,
		config: DEFAULT_CONFIG,
		configSources: {
			issues: [{ path: "theme.accent", message: "bad color" }],
			sectionOrigin: { theme: "defaults", gdb: "defaults", sessions: "defaults", keybindings: "defaults", defaults: "defaults", windows: "defaults", agent: "defaults" },
		},
		reloadConfig: () => ({
			config: DEFAULT_CONFIG,
			sources: { issues: [], sectionOrigin: {} as never },
		}),
	} as never;
}

/** A `ReplContext` whose rc file is a temp path and whose reloadConfig really
 * re-reads it — so `/theme` tests exercise the persist + reload round-trip. */
function makeThemeCtx(rc: string, messages: string[]) {
	return {
		getApi: () => ({}) as never,
		reset: async () => ({}) as never,
		requestExit: () => {},
		requestRender: () => {},
		io: {
			line: (t: string) => messages.push(t),
			info: (t: string) => messages.push(`i:${t}`),
			success: (t: string) => messages.push(`s:${t}`),
			warning: (t: string) => messages.push(`w:${t}`),
			error: (t: string) => messages.push(`e:${t}`),
		},
		windows: {} as never,
		config: DEFAULT_CONFIG,
		configSources: {
			rc,
			issues: [],
			sectionOrigin: { theme: "defaults", gdb: "defaults", sessions: "defaults", keybindings: "defaults", defaults: "defaults", windows: "defaults", agent: "defaults", ui: "defaults" },
		},
		reloadConfig: () => loadConfig({ home: rc, project: path.join(path.dirname(rc), "none.json") }),
	} as never;
}