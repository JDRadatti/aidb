import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";

function stubPane(marker: string, height = 3): Component {
	return {
		render: (width: number) => Array.from({ length: height }, () => marker.repeat(Math.max(1, width))),
		invalidate: () => {},
	};
}

const strip = (s: string): string => s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");

function makeManager(...ids: string[]): WindowManager {
	const panes = new Map<string, Component>();
	for (const id of ids) panes.set(id, stubPane(id.slice(0, 1).toUpperCase()));
	return new WindowManager(new SplitTree(ids[0]!), { panes, getViewRows: () => 10 });
}

describe("WindowManager", () => {
	it("renders a single pane with a title row plus content", () => {
		const wm = makeManager("repl");
		const lines = wm.render(20);
		assert.equal(lines.length, 7); // title + body padded to the allotted rows
		assert.ok(strip(lines[0]).includes("repl"));
		assert.ok(strip(lines[1]).startsWith("R"));
		assert.ok(strip(lines[6]).trimEnd() === "" || strip(lines[6]).startsWith("R"));
	});

	it("vsplit gives equal columns regardless of pane content", () => {
		const wm = makeManager("repl");
		wm.register("a", stubPane("A"));
		assert.ok(wm.split("v", 0).ok);
		const content = strip(wm.render(21)[1]);
		const boundary = content.search(/[^R]/);
		assert.ok(Math.abs(boundary - 10) <= 1, `expected split near column 10, got ${boundary}`);
	});

	it("a wide transcript does not starve the other pane", () => {
		const wm = makeManager("repl");
		wm.register("a", stubPane("A"));
		wm.register("repl", { id: "repl", render: (w: number) => ["R".repeat(w * 4)], invalidate: () => {} });
		assert.ok(wm.split("v", 0).ok);
		const content = strip(wm.render(21)[1]);
		const boundary = content.search(/[^R]/);
		assert.ok(Math.abs(boundary - 10) <= 1, `expected split near column 10, got ${boundary}`);
	});

	it("split defaults to the active pane; switchTo retargets", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok);
		assert.deepEqual(wm.list().map((p) => p.id), ["repl", "pane2"]);
		assert.ok(wm.switchTo(0));
		assert.ok(wm.split("h").ok);
		assert.ok(wm.tree.root !== "repl");
		assert.equal(wm.list().filter((p) => p.id === "pane3").length, 1);
	});

	it("close takes an index, unregisters, and refuses the repl", () => {
		const wm = makeManager("repl");
		wm.register("a", stubPane("A"));
		assert.match(wm.close(0).error!, /repl/);
		assert.ok(wm.split("v").ok);
		assert.ok(wm.close(1).ok);
		assert.deepEqual(wm.list().map((p) => p.id), ["repl"]);
	});

	it("indices shift after closing an earlier pane", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok); // repl | pane2
		assert.ok(wm.split("v", 0).ok); // repl | pane3 | pane2
		assert.deepEqual(wm.list().map((p) => p.id), ["repl", "pane3", "pane2"]);
		assert.match(wm.close(0).error!, /repl/);
		assert.ok(wm.close(1).ok); // pane3 goes; pane2 shifts from index 2 to 1
		assert.deepEqual(wm.list().map((p) => p.id), ["repl", "pane2"]);
		assert.ok(wm.switchTo(1));
		assert.equal(wm.active, "pane2");
	});

	it("cycle walks panes in index order", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok);
		assert.ok(wm.switchTo(0)); // split activates the new pane; start from repl
		assert.equal(wm.cycle(), "pane2");
		assert.equal(wm.cycle(), "repl");
	});

	it("splits can name panes; digit-only names are reserved", () => {
		const wm = makeManager("repl");
		assert.match(wm.split("v", 0, "3").error!, /reserved/);
		assert.ok(wm.split("v", 0, "mem").ok);
		assert.deepEqual(wm.list().map((p) => p.id), ["repl", "mem"]);
	});

	it("switchTo and close accept a name as well as an index", () => {
		const wm = makeManager("repl");
		wm.split("v", 0, "mem");
		assert.ok(wm.switchTo("mem"));
		assert.equal(wm.active, "mem");
		assert.equal(wm.resolve("nope"), undefined);
		assert.match(wm.close("nope").error!, /named 'nope'/);
		assert.ok(wm.close("mem").ok);
		assert.deepEqual(wm.list().map((p) => p.id), ["repl"]);
		assert.equal(wm.active, "repl"); // closing the active pane falls back
	});

	it("mount swaps an existing pane's content in place", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok); // pane2 is a blank slab
		assert.ok(wm.mount("pane2", stubPane("W")));
		assert.match(wm.mount("ghost", stubPane("W")).error!, /ghost/);
		const lines = wm.render(40).map(strip);
		assert.ok(lines.some((l) => l.includes("WW")), "expected mounted content");
		assert.ok(!lines.some((l) => l.includes("█")), "expected the slab to be gone");
	});

	it("blank panes render as index slabs with big digits", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok);
		const lines = wm.render(40).map(strip);
		assert.ok(lines.some((l) => l.includes("█")), "expected block digits in the blank pane");
		assert.ok(lines[0].includes("pane2"));
	});

	it("hsplit stacks rows with title rows between", () => {
		const wm = makeManager("repl");
		wm.register("b", stubPane("B"));
		assert.ok(wm.split("h", 0, "b").ok);
		const lines = wm.render(30).map(strip);
		assert.equal(lines.length, 6); // 2 titles + 2x2 clipped body rows
		assert.ok(lines[1].startsWith("R"));
		assert.ok(lines[5].startsWith("B"));
	});

	it("an oversized transcript is clipped to the pane height, keeping the tail", () => {
		const wm = makeManager("repl");
		const transcriptLines = (n: number): Component => ({
			id: "repl",
			render: () => Array.from({ length: n }, (_, i) => `line${i}`),
			invalidate: () => {},
		});
		wm.register("repl", transcriptLines(50));
		let lines = wm.render(40).map(strip);
		assert.equal(lines.length, 1 + wm.bodyRows); // title + fixed body, regardless of content
		assert.ok(lines.some((l) => l.includes("line49")), "latest line must stay visible");
		assert.ok(!lines.some((l) => l.includes("line0")), "old lines scroll away");
		// Simulating `help`: more output must not grow the document.
		wm.register("repl", transcriptLines(80));
		lines = wm.render(40).map(strip);
		assert.equal(lines.length, 1 + wm.bodyRows);
		assert.ok(lines.some((l) => l.includes("line79")));
	});

	it("unregistered panes render as slabs, not errors", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok);
		const rendered = wm.render(40);
		assert.ok(rendered.every((l) => visibleWidth(l) <= 41));
	});
});
