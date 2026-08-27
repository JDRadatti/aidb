import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ACTIONS, resolveAction } from "../src/config.ts";

// Raw terminal sequences for a few keys, as matchesKey expects.
const KEY = {
	ctrlP: "\x10",
	ctrlN: "\x0e",
	ctrlUp: "\x1b[1;5A",
	ctrlDown: "\x1b[1;5B",
};

describe("action dispatch", () => {
	it("default bindings fire the expected actions", () => {
		assert.equal(resolveAction(DEFAULT_ACTIONS, KEY.ctrlUp), "scrollUp");
		assert.equal(resolveAction(DEFAULT_ACTIONS, KEY.ctrlDown), "scrollDown");
		// a plain F-key sequence is not representable here, but a remapped
		// control chord is:
		assert.equal(resolveAction({ ...DEFAULT_ACTIONS, continue: ["ctrl+p"] }, KEY.ctrlP), "continue");
	});

	it("remapping an action through config takes effect", () => {
		const bindings = { ...DEFAULT_ACTIONS, stepOver: ["ctrl+n"] };
		assert.equal(resolveAction(bindings, KEY.ctrlN), "stepOver");
		// the old default no longer matches once remapped
		assert.equal(resolveAction(bindings, KEY.ctrlP), null);
	});

	it("returns null for unbound input", () => {
		assert.equal(resolveAction(DEFAULT_ACTIONS, "\x1b[1;5A") === null, false); // scrollUp, sanity
		// a modifier combo that no action claims resolves to nothing
		const restrictive = { ...DEFAULT_ACTIONS, scrollUp: [] as string[], scrollDown: [] as string[] };
		assert.equal(resolveAction(restrictive, KEY.ctrlUp), null);
		assert.equal(resolveAction(restrictive, KEY.ctrlDown), null);
	});

	it("a chord can be bound to multiple keys; one press resolves once", () => {
		const bindings = { ...DEFAULT_ACTIONS, stepInto: ["ctrl+p", "ctrl+n"] };
		assert.equal(resolveAction(bindings, KEY.ctrlN), "stepInto");
		assert.equal(resolveAction(bindings, KEY.ctrlP), "stepInto");
	});
});