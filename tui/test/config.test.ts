import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CONFIG,
	loadConfig,
	readConfigFile,
	validateConfig,
} from "../src/config.ts";

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