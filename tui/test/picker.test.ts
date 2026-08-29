import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type TuiInputListener } from "@earendil-works/pi-tui";
import { installPickerHost, openPicker, pickerActive, pickerLineSource, type PickerHost, type PickerItem } from "../src/picker.ts";

setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {}));

/** Raw terminal key sequences — matchesKey works on bytes, not key ids. */
const ENTER = "\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

interface Harness {
	/** The band the picker emits through the shared overlay source. */
	rendered(width?: number): string[];
	/** The prompt text driven while the finder is open (`> <query>`), or "" when closed. */
	get prompt(): string;
	send(data: string): void;
	picked: PickerItem | null;
	cancelled: boolean;
	/** Queries passed to `onCreate` (only when create is enabled). */
	created: string[];
	/** Items passed to `onDelete` (only when delete is enabled). */
	deleted: PickerItem[];
}

interface HarnessOpts {
	/** Enables the `+ create …` row with this label builder. */
	createLabel?: (query: string) => string;
	/** Enables the ctrl+d inline delete flow. */
	delete?: boolean;
	/** Seeds the finder's filter (a pasted `> <query>` line). */
	initialFilter?: string;
}

function harness(items: PickerItem[], opts: HarnessOpts = {}): Harness {
	let listener: TuiInputListener | null = null;
	let prompt = "";
	const state: Harness = {
		created: [],
		deleted: [],
		get prompt() {
			return prompt;
		},
		rendered: (width = 50) => pickerLineSource(width) ?? [],
		send: (data) => listener?.(data),
		picked: null,
		cancelled: false,
	};
	const host: PickerHost = {
		addInputListener: (fn) => {
			listener = fn;
			return () => {
				listener = null;
			};
		},
		requestRender: () => {},
		setPromptText: (text) => {
			prompt = text;
		},
	};
	installPickerHost(host);
	const createLabel = opts.createLabel;
	openPicker({
		title: "resume session",
		items,
		onPick: (item) => {
			state.picked = item;
		},
		onCancel: () => {
			state.cancelled = true;
		},
		...(createLabel !== undefined
			? {
					createLabel,
					onCreate: (query: string) => {
						state.created.push(query);
					},
				}
			: {}),
		...(opts.delete
			? {
					onDelete: (item: PickerItem) => {
						state.deleted.push(item);
					},
				}
			: {}),
		...(opts.initialFilter !== undefined ? { initialFilter: opts.initialFilter } : {}),
	});
	return state;
}

const SESSIONS: PickerItem[] = [
	{ value: "bug1", label: "bug1 ✳", description: "game · code-watch · bp 3 · now" },
	{ value: "memleak", label: "memleak", description: "game · minimax · bp 1 · 2h ago" },
	{ value: "session", label: "session", description: "• unsaved · current" },
];

