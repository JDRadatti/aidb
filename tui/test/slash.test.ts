import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AidbCompletionProvider, buildCommandRegistry, exactSaveItems } from "../src/slash.ts";
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
		const s = await suggest(p, "/win switch qq", 14);
		assert.ok(s);
		assert.ok(s!.values.includes("qq-target"));
	});

	it("completes /win swap panes for both arguments", async () => {
		const first = await suggest(p, "/win swap qq", 12);
		assert.ok(first);
		assert.ok(first!.values.includes("qq-target"));

		const second = await suggest(p, "/win swap repl ", 15);
		assert.ok(second);
		assert.ok(second!.values.includes("mem"));
	});

	it("does not suggest GDB verbs as slash commands", async () => {
		const s = await suggest(p, "/run", 4);
		assert.equal(s, null);
		const b = await suggest(p, "/br", 3);
		assert.equal(b, null);
		const r = await suggest(p, "/remove", 7);
		assert.equal(r, null);
	});

	it("suggests only the aidb organizing commands in the slash menu", async () => {
		const s = await suggest(p, "/", 1);
		assert.ok(s);
		const vals = s!.values;
		assert.ok(vals.includes("session"));
		assert.ok(vals.includes("open"));
		assert.ok(vals.includes("win"));
		// GDB verbs are bare, not slash-completable.
		assert.ok(!vals.includes("run"));
		assert.ok(!vals.includes("break"));
		assert.ok(!vals.includes("continue"));
	});
});
describe("AidbCompletionProvider Tab gate (shouldTriggerFileCompletion)", () => {
	const p = provider();
	const trigger = (line: string): boolean => p.shouldTriggerFileCompletion([line], 0, line.length);

	it("blocks Tab on bare commands where a file is not expected", () => {
		assert.equal(trigger("continue"), false);
		assert.equal(trigger("print x"), false);
		assert.equal(trigger("bt"), false);
		assert.equal(trigger(""), false);
	});

	it("allows Tab for the program-loading verbs run/file", () => {
		assert.equal(trigger("run exa"), true);
		assert.equal(trigger("file exa"), true);
		// Args after the program are not paths.
		assert.equal(trigger("run ./example --fast"), false);
		// An empty token right after `run ` — nothing to complete yet.
		assert.equal(trigger("run "), false);
	});

	it("allows Tab on path-shaped tokens anywhere", () => {
		assert.equal(trigger("run ./ex"), true);
		assert.equal(trigger("break src/main.c:12"), true);
		assert.equal(trigger("./bin/aidb"), true);
		assert.equal(trigger("@doc"), true);
		assert.equal(trigger("print ~/lib"), true);
	});

	it("never gates slash lines (position-aware args ride the same Tab request)", () => {
		assert.equal(trigger("/win"), true);
		assert.equal(trigger("/win load "), true);
	});
});

describe("slash arguments · save verbs (exact-only, never fuzzy)", () => {
	const p = provider();
	const line = (text: string) => suggest(p, text, text.length);

	it("/layout save asm must not retarget a fuzzy-similar saved iasm", async () => {
		assert.equal(await line("/layout save asm"), null, "no dropdown ⇒ Enter submits the literal 'asm' and creates it");
	});

	it("a partial of a saved name is not exact — the typed text wins (creates)", async () => {
		assert.equal(await line("/layout save ias"), null);
	});

	it("/session save asm and /target save asm are exact too", async () => {
		assert.equal(await line("/session save asm"), null);
		assert.equal(await line("/target save asm"), null);
	});
});

describe("slash arguments · save verbs with a saved collection (exact match offered)", () => {
	const layoutMeta = (name: string) => ({ name, file: `layouts/${name}.json`, savedAt: 1, panes: 1, watchEntries: 0 });
	const sessionMeta = (name: string) => ({ name, file: `sessions/${name}.json`, savedAt: 1, breakpoints: 0 });
	const targetMeta = (name: string) => ({ name, file: `targets/${name}.json`, savedAt: 1, kind: "launch", args: [] });
	const savedCtx = {
		sessions: {
			activeName: () => null,
			list: () => [sessionMeta("iasm")],
			layouts: { current: () => null, list: () => [layoutMeta("iasm")] },
			targets: { current: () => null, list: () => [targetMeta("iasm")] },
		},
	} as unknown as ReplContext;
	const p = new AidbCompletionProvider(buildCommandRegistry(), savedCtx, process.cwd());
	const line = (text: string) => suggest(p, text, text.length);

	it("exact typed name still offers the saved profile (update path)", async () => {
		const s = await line("/layout save iasm");
		assert.ok(s);
		assert.deepEqual(s!.values, ["iasm"]);
	});

	it("matches case-insensitively", async () => {
		const s = await line("/layout save IASM");
		assert.ok(s);
		assert.deepEqual(s!.values, ["iasm"]);
	});

	it("same surface for /session and /target", async () => {
		assert.deepEqual((await line("/session save iasm"))!.values, ["iasm"]);
		assert.deepEqual((await line("/target save iasm"))!.values, ["iasm"]);
	});

	it("a trailing space after save offers ONLY the active profile (never the full list)", async () => {
		const activeCtx = {
			sessions: {
				activeName: () => null,
				list: () => [],
				layouts: { current: () => "iasm", list: () => [layoutMeta("iasm")] },
				targets: { current: () => null, list: () => [] },
			},
		} as unknown as ReplContext;
		const ap = new AidbCompletionProvider(buildCommandRegistry(), activeCtx, process.cwd());
		const s = await suggest(ap, "/layout save ", "/layout save ".length);
		assert.ok(s);
		assert.deepEqual(s!.values, ["iasm"]);
	});

	it("the APPLY path (/layout asm) keeps fuzzy matching — referencing saved names", async () => {
		const s = await line("/layout asm");
		assert.ok(s);
		assert.deepEqual(s!.values, ["iasm"]);
	});
});

describe("exactSaveItems", () => {
	const names = [
		{ value: "iasm", label: "iasm" },
		{ value: "iasc", label: "iasc" },
		{ value: "code", label: "code" },
	];

	it("rejects a fuzzy-similar (non-exact) typed name — the repro", () => {
		assert.deepEqual(exactSaveItems(names, "asm", null), []);
	});

	it("a partial of a saved name is not exact", () => {
		assert.deepEqual(exactSaveItems(names, "ias", null), []);
	});

	it("offers the exact name (case-insensitively)", () => {
		assert.deepEqual(exactSaveItems(names, "iasm", null).map((i) => i.value), ["iasm"]);
		assert.deepEqual(exactSaveItems(names, "IASM", null).map((i) => i.value), ["iasm"]);
	});

	it("an empty token offers only the active profile", () => {
		assert.deepEqual(exactSaveItems(names, "", "iasc").map((i) => i.value), ["iasc"]);
	});

	it("an empty token with no active profile offers nothing — never the full list", () => {
		assert.deepEqual(exactSaveItems(names, "", null), []);
	});
});
