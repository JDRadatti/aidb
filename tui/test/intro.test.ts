import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { INTRO_WIDTH, renderIntro, type IntroState } from "../src/intro.ts";

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function freshState(over: Partial<IntroState> = {}): IntroState {
	return {
		debuggerLabel: "aidb — GDB debugger via DAP",
		gdbState: "idle",
		session: { name: null, breakpoints: 0, pending: 0, autoSave: true },
		target: null,
		layout: { name: null, paneIds: ["repl"] },
		viz: ["regs", "mem", "plot", "tree", "source", "asm", "iasm"],
		keys: "F5 continue · F10 next · F11 step",
		config: { found: ["./.aidb.json", "~/.aidbrc"], issues: 0 },
		history: null,
		...over,
	};
}

describe("renderIntro", () => {
	it("renders the bracketed capability tags on a fresh start", () => {
		const lines = renderIntro(freshState()).map(plain);
		assert.ok(lines[0]!.includes("aidb — GDB debugger via DAP"));
		assert.ok(lines.some((line) => /^\[session\]/.test(line)));
		assert.ok(lines.some((line) => /^\[session\]/.test(line) && line.includes("fresh session")));
		assert.ok(lines.some((line) => /^\[target\]/.test(line) && line.includes("none yet")));
		assert.ok(lines.some((line) => /^\[layout\]/.test(line) && line.includes("single-pane")));
		assert.ok(lines.some((line) => /^\[viz\]/.test(line) && line.includes("asm")));
		assert.ok(lines.some((line) => /^\[keys\]/.test(line) && line.includes("F5 continue")));
		assert.ok(lines.some((line) => /^\[config\]/.test(line) && line.includes(".aidb.json")));
	});

	it("renders the live annotations after a session is resumed", () => {
		const lines = renderIntro(
			freshState({
				gdbState: "stopped",
				session: { name: "bug1", breakpoints: 3, pending: 1, autoSave: true },
				target: { name: "game", program: "./game", args: ["--seed", "42"], kind: "launch" },
				layout: { name: "code-watch", paneIds: ["repl", "watch", "regs"] },
				history: 247,
			}),
		).map(plain);
		assert.ok(lines.some((line) => /^\[session\]/.test(line) && line.includes("bug1") && line.includes("3 bp (1 pending)")));
		assert.ok(lines.some((line) => /^\[target\]/.test(line) && line.includes("./game --seed 42")));
		assert.ok(lines.some((line) => /^\[layout\]/.test(line) && line.includes("3 panes")));
		assert.ok(lines.some((line) => /^\[history\]/.test(line) && line.includes("247")));
		assert.ok(lines.some((line) => /^\[session\]/.test(line) && line.includes("stopped")));
	});

	it("shows pending breaks without cluttering when there are none", () => {
		const lines = renderIntro(
			freshState({ session: { name: "bug1", breakpoints: 2, pending: 0, autoSave: true } }),
		).map(plain);
		const sessionLine = lines.find((line) => /^\[session\]/.test(line))!;
		assert.ok(!sessionLine.includes("pending"));
		assert.ok(sessionLine.includes("2 bp"));
	});

	it("caps every line to the banner width (ANSI-aware)", () => {
		const over = {
			session: { name: "a-very-long-session-name-that-should-be-truncated-for-sure-" + "x".repeat(60), breakpoints: 999, pending: 999, autoSave: true },
			target: { name: "game", program: "./game", args: new Array(20).fill("--flag").flat(), kind: "launch" as const },
		};
		const lines = renderIntro(freshState(over));
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= INTRO_WIDTH, `line too wide (${visibleWidth(line)}): ${plain(line)}`);
		}
	});
});