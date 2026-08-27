import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canReuseObservation, requiredBytes } from "../src/viz/render-spec.ts";

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
});