describe("openPicker", () => {
	it("renders a chrome-less band: items + footer, no filter row", () => {
		installPickerHost(null); // ensure a fresh host per test
		const h = harness(SESSIONS);
		const lines = h.rendered().filter((line) => line.trim().length > 0);
		assert.ok(lines[0]!.includes("bug1"), "first row is the first narrowed item (no filter row on top)");
		assert.ok(lines.some((line) => line.includes("memleak")));
		assert.ok(lines.some((line) => line.includes("Esc cancel")));
		const joined = lines.join("\n");
		assert.ok(!joined.includes("filter:"), "the query lives in the prompt, not the band");
		assert.ok(!joined.includes("\u250c"), "no box top-left corner — chrome-less like the slash dropdown");
		assert.ok(!joined.includes("\u2514"), "no box bottom-left corner");
		assert.ok(!joined.includes("\u2502"), "no box vertical bars");
	});

	it("drives the prompt cursor-style: `>` appears on open, grows as you type, emptied on close", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		assert.equal(h.prompt, "> ", "the `>` prompt shows the instant the finder opens");
		h.send("b");
		h.send("u");
		assert.equal(h.prompt, "> bu", "typing grows the query after the `>` prefix");
		h.send(BACKSPACE);
		h.send(BACKSPACE);
		assert.equal(h.prompt, "> ", "backspacing the whole query leaves the `>` prefix");
		h.send(ESCAPE);
		assert.equal(h.prompt, "", "closing restores the empty prompt");
	});

	it("a pasted `> <query>` seeds the filter before any typing", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { initialFilter: "me" });
		assert.equal(h.prompt, "> me", "the seeded query sits behind the `>` prefix");
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes("memleak"));
		assert.ok(!lines.includes("bug1"));
		assert.ok(!lines.includes("session"), "fuzzy narrow: 'session' doesn't contain 'me'");
		h.send(BACKSPACE);
		assert.equal(h.prompt, "> m", "the seeded filter edits exactly like a typed one");
	});

	it("fuzzy-matches the plain label, not ANSI codes (SGR 'm' must not fake-match)", () => {
		installPickerHost(null);
		// Colored group tags (like /open's "session  …") wrap the label; the
		// SGR code ends in 'm', which would match any query containing an 'm'.
		const colored = SESSIONS.map((s) => ({ ...s, label: `\x1b[90m${s.label}\x1b[0m` }));
		const h = harness(colored);
		h.send("m");
		h.send("e");
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes("memleak"));
		assert.ok(!lines.includes("bug1"));
		assert.ok(!lines.includes("session"), "plain 'session' has no 'me' — only the escape code does");
	});

	it("Esc always closes the finder and clears the prompt", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("b");
		h.send("u");
		assert.ok(pickerActive());
		assert.equal(h.prompt, "> bu");
		h.send(ESCAPE);
		assert.ok(!pickerActive(), "Esc closes the fuzzy finder");
		assert.equal(h.prompt, "", "closing clears the prompt");
		assert.equal(pickerLineSource(50), null, "band is dismissed too");
	});

	it("emits its band through the shared overlay source and stops on close", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		assert.ok(h.rendered().length > 0, "active picker supplies band lines");
		assert.ok(pickerLineSource(50) !== null, "pickerLineSource is live while open");
		h.send(ESCAPE);
		assert.equal(pickerLineSource(50), null, "closed picker contributes nothing");
		assert.equal(h.prompt, "", "closed picker restored the prompt");
	});

	it("narrows fuzzy as you type", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("b");
		h.send("u");
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes("bug1"));
		assert.ok(!lines.includes("memleak"));
		assert.ok(!lines.includes("\u2022")); // the "• unsaved" row is gone too
	});

	it("reaches memleak with 'me' (fuzzy, not prefix)", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("m");
		h.send("e");
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes("memleak"));
		assert.ok(!lines.includes("bug1"));
	});

	it("Enter picks the selected item and closes", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		assert.ok(pickerActive());
		h.send(ENTER);
		assert.equal(h.picked?.value, "bug1"); // first item is selected by default
		assert.ok(!pickerActive());
	});

	it("down + Enter picks the second item", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send(DOWN);
		h.send(ENTER);
		assert.equal(h.picked?.value, "memleak");
		assert.ok(!pickerActive());
	});

	it("backspace un-narrows the filter", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("b");
		h.send("u");
		assert.ok(!h.rendered().join("\n").includes("memleak"));
		h.send(BACKSPACE);
		h.send(BACKSPACE);
		assert.ok(h.rendered().join("\n").includes("memleak"));
	});

	it("Esc cancels and closes", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send(ESCAPE);
		assert.ok(h.cancelled);
		assert.ok(!pickerActive());
		assert.deepEqual(h.picked, null);
	});

	it("Enter with no matches does nothing", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("z");
		h.send("z");
		h.send(ENTER);
		assert.deepEqual(h.picked, null);
		assert.ok(pickerActive());
	});

	it("an empty item list cancels immediately without opening", () => {
		installPickerHost(null);
		const h = harness([]);
		assert.ok(h.cancelled);
		assert.ok(!pickerActive());
	});
});

/* ------------------------------------------------ create + delete affordances ---- */

const CTRL_D = "\x04";

