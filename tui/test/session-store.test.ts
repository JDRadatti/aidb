import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createStores, LAYOUT_SCHEMA_VERSION, implicitProfileName, newSessionId, SESSION_SCHEMA_VERSION, TARGET_SCHEMA_VERSION } from "../src/session-store.ts";

/** Root dir; sessions live in `root/sessions`, targets/layouts in siblings. */
function tmp(over: { seedSessions?: string[]; seedTargets?: string[]; seedLayouts?: string[] } = {}): {
	root: string;
	s: ReturnType<typeof createStores>;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidb-ws-"));
	const s = createStores(path.join(root, "sessions"));
	for (const [dir, names] of [
		["sessions", over.seedSessions ?? []],
		["targets", over.seedTargets ?? []],
		["layouts", over.seedLayouts ?? []],
	] as const) {
		for (const name of names) writeFake(root, dir, name);
	}
	return { root, s };
}

function writeFake(root: string, dir: string, name: string): void {
	const d = path.join(root, dir);
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(d, `${name}.json`), "{}");
}

const now = () => 1720000000000;

describe("workspace stores (3-way split)", () => {
	it("three stores live in sibling dirs under the session root", () => {
		const { root, s } = tmp();
		assert.equal(s.targets.dir, path.join(root, "targets"));
		assert.equal(s.layouts.dir, path.join(root, "layouts"));
		assert.equal(s.sessions.dir, path.join(root, "sessions"));
	});

	it("saves 3-way state; load round-trips each store", async () => {
		const { s } = tmp();
		await s.targets.save({
			schemaVersion: TARGET_SCHEMA_VERSION, name: "game", kind: "launch",
			program: "/abs/path/game", args: ["--seed", "42"], savedAt: now(),
		});
		await s.layouts.save({
			schemaVersion: LAYOUT_SCHEMA_VERSION, name: "code-watch",
			splitTree: { root: { dir: "v", children: ["repl", "watch"], sizes: [1, 1] }, active: "watch" },
			watchPanes: { watch: { entries: [{ expr: "&player", renderSpec: { rendererId: "hexdump" }, byteCount: 192 }] } },
			savedAt: now(),
		});
		await s.sessions.save({
			schemaVersion: SESSION_SCHEMA_VERSION, name: "bug1",
			target: "game", layout: "code-watch",
			breakPoints: [
				{ file: "game.c", line: 12, verified: true },
				{ location: "player_update", file: "game.c", line: 88, verified: true },
			],
			savedAt: now(),
		});

		const t = s.targets.load("game");
		assert.ok(!("error" in t));
		assert.equal(t.state.program, "/abs/path/game");
		assert.deepEqual(t.state.args, ["--seed", "42"]);

		const l = s.layouts.load("code-watch");
		assert.ok(!("error" in l));
		assert.equal(l.state.watchPanes.watch.entries[0]!.expr, "&player");

		const sess = s.sessions.load("bug1");
		assert.ok(!("error" in sess));
		assert.equal(sess.state.target, "game");
		assert.equal(sess.state.layout, "code-watch");
		assert.equal(sess.state.breakPoints.length, 2);
	});

	it("lists session metadata with target/layout refs", async () => {
		const { s } = tmp();
		await s.sessions.save({
			schemaVersion: SESSION_SCHEMA_VERSION, name: "alpha",
			target: "a-tgt", layout: "a-lay",
			breakPoints: [{ file: "a.c", line: 1, verified: true }], savedAt: now(),
		});
		const list = s.sessions.list();
		assert.equal(list.length, 1);
		assert.equal(list[0]!.target, "a-tgt");
		assert.equal(list[0]!.layout, "a-lay");
		assert.equal(list[0]!.breakpoints, 1);
	});

	it("degrades a corrupt file to an error, not a crash", () => {
		const { root, s } = tmp({ seedSessions: ["broken"] });
		fs.writeFileSync(path.join(root, "sessions", "broken.json"), "{ not json");
		const result = s.sessions.load("broken");
		assert.ok("error" in result);
		assert.match(result.error, /not valid JSON/);
		assert.equal(s.sessions.list().length, 0);
	});

	it("degrades an unsupported schema version to an error", () => {
		const { root, s } = tmp({ seedTargets: ["future"] });
		fs.writeFileSync(path.join(root, "targets", "future.json"), JSON.stringify({ schemaVersion: 99, name: "future" }));
		const result = s.targets.load("future");
		assert.ok("error" in result);
		assert.match(result.error, /schema version/);
	});

	it("handles missing docs gracefully", () => {
		const { s } = tmp();
		const result = s.targets.load("never-existed");
		assert.ok("error" in result);
		assert.match(result.error, /no targets/);
	});

	it("remove deletes and clears the active doc", async () => {
		const { s } = tmp();
		await s.targets.save({ schemaVersion: TARGET_SCHEMA_VERSION, name: "temp", kind: "launch", program: "/x", args: [], savedAt: now() });
		s.targets.setActive("temp");
		assert.equal(s.targets.activeName(), "temp");
		await s.targets.remove("temp");
		assert.equal(s.targets.activeName(), null);
		assert.equal(s.targets.list().length, 0);
	});

	it("session id persists through a round-trip", async () => {
		const { s } = tmp();
		const id = newSessionId();
		await s.sessions.save({
			schemaVersion: SESSION_SCHEMA_VERSION, name: "foo", id,
			target: null, layout: null, breakPoints: [], savedAt: now(),
		});
		const loaded = s.sessions.load("foo");
		assert.ok(!("error" in loaded));
		assert.equal(loaded.state.id, id, "restore must read the same stable id");
	});

	it("watch entries survive a layout round-trip", async () => {
		const { s } = tmp();
		await s.layouts.save({
			schemaVersion: LAYOUT_SCHEMA_VERSION, name: "wat",
			splitTree: { root: "repl", active: "repl" },
			watchPanes: { watch: { entries: [{ expr: "&player", renderSpec: { rendererId: "lines", flags: 1 }, byteCount: 64 }] } },
			savedAt: now(),
		});
		const l = s.layouts.load("wat");
		assert.ok(!("error" in l));
		assert.equal(l.state.watchPanes.watch.entries[0]!.byteCount, 64);
		assert.equal(l.state.watchPanes.watch.entries[0]!.renderSpec.flags, 1);
	});

	it("live panes (source/asm/regs/...) survive a layout round-trip", async () => {
		const { s } = tmp();
		await s.layouts.save({
			schemaVersion: LAYOUT_SCHEMA_VERSION, name: "code",
			splitTree: { root: { dir: "v", children: ["repl", "src"], sizes: [1, 1] }, active: "src" },
			watchPanes: {},
			livePanes: {
				src: { spec: { kind: "source" }, interpreterId: "code", flags: 4 },
				mem: { spec: { kind: "mem", at: "&buf", byteCount: 48 }, interpreterId: "table" },
				plot: { spec: { kind: "plot", expr: "hp", historySize: 60 }, interpreterId: "sparkline" },
				tree: { spec: { kind: "tree", expr: "player", depth: 3 }, interpreterId: "struct-tree" },
			},
			savedAt: now(),
		});
		const l = s.layouts.load("code");
		assert.ok(!("error" in l));
		assert.deepEqual(l.state.livePanes?.src, { spec: { kind: "source" }, interpreterId: "code", flags: 4 });
		assert.equal(l.state.livePanes?.mem.spec.byteCount, 48);
		assert.equal(l.state.livePanes?.plot.spec.historySize, 60);
		assert.equal(l.state.livePanes?.tree.spec.depth, 3);
		const meta = s.layouts.list().find((m) => m.name === "code");
		assert.equal(meta?.livePaneCount, 4);
	});

	it("legacy layouts without livePanes load as empty and round-trip", async () => {
		const { s } = tmp();
		// A v1 layout saved before live panes existed: no livePanes field.
		fs.mkdirSync(s.layouts.dir, { recursive: true });
		const file = path.join(s.layouts.dir, "old.json");
		fs.writeFileSync(file, JSON.stringify({
			schemaVersion: 1, name: "old",
			splitTree: { root: { dir: "v", children: ["repl", "pane2"], sizes: [1, 1] }, active: "pane2" },
			watchPanes: {},
			savedAt: now(),
		}));
		const l = s.layouts.load("old");
		assert.ok(!("error" in l));
		assert.deepEqual(l.state.livePanes, {});
	});

	it("degrades malformed live panes instead of failing the layout", async () => {
		const { s } = tmp();
		// `minimal` is a valid pane (default interpreter/flags fill in) and is
		// kept; unknown kinds and specs missing required params are dropped.
		const livePanes = {
			good: { spec: { kind: "source" }, interpreterId: "code" },
			minimal: { spec: { kind: "asm" } },
			badKind: { spec: { kind: "wat" }, interpreterId: "code" },
			noExpr: { spec: { kind: "plot" }, interpreterId: "sparkline" },
		} as unknown as import("../src/session-store.ts").SessionLivePanes;
		await s.layouts.save({
			schemaVersion: LAYOUT_SCHEMA_VERSION, name: "messy",
			splitTree: { root: "repl", active: "repl" },
			watchPanes: {},
			livePanes,
			savedAt: now(),
		});
		const l = s.layouts.load("messy");
		assert.ok(!("error" in l));
		assert.deepEqual(Object.keys(l.state.livePanes ?? {}), ["good", "minimal"]);
		assert.equal(l.state.livePanes?.minimal.interpreterId, "code"); // defaulted from kind
		assert.equal(l.state.livePanes?.minimal.flags, undefined);
	});

	it("per-session UUID isolates implicit profiles so nothing clobbers another's data", async () => {
		const { s } = tmp();
		// Regression: creating a new session used to flush an EMPTY layout into
		// a shared "default". Even session-NAME-based scoping fails when two
		// sessions share a name ("session") or are renamed. A per-session UUID
		// guarantees distinct implicit profiles, noun-prefixed (`session_<uuid>`
		// sessions, `target_<uuid>` targets).
		const fooLayout = implicitProfileName("layout", newSessionId());
		const barLayout = implicitProfileName("layout", newSessionId());
		assert.notEqual(fooLayout, barLayout, "distinct sessions get distinct implicit profiles");
		assert.match(fooLayout, /^layout_[0-9a-f-]{36}$/i);

		await s.layouts.save({
			schemaVersion: LAYOUT_SCHEMA_VERSION, name: fooLayout,
			splitTree: { root: { dir: "v", children: ["repl", "watch"], sizes: [1, 1] }, active: "watch" },
			watchPanes: {
				watch: { entries: [{ expr: "&player", renderSpec: { rendererId: "hexdump" }, byteCount: 192 }] },
			},
			savedAt: now(),
		});
		// A new session B starts fresh with its own scoped layout.
		await s.layouts.save({
			schemaVersion: LAYOUT_SCHEMA_VERSION, name: barLayout,
			splitTree: { root: "repl", active: "repl" },
			watchPanes: {},
			savedAt: now(),
		});
		// foo's layout must still be intact, not clobbered by B.
		const stillFoo = s.layouts.load(fooLayout);
		assert.ok(!("error" in stillFoo));
		assert.equal(stillFoo.state.watchPanes.watch.entries[0]!.expr, "&player");
	});
});