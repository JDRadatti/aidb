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

// Each pane is padded by a 2-row, 2-column border box (reserved for every pane,
// of a visible border for the active one).
const BORD = 2;

describe("WindowManager", () => {
	it("renders a single pane with a border and its title inside it", () => {
		const wm = makeManager("repl");
		const lines = wm.render(20);
		// getViewRows=10 -> available=6 -> body rows = 6 - BORD, plus BORD border rows.
		assert.equal(lines.length, BORD + (6 - BORD));
		assert.equal(lines.length, 6);
		const s = lines.map(strip);
		assert.match(s[0]!, /^┌/);
		assert.ok(s[0]!.includes("repl"));
		assert.match(s[1]!, /^│/);
		assert.ok(s[1]!.includes("R"));
		assert.match(s[5]!, /^└/);
	});

	it("vsplit gives equal columns regardless of pane content", () => {
		const wm = makeManager("repl");
		wm.register("a", stubPane("A"));
		assert.ok(wm.split("v", 0, "a").ok);
		const s = wm.render(21).map(strip);
		// Each pane draws a border edge, so the split seam is an adjacent ││ pair.
		const row = s[1]!;
		const seam = row.indexOf("││");
		assert.ok(seam > 3 && seam < row.length - 3, `seam near middle, got col ${seam}`);
		assert.ok(row.slice(0, seam).includes("R"), "left pane is the repl content");
		assert.ok(row.slice(seam).includes("A"), "right pane survived the split");
	});

	it("a wide transcript does not starve the other pane", () => {
		const wm = makeManager("repl");
		wm.register("a", stubPane("A"));
		wm.register("repl", { id: "repl", render: (w: number) => ["R".repeat(w * 4)], invalidate: () => {} });
		assert.ok(wm.split("v", 0, "a").ok);
		const row = wm.render(21).map(strip)[1]!;
		const seam = row.indexOf("││");
		assert.ok(seam > 0 && row.slice(seam).includes("A"), "the right pane still fits beside a wide transcript");
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

	it("swap exchanges cells; content follows the pane id", () => {
		const wm = makeManager("repl");
		wm.register("a", stubPane("A"));
		assert.ok(wm.split("v", 0, "a").ok); // v(repl, a), active a
		assert.ok(wm.swap("a", "repl").ok); // v(a, repl)
		assert.deepEqual(wm.list().map((p) => p.id), ["a", "repl"]);
		assert.equal(wm.active, "a");
		assert.equal(wm.resolve(0), "a");
		assert.equal(wm.resolve(1), "repl");
		const row = wm.render(21).map(strip)[1]!;
		const seam = row.indexOf("││");
		assert.ok(row.slice(0, seam).includes("A"), "a's content sits in the left cell");
		assert.ok(row.slice(seam).includes("R"), "repl content sits in the right cell");
	});

	it("swap with one ref swaps the active pane", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok); // repl | pane2, active pane2
		assert.ok(wm.swap("repl").ok); // pane2 | repl
		assert.deepEqual(wm.list().map((p) => p.id), ["pane2", "repl"]);
		assert.equal(wm.active, "repl");
	});

	it("swap refuses itself and unknown panes", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok);
		assert.match(wm.swap(0, 0).error!, /itself/);
		assert.match(wm.swap("nope", 0).error!, /named 'nope'/);
		assert.match(wm.swap(9, 0).error!, /index 9/);
		assert.deepEqual(wm.list().map((p) => p.id), ["repl", "pane2"]);
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
		assert.ok(lines.some((l) => l.includes("pane2")));
	});

	it("hsplit stacks rows; the active pane gets a border, the inactive a title row", () => {
		const wm = makeManager("repl");
		wm.register("b", stubPane("B"));
		assert.ok(wm.split("h", 0, "b").ok); // b becomes active, repl inactive
		const lines = wm.render(30).map(strip);
		// Each pane: BORD border rows + 1 body row = 3; two panes -> 6. Body rows
		// are 1 because the available 6 rows are shared down to 3 each.
		assert.equal(lines.length, 6);
		assert.ok(lines[0]!.includes("repl"));
		assert.ok(lines[1]!.includes("R"), "repl body present");
		assert.match(lines[3]!, /^┌/, "active (b) pane gets a bordered top");
		assert.ok(lines[4]!.includes("B"), `active b body present at line 4`);
	});

	it("keeps a full-height left pane when only the right branch is split", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok); // repl | pane2
		assert.ok(wm.split("h").ok); // repl | pane2 / pane3

		wm.render(80);
		// getViewRows=10 -> available=6.
		assert.equal(wm.getBodyRows("repl"), 6 - BORD); // full left height, minus borders
		assert.equal(wm.getBodyRows("pane2"), 1); // (6/2)-BORD, floor
		assert.equal(wm.getBodyRows("pane3"), 1);
	});

	it("the window block fits in the rows left after screen chrome", () => {
		const wm = makeManager("repl");
		assert.equal(wm.render(80).length, 6);
		assert.ok(wm.split("v").ok);
		assert.equal(wm.render(80).length, 6);
		assert.ok(wm.split("h", 1).ok);
		assert.ok(wm.render(80).length <= 6);
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
		assert.equal(lines.length, BORD + wm.bodyRows, "border rows + fixed body, regardless of content");
		assert.ok(lines.some((l) => l.includes("line49")), "latest line must stay visible");
		assert.ok(!lines.some((l) => l.includes("line0")), "old lines scroll away");
		// Simulating `help`: more output must not grow the document.
		wm.register("repl", transcriptLines(80));
		lines = wm.render(40).map(strip);
		assert.equal(lines.length, BORD + wm.bodyRows);
		assert.ok(lines.some((l) => l.includes("line79")));
	});

	it("unregistered panes render as slabs, not errors", () => {
		const wm = makeManager("repl");
		assert.ok(wm.split("v").ok);
		const rendered = wm.render(40);
		assert.ok(rendered.every((l) => visibleWidth(l) <= 41));
	});

	it("keeps the repl right border flush to the pane edge on every row", () => {
		const wm = makeManager("repl");
		wm.register("repl", { id: "repl", render: () => ["short", ""], invalidate: () => {} });
		const raw = wm.render(40);
		const s = raw.map(strip);
		for (const row of s) assert.equal(row.length, 40, `row padded to pane width: ${JSON.stringify(row)}`);
		assert.match(s[0]!, /^┌ .*┐$/);
		assert.match(s[1]!, /^│short.*│$/);
		assert.match(s[s.length - 1]!, /^└.*┘$/);
	});

	it("paints the focused pane white, inactive panes subtle gray, top always renders", () => {
		const wm = makeManager("repl");
		wm.register("a", stubPane("A"));
		assert.ok(wm.split("v", 0, "a").ok); // 'a' is now active; repl inactive
		const raw = wm.render(60);
		const joined = raw.join("\n");
		// borderInactive default 234 / borderActive default 255 => valid 256-colour fg.
		assert.ok(joined.includes("\x1b[38;5;234m│"), "inactive pane keeps a subtle gray border");
		assert.ok(joined.includes("\x1b[38;5;255m┌"), "active pane gets a white outline");
		assert.ok(!joined.includes("48;5"), "panes carry no background fill");
		// Every pane's top edge draws a full horizontal segment (not blank spaces).
		const top = strip(raw[0]!);
		assert.ok(top.includes("┌ repl") && /─┐$/.test(top), `inactive top renders a complete line: ${JSON.stringify(top)}`);
	});
});