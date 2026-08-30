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
	/** The caret column within the prompt text (readline ctrl+a/e/b/f moves it). */
	get caret(): number;
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
	let caret = 0;
	const state: Harness = {
		created: [],
		deleted: [],
		get prompt() {
			return prompt;
		},
		get caret() {
			return caret;
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
		setPromptCaret: (col) => {
			caret = col;
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

	it("matches the `search` override, not the decorated label (a group tag can't fake-match)", () => {
		installPickerHost(null);
		// /open's shape: the label wears a muted group tag, the search text is
		// the raw name (item.search). The tag "target" contains an 'e', so an
		// 'e' query must NOT keep 'foo' via the tag — only names with an 'e'
		// survive.
		const items: PickerItem[] = [
			{ value: "example", label: "\x1b[90msession\x1b[0m  example", search: "example" },
			{ value: "example2", label: "\x1b[90msession\x1b[0m  example2", search: "example2" },
			{ value: "foo", label: "\x1b[90mtarget\x1b[0m  foo", search: "foo" },
		];
		const h = harness(items);
		h.send("e");
		const lines = h.rendered().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		assert.ok(lines[0]!.includes("example"), "word-boundary name match ranks the examples first");
		assert.ok(lines.join("\n").includes("example2"), "both 'example' rows survive — 'e' is in the name");
		assert.ok(!lines.join("\n").includes("foo"), "'foo' is gone — the 'e' in the 'target' tag must not match");
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

	it("a kitty press+release pair steps once: the release parses as 'down' too", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		// Kitty protocol (flag 2) sends a release sequence after every press;
		// both parse to the same key id and must act as ONE step.
		h.send("\x1b[1;1B"); // down press
		h.send("\x1b[1;1:3B"); // down release
		h.send(ENTER);
		assert.equal(h.picked?.value, "memleak", "one physical ↓ lands on the second item");
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
const CTRL_U = "\x15";
const CTRL_K = "\x0b";
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const CTRL_B = "\x02";
const CTRL_F = "\x06";
const CTRL_W = "\x17";
const CTRL_Y = "\x19";
const HOME = "\x1b[H";
const END = "\x1b[F";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DELETE = "\x1b[3~";

/* --------------------------------------------- filter editing shortcuts ---- */

describe("openPicker filter editing", () => {
	it("ctrl+u clears the whole query at once (kill-to-line-start)", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("b");
		h.send("u");
		assert.equal(h.prompt, "> bu");
		h.send(CTRL_U);
		assert.equal(h.prompt, "> ", "ctrl+u empties the query");
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes("bug1"), "the list re-narrows back to every item");
		assert.ok(pickerActive(), "ctrl+u does not close the finder");
	});

	it("ctrl+u on an empty query is a no-op that keeps the finder open", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send(CTRL_U);
		assert.ok(pickerActive());
		assert.equal(h.prompt, "> ");
	});

	it("ctrl+u un-blocks a seed filter exactly like repeated backspaces", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { initialFilter: "memleak" });
		h.send(CTRL_U);
		assert.equal(h.prompt, "> ");
		assert.ok(h.rendered().join("\n").includes("bug1"), "the full collection is back");
	});

	it("ctrl+a / home move the caret to the front; ctrl+e / end to the back", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("m");
		h.send("e");
		assert.equal(h.caret, 4, "caret sits after `> ` + the query");
		h.send(CTRL_A);
		assert.equal(h.caret, 2, "ctrl+a jumps to the front (after the `> ` prefix)");
		h.send(CTRL_E);
		assert.equal(h.caret, 4, "ctrl+e jumps back to the end");
		h.send(HOME);
		assert.equal(h.caret, 2, "home does the same as ctrl+a");
		h.send(END);
		assert.equal(h.caret, 4, "end does the same as ctrl+e");
		h.send(ENTER);
		assert.equal(h.picked?.value, "memleak", "still picks after the caret moves");
	});

	it("typing after ctrl+a inserts at the front of the query", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("m");
		h.send("e");
		h.send(CTRL_A);
		h.send("x");
		assert.equal(h.prompt, "> xme", "the char lands before the existing text");
		assert.equal(h.caret, 3);
	});

	it("ctrl+b / left and ctrl+f / right move the caret by one char", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("m");
		h.send("e");
		h.send(CTRL_B);
		assert.equal(h.caret, 3, "ctrl+b steps back from the end");
		h.send(CTRL_F);
		assert.equal(h.caret, 4, "ctrl+f steps forward again");
		h.send(LEFT);
		assert.equal(h.caret, 3, "left arrow matches ctrl+b");
		h.send(RIGHT);
		assert.equal(h.caret, 4, "right arrow matches ctrl+f");
		h.send(CTRL_B); // no-op at the front
		h.send(CTRL_A);
		h.send(CTRL_B);
		assert.equal(h.caret, 2, "ctrl+b at the front is a no-op");
	});

	it("backspace deletes before the caret, Delete/ctrl+d delete after it", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("a");
		h.send("b");
		assert.equal(h.prompt, "> ab");
		h.send(CTRL_B); // caret between a and b
		h.send(DELETE);
		assert.equal(h.prompt, "> a", "Delete removes the char under the caret");
		h.send(CTRL_B);
		h.send(CTRL_D);
		assert.equal(h.prompt, "> ", "ctrl+d removes the char under the caret too");
	});

	it("ctrl+d at the end of the query still means item-delete, not forward-delete", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { createLabel: () => "x", delete: true });
		h.send("b");
		h.send("u");
		h.send("g");
		h.send("1");
		h.send(CTRL_D); // caret at the tail: item-delete confirm
		assert.ok(h.rendered().join("\n").includes('delete "'));
		h.send("\x1b"); // Esc backs out
		h.send(CTRL_A);
		h.send(CTRL_D); // caret mid-query: forward-delete
		assert.equal(h.prompt, "> ug1", "mid-query ctrl+d is a character delete, not item-delete");
	});

	it("ctrl+w kills the word before the caret (from the front it is a no-op)", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("a");
		h.send("-");
		h.send("b");
		// `a-b`: caret after 'b'; ctrl+w at the end kills '-b' (word + separator).
		h.send(CTRL_W);
		assert.equal(h.prompt, "> a", "first ctrl+w kills the last word and its separator");
		h.send(CTRL_W);
		assert.equal(h.prompt, "> ", "second ctrl+w kills the remaining word");
		h.send("x");
		h.send(CTRL_A);
		h.send(CTRL_W);
		assert.equal(h.prompt, "> x", "ctrl+w at the front is a no-op");
	});

	it("ctrl+k from mid-line kills to the line end (readline parity)", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("a");
		h.send("b");
		h.send(CTRL_B);
		h.send(CTRL_K);
		assert.equal(h.prompt, "> a", "ctrl+k deletes from the caret to the end");
		h.send(CTRL_U);
		assert.equal(h.prompt, "> ", "ctrl+u deletes from the start to the caret");
	});

	it("ctrl+y yanks the last kill back at the caret", () => {
		installPickerHost(null);
		const h = harness(SESSIONS);
		h.send("a");
		h.send("b");
		h.send(CTRL_U); // kill "ab"
		assert.equal(h.prompt, "> ");
		h.send("x");
		h.send(CTRL_A);
		h.send(CTRL_Y);
		assert.equal(h.prompt, "> abx", "ctrl+y pastes the killed text at the caret");
	});

	it("word moves: alt+b jumps to the previous word start, alt+f to the next end", () => {
		installPickerHost(null);
		const h = harness(SESSIONS, { initialFilter: "a b c" });
		assert.equal(h.caret, 7, "seeded filter puts the caret at the end");
		h.send("\x1bb"); // alt+b — back over 'c'
		assert.equal(h.caret, 6, "alt+b lands at the start of 'c' (prompt columns)");
		h.send("\x1bb");
		assert.equal(h.caret, 4, "alt+b again lands at the start of 'b'");
		h.send("\x1bf"); // alt+f
		assert.equal(h.caret, 5, "alt+f lands at the end of 'b'");
	});
});


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

	it("a fuzzy-similar new name selects the create row: Enter saves, not loads", () => {
		installPickerHost(null);
		// The reported trap: saved "iasm", filter "asm" — subsequence-fuzzy but
		// NOT a prefix. Create intent wins: the + create row is auto-selected.
		const h = harness([{ value: "iasm", label: "iasm" }], { createLabel: (q) => `save current layout "${q}"` });
		for (const ch of "asm") h.send(ch);
		const lines = h.rendered().join("\n");
		assert.ok(lines.includes("iasm"), "the fuzzy lookalike stays visible (one ↓ away)");
		assert.ok(lines.includes('save current layout "asm"'), "the save row is in the band");
		h.send(ENTER);
		assert.deepEqual(h.created, ["asm"], "Enter creates 'asm' — it must NOT load/pick iasm");
		assert.equal(h.picked, null);
		assert.ok(!pickerActive());
	});

	it("a prefix filter stays in browse mode: Enter loads the existing name", () => {
		installPickerHost(null);
		// "ias" is a prefix of "iasm" — steering toward the saved name, so the
		// existing row keeps the selection and Enter loads it (unchanged).
		const h = harness([{ value: "iasm", label: "iasm" }], { createLabel: (q) => `save current layout "${q}"` });
		for (const ch of "ias") h.send(ch);
		h.send(ENTER);
		assert.equal(h.picked?.value, "iasm");
		assert.deepEqual(h.created, []);
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

		it("> e narrows by NAME across collections (the two 'example' rows; tags don't fake-match)", async () => {
			installPickerHost(null);
			const host = fakeHost();
			// The exact report: a session and a target both named "example", plus
			// names with no 'e' whose GROUP TAG ('session'/'target') does contain
			// one — the tag's 'e' must not keep them on screen.
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidb-picker-"));
			const stores = createStores(path.join(dir, "sessions"));
			await stores.targets.save({ schemaVersion: TARGET_SCHEMA_VERSION, name: "example", kind: "launch", program: "./example", args: [], savedAt: Date.now() });
			await stores.targets.save({ schemaVersion: TARGET_SCHEMA_VERSION, name: "zzz", kind: "launch", program: "./zzz", args: [], savedAt: Date.now() });
			await stores.layouts.save({ schemaVersion: LAYOUT_SCHEMA_VERSION, name: "code-watch", splitTree: { root: "repl", active: "repl" }, watchPanes: {}, savedAt: Date.now() });
			await stores.sessions.save({ schemaVersion: SESSION_SCHEMA_VERSION, name: "example", target: "example", layout: "code-watch", breakPoints: [], savedAt: Date.now() });
			await stores.sessions.save({ schemaVersion: SESSION_SCHEMA_VERSION, name: "zzz", target: "example", layout: "code-watch", breakPoints: [], savedAt: Date.now() });
			const { ctx } = makeReplCtx({ stores, restoreSpy: [] });
			await handleReplInput("> e", ctx);
			assert.ok(pickerActive());
			const lines = host.rendered().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
			assert.equal(lines.filter((l) => l.includes("example")).length, 2, "both 'example' rows surface (session + target)");
			assert.ok(lines[0]!.includes("example"), "name matches rank first");
			assert.ok(!lines.join("\n").includes("zzz"), "'zzz' has no 'e' — neither its name nor its 'target'/'session' tag matches");
			host.send("\r");
			assert.ok(!pickerActive());
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