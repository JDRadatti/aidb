import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { ReplTranscript } from "../src/repl-log.ts";

const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
const HOME = "\x1b[H";
const END = "\x1b[F";

function make(viewport = 3): ReplTranscript {
	const t = new ReplTranscript();
	t.setViewportHeight(viewport);
	return t;
}

/** Add plain lines using Text with zero padding so rows are 1:1. */
function add(t: ReplTranscript, ...lines: string[]): void {
	for (const line of lines) t.addChild(new Text(line, 0, 0));
}

function rows(t: ReplTranscript, width = 80): string[] {
	return t.render(width).map((l) => l.trim());
}

describe("ReplTranscript", () => {
	it("follows the end when at the live tail", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		assert.deepEqual(t.render(80).map((l) => l.trim()), ["c", "d", "e"]);
	});

	it("scrolls back (ctrl+up) and pins away from the tail", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		t.handleInput(CTRL_UP);
		const trimmed = t.render(80).map((l) => l.trim());
		// the footer indicator consumes one row, so fewer data rows show
		assert.deepEqual(trimmed.slice(0, 2), ["b", "c"]);
		assert.equal(t.isScrolledBack, true);
	});

	it("down (ctrl+down) returns to the end and resumes following", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		t.handleInput(CTRL_UP);
		t.handleInput(CTRL_DOWN);
		assert.deepEqual(t.render(80).map((l) => l.trim()).slice(0, 3), ["c", "d", "e"]);
		assert.equal(t.isScrolledBack, false);
	});

	it("home goes to the top, end to the tail", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		t.handleInput(HOME);
		assert.deepEqual(t.render(80).map((l) => l.trim()).slice(0, 2), ["a", "b"]);
		t.handleInput(END);
		assert.deepEqual(t.render(80).map((l) => l.trim()).slice(0, 3), ["c", "d", "e"]);
	});

	it("new output while scrolled back stays pinned", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		t.handleInput(CTRL_UP);
		add(t, "f");
		const out = t.render(80).map((l) => l.trim()).slice(0, 3);
		assert.ok(!out.includes("f"), "tail 'f' should not appear while pinned");
	});

	it("while following, new output advances the tail", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		add(t, "f");
		const out = t.render(80).map((l) => l.trim()).slice(0, 3);
		assert.deepEqual(out, ["d", "e", "f"]);
	});

	it("addLine strips a trailing newline", () => {
		const t = make(3);
		t.addLine("hello\n");
		assert.ok(t.render(80).some((l) => l.trim() === "hello"));
	});

	it("clear resets scroll state", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		t.handleInput(HOME);
		t.clear();
		assert.equal(t.isScrolledBack, false);
		assert.deepEqual(t.render(80), ["", "", ""]);
	});

	it("pageUp/pageDown scroll (full page)", () => {
		const t = make(3);
		add(t, "a", "b", "c", "d", "e");
		t.handleInput("\x1b[5~"); // pageUp
		assert.equal(t.isScrolledBack, true);
		t.handleInput("\x1b[6~"); // pageDown
		assert.deepEqual(t.render(80).map((l) => l.trim()).slice(0, 3), ["c", "d", "e"]);
		assert.equal(t.isScrolledBack, false);
	});
});