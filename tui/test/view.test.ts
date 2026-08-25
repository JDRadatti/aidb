import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { View } from "../src/view.ts";

class TestView extends View {
	total = 50;
	wide = false;

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
		return Array.from({ length: this.total }, (_, i) => this.wide && i === 0 ? `0123456789abcdefghijklmnopqrstuvwxyz` : `line-${i}`);
	}

	setWide(wide: boolean): void {
		this.wide = wide;
		this.touch();
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

	it("ctrl+up/ctrl+down scroll by half a page", () => {
		const view = new TestView();
		view.render(40);
		view.handleInput("\x1b[1;5B"); // ctrl+down
		assert.equal(view.getScroll(), 5);
		view.handleInput("\x1b[1;5A"); // ctrl+up
		assert.equal(view.getScroll(), 0);
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

	it("ctrl+d / ctrl+u remain view-local half-page bindings", () => {
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

	it("does not use arrow keys for scrolling", () => {
		const view = new TestView();
		view.setWide(true);
		assert.equal(view.render(10)[0], "0123456789");
		view.handleInput("\x1b[C");
		assert.equal(view.getHorizontalScroll(), 0);
		assert.equal(view.render(10)[0], "0123456789");
	});

	it("matchesKey sees the dedicated scroll keys", () => {
		assert.ok(matchesKey("\x1b[1;5A", "ctrl+up"));
		assert.ok(matchesKey("\x1b[1;5B", "ctrl+down"));
		assert.ok(matchesKey(key("G"), "shift+g"));
		assert.ok(!matchesKey("\x1b[A", "ctrl+up"));
	});
});
