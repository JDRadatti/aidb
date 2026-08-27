import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AidbCompletionProvider, buildCommandRegistry } from "../src/slash.ts";
import type { ReplContext } from "../src/repl.ts";

/** Minimal fake window manager: only what the completer touches (list). */
const fakeWindows = {
	list: () => [
		{ idx: 0, id: "repl", title: "aidb", active: true },
		{ idx: 1, id: "mem", title: "memory", active: false },
		{ idx: 2, id: "watch", title: "watch", active: false },
		{ idx: 3, id: "qq-target", title: "qq", active: false },
	],
};

const fakeApi = {
	breakpoints: new Map([
		[1, { id: 1, file: "main.c", line: 12, verified: true }],
		[2, { id: 2, file: "player.c", line: 9, verified: true }],
	]),
};

const ctx = { windows: fakeWindows, getApi: () => fakeApi } as unknown as ReplContext;

function provider(): AidbCompletionProvider {
	return new AidbCompletionProvider(buildCommandRegistry(), ctx, process.cwd());
}

/** Collect values (optionally descriptions) for a suggestion query at (`line`, col). */
async function suggest(owner: AidbCompletionProvider, line: string, col: number) {
	const result = await owner.getSuggestions([line], 0, col, {
		signal: new AbortController().signal,
		force: false,
	});
	return result ? { prefix: result.prefix, items: result.items, values: result.items.map((i) => i.value) } : null;
}

/** Apply a selection exactly as the editor would (stock applyCompletion). */
function apply(owner: AidbCompletionProvider, line: string, item: string, prefix: string) {
	const { lines, cursorCol } = owner.applyCompletion(
		[line],
		0,
		line.length,
		{ value: item, label: item },
		prefix,
	);
	return { text: lines[0]!, cursorCol };
}

describe("AidbCompletionProvider slash arguments", () => {
	const p = provider();

	it("completes command names with fuzzy prefix", async () => {
		const s = await suggest(p, "/wi", 3);
		assert.ok(s);
		assert.ok(s!.values.includes("win"));
	});

	it("completes /win subcommands (load via fuzzy)", async () => {
		const s = await suggest(p, "/win l", 6);
		assert.ok(s);
		assert.ok(s!.values.includes("load"));
	});

	it("completes /win load <pane> then the visualizer", async () => {
		const panes = await suggest(p, "/win load ", 11);
		assert.ok(panes);
		assert.ok(panes!.values.includes("mem"));

		const visuals = await suggest(p, "/win load mem ", 15);
		assert.ok(visuals);
		assert.equal(
			["regs", "mem", "plot", "tree", "source", "asm", "iasm"].every((v) => visuals!.values.includes(v)),
			true,
		);
	});

	it("does not erase earlier args when completing a pane token", () => {
		const r = apply(p, "/win load m", "mem", "m");
		assert.equal(r.text, "/win load mem");
	});

	it("keeps the trailing-space arg intact when applying a visualizer", () => {
		const r = apply(p, "/win load mem ", "regs", "");
		assert.equal(r.text, "/win load mem regs");
	});

	it("fuzzy-matches a pane by name (qq → qq-target)", async () => {
		const s = await suggest(p, "/switch qq", 10);
		assert.ok(s);
		assert.ok(s!.values.includes("qq-target"));
	});

	it("completes /remove from live breakpoints", async () => {
		const s = await suggest(p, "/remove ", 9);
		assert.ok(s);
		assert.deepEqual(s!.values, ["1", "2"]);
	});

	it("completes /launch from the current directory", async () => {
		const s = await suggest(p, "/launch ", 9);
		assert.ok(s);
		assert.ok(s!.values.length > 0);
	});

	it("offers a `..` parent directory for path completion", async () => {
		const s = await suggest(p, "/launch ", 9);
		assert.ok(s);
		assert.ok(s!.values.some((v) => v.startsWith("..")));
		const up = s!.items[0]!;
		assert.ok(up.value.startsWith(".."));
		const r = apply(p, "/launch ", up.value, "");
		assert.equal(r.text, `/launch ${up.value}`);
	});
});