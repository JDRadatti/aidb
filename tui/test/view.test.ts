import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { View } from "../src/view.ts";

class TestView extends View {
	total = 50;

	constructor(options = {}) {
		super("test", { viewportHeight: 10, ...options });
	}

	setTotal(n: number): void {
		this.total = n;
		this.touch();
	}

	getCursor(): number {
		return this.cursorLine;
	}

	getScroll(): number {
		return this.scrollRow;
	}

	protected content(_width: number): string[] {
		return Array.from({ length: this.total }, (_, i) => `line-${i}`);
	}
}

const key = (s: string) => s;

describe("View", () => {
	it("renders exactly the viewport height, padded", () => {
		const view = new TestView();
		const lines = view.render(40);
		assert.equal(lines.length, 10);
		assert.equal(lines[0], "line-0");
	});

	it("j/k move the cursor and keep it visible", () => {
		const view = new TestView();
		view.render(40);
		for (let i = 0; i < 12; i++) view.handleInput(key("j"));
		assert.equal(view.getCursor(), 12);
		// Cursor at row 12 with a 10-row viewport scrolls the window down.
		assert.equal(view.getScroll(), 3);
		const rendered = view.render(40);
		assert.equal(rendered[9], "line-12");
		view.handleInput(key("k"));
		assert.equal(view.getCursor(), 11);
	});

	it("g/G jump to top and bottom", () => {
		const view = new TestView();
		view.render(40);
		view.handleInput(key("G"));
		assert.equal(view.getCursor(), 49);
		assert.ok(view.getScroll() <= 49 - 10 + 1);
		view.handleInput(key("g"));
		assert.equal(view.getCursor(), 0);
		assert.equal(view.getScroll(), 0);
	});

	it("ctrl+d / ctrl+u scroll by half a page", () => {
		const view = new TestView();
		view.render(40);
		view.handleInput(key("\x04")); // ctrl+d
		assert.equal(view.getScroll(), 5);
		view.handleInput(key("\x15")); // ctrl+u
		assert.equal(view.getScroll(), 0);
	});

	it("clamps when content shrinks", () => {
		const view = new TestView();
		view.render(40);
		view.handleInput(key("G"));
		view.setTotal(5);
		assert.ok(view.getCursor() < 5);
		const lines = view.render(40);
		assert.ok(lines.every((l) => l === "" || /^line-\d+$/.test(l)));
	});

	it("viewport height changes re-slice without touching content", () => {
		const view = new TestView();
		view.setViewportHeight(4);
		assert.equal(view.render(40).length, 4);
	});

	it("matchesKey sees the same letters we route", () => {
		assert.ok(matchesKey(key("j"), "j"));
		assert.ok(matchesKey(key("G"), "shift+g"));
		assert.ok(!matchesKey(key("j"), "k"));
	});
});