describe("openPicker create row", () => {
	it("shows a + create row when the filter matches nothing saved", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { createLabel: (q) => `create new session "${q}"` });
		h.send("n");
		h.send("e");
		h.send("w");
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes('+ create new session "new"'));
	});

	it("Enter on an auto-selected create row creates with the raw query", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { createLabel: (q) => `create new session "${q}"` });
		h.send("n");
		h.send("e");
		h.send("w");
		h.send(ENTER);
		assert.deepEqual(h.created, ["new"]);
		assert.ok(!pickerActive());
	});

	it("hides the create row on an exact name match and picks it instead", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { createLabel: () => "create new session" });
		h.send("b");
		h.send("u");
		h.send("g");
		h.send("1");
		const lines = h.rendered().join("\n");
		assert.ok(!lines.includes("create new session"));
		h.send(ENTER);
		assert.equal(h.picked?.value, "bug1");
		assert.deepEqual(h.created, []);
	});

	it("opens with an empty item list when create is available", () => {
		installPickerHost(null);
		const h = harness([], { createLabel: (q) => `create new layout "${q}"` });
		assert.ok(pickerActive());
		assert.ok(!h.cancelled);
		h.send("x");
		h.send("y");
		h.send(ENTER);
		assert.deepEqual(h.created, ["xy"]);
		assert.ok(!pickerActive());
	});

	it("preserves the case of the typed name", () => {
		installPickerHost(null);
		const h = harness([], { createLabel: (q) => `create new session "${q}"` });
		h.send("M");
		h.send("y");
		h.send("X");
		h.send(ENTER);
		assert.deepEqual(h.created, ["MyX"]);
	});

	it("still matches existing items case-insensitively with an uppercase filter", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { createLabel: () => "create new session" });
		h.send("B");
		h.send("U");
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes("bug1"));
	});
});

describe("openPicker inline delete", () => {
	it("ctrl+d enters an inline confirm; Enter deletes the selected item", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { delete: true });
		h.send(CTRL_D);
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes('delete "bug1"?'));
		assert.ok(lines.includes("Enter to confirm"));
		h.send(ENTER);
		assert.deepEqual(h.deleted.map((d) => d.value), ["bug1"]);
		assert.ok(!pickerActive());
	});

	it("Esc backs out of the confirm without deleting", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { delete: true });
		h.send(CTRL_D);
		h.send(ESCAPE);
		assert.deepEqual(h.deleted, []);
		assert.ok(pickerActive());
		// Back to browsing: Enter now picks, not deletes.
		h.send(DOWN);
		h.send(ENTER);
		assert.equal(h.picked?.value, "memleak");
	});

	it("ctrl+d on the create row is a no-op", () => {
		installPickerHost(null);
		const h = harness([], { createLabel: () => "create new session", delete: true });
		h.send("n");
		h.send(CTRL_D);
		assert.ok(!h.rendered().join("\n").includes('delete "'));
		assert.ok(pickerActive());
	});
});

/* ------------------------------------------------------ /resume integration ---- */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleReplInput, setLastLaunch, type ReplContext, type ReplIO } from "../src/repl.ts";
import { createStores, TARGET_SCHEMA_VERSION, LAYOUT_SCHEMA_VERSION, SESSION_SCHEMA_VERSION, type SessionState, type TargetState, type LayoutState } from "../src/session-store.ts";
import { SplitTree } from "../src/split-tree.ts";
import { WindowManager } from "../src/window-manager.ts";

