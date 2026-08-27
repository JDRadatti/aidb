import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canReuseObservation, cycleRenderer, requiredBytes, withFlagToggle } from "../src/viz/render-spec.ts";
import { ViewFlags } from "../src/viz/types.ts";

describe("render-spec", () => {
	it("defaults lines to value-only fetch budget", () => {
		assert.equal(requiredBytes({ rendererId: "lines" }), 0);
	});

	it("computes bitmap byte budgets from options", () => {
		assert.equal(requiredBytes({ rendererId: "bitmap", options: { width: 2, height: 2, tupleWidth: 3 } }), 12);
	});

	it("reuses cached bytes when switching between compatible memory renderers", () => {
		assert.equal(canReuseObservation(192, 48, { rendererId: "hexdump" }), true);
		assert.equal(canReuseObservation(48, 48, { rendererId: "bitmap", options: { width: 4, height: 4, tupleWidth: 3 } }), true);
		assert.equal(canReuseObservation(48, 48, { rendererId: "bitmap", options: { width: 5, height: 4, tupleWidth: 3 } }), false);
	});

	it("cycles renderers forward and backward without repeating the current", () => {
		assert.equal(cycleRenderer("lines", false), "text");
		assert.equal(cycleRenderer("text", true), "lines");
		assert.equal(cycleRenderer("bitmap"), "hexdump");
		const start = cycleRenderer(cycleRenderer("hexdump", false), true);
		assert.equal(start, "hexdump");
	});

	it("toggles a single flag bit without mutating the input spec", () => {
		const spec = { rendererId: "bytes", flags: ViewFlags.ADDRESSES };
		const toggled = withFlagToggle(spec, ViewFlags.TYPES);
		assert.equal(toggled.flags, ViewFlags.ADDRESSES | ViewFlags.TYPES);
		assert.equal(spec.flags, ViewFlags.ADDRESSES, "input spec must not change");
	});
});
