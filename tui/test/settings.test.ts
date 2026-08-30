import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSettings } from "../src/views/settings.ts";
import type { Config, ConfigSources } from "../src/config.ts";

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function config(over: Partial<Config> = {}): Config {
	return {
		theme: {
			accent: 36, muted: 90, success: 32, warning: 33, error: 31,
			border: 90, borderActive: 255, borderInactive: 234, paneBg: 235, inputBg: 237,
			keyword: 36, string: 32, number: 33, comment: 90, mnemonic: 93, register: 94, directive: 96,
		},
		gdb: { path: "gdb", args: [], env: {} },
		keybindings: {
			actions: {
				continue: ["f5"], stepOver: ["f10"], stepInto: ["f11"], stepOut: ["shift+f11"],
				scrollUp: ["ctrl+up", "pageUp"], scrollDown: ["ctrl+down", "pageDown"], open: ["alt+o"],
			},
			editor: {},
		},
		defaults: { breakStyle: "line", stepBehavior: "continue" },
		sessions: { historyPath: "~/.aidb_history", sessionDir: "~/.config/aidb/sessions", autoSave: true },
		windows: {},
		agent: {},
		...over,
	};
}

function sources(over: Partial<ConfigSources> = {}): ConfigSources {
	return {
		project: undefined,
		rc: undefined,
		issues: [],
		sectionOrigin: {
			theme: "defaults", gdb: "defaults", keybindings: "defaults", defaults: "defaults",
			sessions: "defaults", windows: "defaults", agent: "defaults",
		},
		...over,
	};
}

describe("renderSettings", () => {
	it("renders every section with its provenance", () => {
		const lines = renderSettings(config(), sources()).map(plain);
		assert.ok(lines[0]!.includes("settings"));
		assert.ok(lines.some((line) => line.includes("roles:") && line.includes("accent")));
		assert.ok(lines.some((line) => line.includes("path gdb") && line.includes("args")));
		assert.ok(lines.some((line) => line.includes("continue") && line.includes("F5")));
		assert.ok(lines.some((line) => line.includes("open finder") && line.includes("Alt+O")));
		assert.ok(lines.some((line) => line.includes("~/.config/aidb/sessions")));
		assert.ok(lines.some((line) => line.includes("autoSave") && line.includes("on")));
		assert.ok(lines.some((line) => line.includes("breakStyle")));
		assert.ok(lines.some((line) => /^windows/.test(line)));
		assert.ok(lines.some((line) => line.includes("reserved")));
		assert.ok(lines.some((line) => /^agent/.test(line)) && lines.some((line) => line.includes("(reserved — parsed but not yet wired: tool permissions")));
	});

	it("shows keybindings as chord labels (remap-aware)", () => {
		const lines = renderSettings(
			config({ keybindings: { actions: { ...config().keybindings.actions, stepOver: ["ctrl+o"] }, editor: {} } }),
			sources({ sectionOrigin: { ...sources().sectionOrigin, keybindings: "~/.aidbrc" } }),
		).map(plain);
		assert.ok(lines.some((line) => line.includes("step over") && line.includes("Ctrl+O")));
		assert.ok(lines.some((line) => line.includes("(~/.aidbrc)")));
	});

	it("shows multiple chords joined with / and multi-key scroll", () => {
		const lines = renderSettings(config(), sources()).map(plain);
		assert.ok(lines.some((line) => line.includes("scroll up") && line.includes("Ctrl+Up/PageUp")));
	});

	it("lists config issues when present", () => {
		const lines = renderSettings(
			config(),
			sources({ issues: [{ path: "theme.accent", message: "expected an ANSI colour code" }] }),
		).map(plain);
		assert.ok(lines.some((line) => line.includes("config issues (1)")));
		assert.ok(lines.some((line) => line.includes("theme.accent: expected an ANSI colour code")));
	});
});