import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PANES_PER_DIRECTION, SplitTree } from "../src/split-tree.ts";

describe("SplitTree", () => {
	it("starts with a single active pane", () => {
		const tree = new SplitTree("repl");
		assert.deepEqual(tree.panes(), ["repl"]);
		assert.equal(tree.active, "repl");
	});

	it("vsplit inserts columns beside the active pane", () => {
		const tree = new SplitTree("repl");
		assert.ok(tree.split("v", "a").ok);
		assert.ok(tree.split("v", "b").ok);
		assert.deepEqual(tree.panes(), ["repl", "a", "b"]);
		assert.equal(tree.active, "b");
		const root = tree.root as any;
		assert.equal(root.dir, "v");
		assert.deepEqual(root.children, ["repl", "a", "b"]);
	});

	it("rejects a vsplit beyond the column cap", () => {
		const tree = new SplitTree("repl");
		for (const id of ["a", "b"]) assert.ok(tree.split("v", id).ok);
		const result = tree.split("v", "c");
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /max 3 columns/);
		assert.equal(tree.panes().length, MAX_PANES_PER_DIRECTION);
	});

	it("the row budget is independent of the column budget", () => {
		const tree = new SplitTree("repl");
		tree.split("v", "a");
		tree.split("v", "b");
		// Columns are full; hsplit wraps the active leaf in a row group.
		assert.ok(tree.split("h", "r1").ok);
		const root = tree.root as any;
		assert.equal(root.dir, "v");
		const last = root.children[2];
		assert.equal(last.dir, "h");
		assert.deepEqual(last.children, ["b", "r1"]);
	});

	it("inserts into the nearest enclosing group of the same direction", () => {
		const tree = new SplitTree("repl");
		tree.split("v", "a"); // v(repl, a)
		tree.split("h", "r1"); // v(repl, h(a, r1)) — focus r1
		assert.ok(tree.split("v", "a2").ok);
		// The nearest v-ancestor is the root: a2 becomes a full-height column
		// beside the whole h-cell, keeping global columns at 3.
		const root = tree.root as any;
		assert.equal(root.dir, "v");
		assert.deepEqual(
			root.children.map((c: any) => (typeof c === "string" ? c : c.dir)),
			["repl", "h", "a2"],
		);
		assert.deepEqual(root.children[1].children, ["a", "r1"]);
	});

	it("halves the active pane's weight when splitting", () => {
		const tree = SplitTree.deserialize({
			root: { dir: "v", children: ["x", "y"], sizes: [100, 100] },
			active: "y",
		});
		tree.split("v", "z");
		const sizes = (tree.root as any).sizes;
		assert.deepEqual(sizes, [100, 50, 50]);
	});

	it("close collapses groups down to a single child", () => {
		const tree = new SplitTree("repl");
		tree.split("h", "below"); // h(repl, below)
		assert.ok(tree.close("repl").ok);
		assert.deepEqual(tree.panes(), ["below"]);
		assert.equal(tree.active, "below");
		assert.equal(typeof tree.root, "string");
	});

	it("close refuses the last pane and unknown panes", () => {
		const tree = new SplitTree("repl");
		assert.equal(tree.close("repl").ok, false);
		assert.equal(tree.close("nope").ok, false);
	});

	it("closing the active pane focuses a neighbor", () => {
		const tree = new SplitTree("repl");
		tree.split("v", "a");
		tree.split("v", "b"); // active b
		tree.close("b");
		assert.equal(tree.active, "a");
	});

	it("cycleFocus walks panes in order and wraps", () => {
		const tree = new SplitTree("repl");
		tree.split("v", "a"); // split focuses the new pane
		assert.equal(tree.cycleFocus(), "repl");
		assert.equal(tree.cycleFocus(), "a");
	});

	it("survives a serialize/deserialize round trip", () => {
		const tree = new SplitTree("repl");
		tree.split("v", "a");
		tree.split("h", "r1");
		const copy = SplitTree.deserialize(tree.serialize());
		assert.deepEqual(copy.serialize(), tree.serialize());
		assert.deepEqual(copy.panes(), tree.panes());
	});

	it("regression: hsplit works in a lone column beside a row-split column", () => {
		// 3 columns, the leftmost split into rows, then the last column closed.
		const tree = new SplitTree("repl");
		tree.split("v", "a");
		tree.split("v", "b"); // v(repl, a, b)
		tree.setActive("repl");
		tree.split("h", "r1"); // v(h(repl, r1), a, b)
		tree.close("b"); // v(h(repl, r1), a)
		// `a` is a lone column whose neighbor is itself full of rows; splitting
		// it into rows used to be rejected as "max 3 rows".
		tree.setActive("a");
		assert.ok(tree.split("h", "na").ok);
		assert.deepEqual(tree.panes(), ["repl", "r1", "a", "na"]);
	});
});