describe("/session opens the fuzzy session picker", () => {
	async function seeded(): Promise<{ stores: ReturnType<typeof createStores>; restoreSpy: string[] }> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidb-picker-"));
		const stores = createStores(path.join(dir, "sessions"));
		const target: TargetState = {
			schemaVersion: TARGET_SCHEMA_VERSION, name: "game", kind: "launch", program: "./game", args: [], savedAt: Date.now(),
		};
		const layout: LayoutState = {
			schemaVersion: LAYOUT_SCHEMA_VERSION, name: "code-watch", splitTree: { root: "repl", active: "repl" }, watchPanes: {}, savedAt: Date.now(),
		};
		const s1: SessionState = {
			schemaVersion: SESSION_SCHEMA_VERSION, name: "bug1", target: "game", layout: "code-watch", breakPoints: [], savedAt: Date.now() - 3_600_000,
		};
		const s2: SessionState = {
			schemaVersion: SESSION_SCHEMA_VERSION, name: "memleak", target: "game", layout: "code-watch", breakPoints: [], savedAt: Date.now(),
		};
		await stores.targets.save(target);
		await stores.layouts.save(layout);
		await stores.sessions.save(s1);
		await stores.sessions.save(s2);
		return { stores, restoreSpy: [] as string[] };
	}

	interface ReplCalls {
	startNew: string[];
	saved: string[];
	removed: string[];
	targetSaved: string[];
}

function makeReplCtx(seed: ReturnType<typeof seeded>): { ctx: ReplContext; messages: string[]; calls: ReplCalls } {
		const { stores, restoreSpy } = seed;
		const messages: string[] = [];
		const calls: ReplCalls = { startNew: [], saved: [], removed: [], targetSaved: [] };
		const io: ReplIO = {
			line: (t) => messages.push(t),
			info: (t) => messages.push(t),
			success: (t) => messages.push(t),
			warning: (t) => messages.push(t),
			error: (t) => messages.push(t),
		};
		const windows = new WindowManager(new SplitTree("repl"), { panes: new Map() });
		const ctx: ReplContext = {
			getApi: () => ({ breakpoints: new Map(), getState: () => "idle" }) as never,
			reset: async () => ({}) as never,
			requestExit: () => {},
			requestRender: () => {},
			io,
			windows,
			config: { keybindings: { actions: {} } } as never,
			configSources: { issues: [] } as never,
			reloadConfig: () => ({ config: ctx.config, sources: ctx.configSources }),
			sessions: {
				activeName: () => stores.sessions.activeName(),
				list: () => stores.sessions.list(),
				markDirty: () => {},
				save: async (name) => {
					calls.saved.push(name ?? "");
				},
				setCurrent: () => {},
				remove: async (name) => {
					calls.removed.push(name);
				},
				startNew: async (name) => {
					calls.startNew.push(name ?? "");
				},
				restore: async (name) => {
					restoreSpy.push(name);
				},
				targets: {
					current: () => stores.targets.activeName() ?? null,
					list: () => stores.targets.list(),
					save: async (name) => {
						calls.targetSaved.push(name ?? "");
					},
					load: async () => {},
					remove: async () => {},
				},
				layouts: { current: () => null, list: () => stores.layouts.list(), save: async () => {}, load: async () => {}, remove: async () => {} },
			},
		};
		return { ctx, messages, calls };
	}

	/** A fake host whose captured listener survives across the async submit. */
	function fakeHost(): { send(data: string): void; rendered(): string[]; prompt: string } {
		let listener: TuiInputListener | null = null;
		let prompt = "";
		installPickerHost({
			addInputListener: (fn) => {
				listener = fn;
				return () => {
					listener = null;
				};
			},
			requestRender: () => {},
			setPromptText: (text) => {
				prompt = text;
			},
		});
		return {
			send: (d) => void listener?.(d),
			rendered: () => (pickerLineSource(50) ?? []).map(plain),
			get prompt() {
				return prompt;
			},
		};
	}

	const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

	it("bare /session opens the picker and fuzzy-picks memleak", async () => {
		installPickerHost(null);
		const host = fakeHost();
		const seed = await seeded();
		const { ctx, messages } = makeReplCtx(seed);
		await handleReplInput("/session", ctx);
		assert.ok(pickerActive());
		assert.ok(host.rendered().some((line) => line.includes("bug1")));
		assert.ok(host.rendered().some((line) => line.includes("memleak")));

		host.send("m");
		host.send("e");
		const lines = host.rendered().join("\n");
		assert.ok(lines.includes("memleak"));
		assert.ok(!lines.includes("bug1"));

		host.send("\r");
		assert.ok(!pickerActive());
		assert.deepEqual(seed.restoreSpy, ["memleak"]);
		assert.ok(messages.some((m) => m.includes("›") && m.includes("/session memleak")));
	});

	it("bare /session switch opens the same picker with its flattened echo", async () => {
		installPickerHost(null);
		const host = fakeHost();
		const seed = await seeded();
		const { ctx, messages } = makeReplCtx(seed);
		await handleReplInput("/session switch", ctx);
		assert.ok(pickerActive());
		host.send("bu");
		host.send("\r");
		assert.ok(!pickerActive());
		assert.deepEqual(seed.restoreSpy, ["bug1"]);
		assert.ok(messages.some((m) => m.includes("/session bug1")));
	});

	it("Esc cancels from the pane picker without side effects", async () => {
		installPickerHost(null);
		const host = fakeHost();
		const seed = await seeded();
		const { ctx } = makeReplCtx(seed);
		await handleReplInput("/win vsplit live", ctx);
		await handleReplInput("/win switch", ctx);
		assert.ok(pickerActive());
		host.send("\x1b");
		assert.ok(!pickerActive());
		assert.deepEqual(seed.restoreSpy, []);
	});

	it("bare /session opens the picker; a new name + Enter saves the current state", async () => {
		installPickerHost(null);
		const host = fakeHost();
		const seed = await seeded();
		const { ctx, messages, calls } = makeReplCtx(seed);
		await handleReplInput("/session", ctx);
		assert.ok(pickerActive());
		assert.ok(host.rendered().some((line) => line.includes("bug1")));

		// "fr" matches no saved session → the create/save row is auto-selected.
		host.send("f");
		host.send("r");
		assert.ok(host.rendered().join("\n").includes('save current session "fr"'));
		host.send("\r");
		assert.ok(!pickerActive());
		assert.deepEqual(calls.saved, ["fr"]);
		assert.ok(messages.some((m) => m.includes("›") && m.includes("/session save fr")));
	});

	it("bare /session deletes via ctrl+d then Enter", async () => {
		installPickerHost(null);
		const host = fakeHost();
		const seed = await seeded();
		const { ctx, messages, calls } = makeReplCtx(seed);
		await handleReplInput("/session", ctx);
		assert.ok(pickerActive());
		// First item (bug1) is selected by default.
		host.send("\x04");
		assert.ok(host.rendered().join("\n").includes('delete "bug1"?'));
		host.send("\r");
		assert.ok(!pickerActive());
		assert.deepEqual(calls.removed, ["bug1"]);
		assert.ok(messages.some((m) => m.includes("›") && m.includes("/session delete bug1")));
	});

	it("bare /target opens the picker; with a live target a new name creates a profile", async () => {
		installPickerHost(null);
		const host = fakeHost();
		const seed = await seeded();
		const { ctx, messages, calls } = makeReplCtx(seed);
		setLastLaunch({ program: "/bin/ls", args: [] });
		try {
			await handleReplInput("/target", ctx);
			assert.ok(pickerActive());
			assert.ok(host.rendered().some((line) => line.includes("game")));

			// "myprog" matches no saved target → the save row is auto-selected.
			for (const ch of "myprog") host.send(ch);
			assert.ok(host.rendered().join("\n").includes('save current target "myprog"'));
			host.send("\r");
			assert.ok(!pickerActive());
			assert.deepEqual(calls.targetSaved, ["myprog"]);
			assert.ok(messages.some((m) => m.includes("›") && m.includes("/target save myprog")));
		} finally {
			setLastLaunch(null);
		}
	});

	describe("`>` opens the combined finder", () => {
		it("a pasted `> mem` opens the finder pre-narrowed and picks on Enter", async () => {
			installPickerHost(null);
			const host = fakeHost();
			const seed = await seeded();
			const { ctx, messages } = makeReplCtx(seed);
			await handleReplInput("> mem", ctx);
			assert.ok(pickerActive(), "leading `>` routes to the finder, not gdb");
			assert.equal(host.prompt, "> mem", "the text after `>` seeds the prompt");
			const lines = host.rendered().join("\n");
			assert.ok(lines.includes("memleak"));
			assert.ok(!lines.includes("bug1"));
			assert.ok(!messages.some((m) => /error/i.test(m)), "no gdb passthrough error for the `>` line");

			host.send("\r");
			assert.ok(!pickerActive());
			assert.deepEqual(seed.restoreSpy, ["memleak"], "Enter restores the right session");
			assert.ok(messages.some((m) => m.includes("›") && m.includes("/open memleak")));
		});

		it("bare `>` opens the finder with an empty prompt", async () => {
			installPickerHost(null);
			const host = fakeHost();
			const seed = await seeded();
			const { ctx } = makeReplCtx(seed);
			await handleReplInput(">", ctx);
			assert.ok(pickerActive());
			assert.equal(host.prompt, "> ", "an empty seed is just the `>` prompt");
			host.send("bu");
			host.send("\r");
			assert.ok(!pickerActive());
			assert.deepEqual(seed.restoreSpy, ["bug1"]);
		});

		it("Esc on a seeded finder restores the empty prompt", async () => {
			installPickerHost(null);
			const host = fakeHost();
			const seed = await seeded();
			const { ctx } = makeReplCtx(seed);
			await handleReplInput("> mem", ctx);
			assert.ok(pickerActive());
			host.send("\x1b");
			assert.ok(!pickerActive());
			assert.equal(host.prompt, "", "cancel clears the seeded prompt too");
			assert.deepEqual(seed.restoreSpy, []);
		});
	});
});