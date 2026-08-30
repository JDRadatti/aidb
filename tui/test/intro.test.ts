import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { INTRO_WIDTH, renderIntro, type IntroState } from "../src/intro.ts";

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function freshState(over: Partial<IntroState> = {}): IntroState {
	return {
		debuggerLabel: "aidb — GDB debugger via DAP",
		autoSave: true,
		sessions: [],
		targets: [],
		layouts: [],
		...over,
	};
}

describe("renderIntro", () => {
	it("renders the collection tags with none-yet hints on a fresh start", () => {
		const lines = renderIntro(freshState()).map(plain);
		assert.ok(lines[0]!.includes("aidb — GDB debugger via DAP"));
		assert.ok(lines.some((line) => /^\[sessions\]/.test(line)));
		assert.ok(lines.some((line) => /^\[targets\]/.test(line)));
		assert.ok(lines.some((line) => /^\[layouts\]/.test(line)));
		// Every collection tag is followed by at least one indented line.
		const nextAfter = (tagText: string): string => {
			const i = lines.findIndex((line) => line === tagText);
			assert.ok(i !== -1, `missing [${tagText}]`);
			return lines[i + 1]!;
		};
		for (const tagText of ["[sessions]", "[targets]", "[layouts]"]) {
			assert.ok(nextAfter(tagText).startsWith("  "), `${tagText} must have an indented row`);
		}
		// Under the divider: just the /help pointer (with a description).
		const helpLine = lines.find((line) => line.includes("/help"));
		assert.ok(helpLine, "expected a /help pointer");
		assert.ok(helpLine!.includes("full command reference"), helpLine);
		// The verb banner is gone; no line carries the old comma-list of verbs.
		assert.ok(!lines.some((line) => line.includes("· continue · next · step")));
	});

	it("lists saved items one indented line each, marking the current with ✳", () => {
		const lines = renderIntro(
			freshState({
				sessions: [
					{ name: "bug1", current: true, target: "game", layout: "code-watch", breakpoints: 3 },
					{ name: "scratch", current: false, target: null, layout: null, breakpoints: 0 },
				],
				targets: [
					{ name: "game", current: true, kind: "launch", program: "./game", args: ["--seed", "42"] },
					{ name: "hello", current: false, kind: "launch", program: "./hello", args: [] },
				],
				layouts: [
					{ name: "code-watch", current: true, panes: 3, watchEntries: 2, livePaneCount: 1 },
					{ name: "single", current: false, panes: 1, watchEntries: 0, livePaneCount: 0 },
				],
			}),
		).map(plain);
		// Sessions: name · target · layout · bp count.
		const sessionRows = lines
			.filter((line) => /^  /.test(line))
			.filter((line) => line.includes("bp "));
		assert.ok(sessionRows.some((line) => line.includes("bug1 ✳ · game · code-watch · bp 3")));
		assert.ok(sessionRows.some((line) => line.includes("scratch · no target · no layout · bp 0")));
		// Targets: attach pid form renders too.
		const withAttach = renderIntro(
			freshState({ targets: [{ name: "remote", current: false, kind: "attach", args: [], pid: 1234 }] }),
		).map(plain);
		assert.ok(withAttach.some((line) => line.includes("remote · attach pid 1234")));
		// Layouts: pane/watch counts.
		const layoutRows = lines.filter((line) => /^  /.test(line)).filter((line) => line.includes("pane"));
		assert.ok(layoutRows.some((line) => line.includes("code-watch ✳ · 3 panes · 2 watch · 1 live")));
		assert.ok(layoutRows.some((line) => line.includes("single · 1 pane · 0 watch")));
	});

	it("says sessions are off instead of listing when auto-save is disabled", () => {
		const lines = renderIntro(freshState({ autoSave: false })).map(plain);
		const i = lines.findIndex((line) => line === "[sessions]");
		assert.ok(i !== -1);
		assert.ok(lines[i + 1]!.includes("off"));
	});

	it("caps every line to the banner width (ANSI-aware)", () => {
		const over = {
			sessions: [
				{ name: "a-very-long-session-name-that-should-be-truncated-for-sure-" + "x".repeat(60), current: true, target: "another-long-target-name-here", layout: "yet-another-long-layout", breakpoints: 999 },
			],
			targets: [
				{ name: "game", current: true, kind: "launch" as const, program: "./game", args: new Array(20).fill("--flag").flat() },
			],
			layouts: [
				{ name: "grid", current: true, panes: 9, watchEntries: 999, livePaneCount: 99 },
			],
		};
		const lines = renderIntro(freshState(over));
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= INTRO_WIDTH, `line too wide (${visibleWidth(line)}): ${plain(line)}`);
		}
	});
});