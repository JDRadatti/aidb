import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AutocompleteItem,
	type Component,
	Container,
	Editor,
	type OverlayOptions,
	Text,
	TuiMainScreen,
	type TUI,
} from "@earendil-works/pi-tui";
import { AidbEditor, attachDropdownOverlay, type OverlayLineSource } from "../src/completion-overlay.ts";
import { createEditorTheme } from "../src/theme.ts";

const WIDTH = 100;
const ITEMS: AutocompleteItem[] = [
	{ value: "win", label: "win", description: "pane management" },
	{ value: "watch", label: "watch", description: "pin an expression" },
];

function fakeProvider() {
	return {
		getSuggestions: () => Promise.resolve({ items: ITEMS, prefix: "/" }),
		applyCompletion: (lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 }),
	};
}

interface OverlayEntry {
	component: Component;
	options: OverlayOptions;
	hidden: boolean;
}

function stubTui(rows = 24): { tui: TUI; entries: OverlayEntry[] } {
	const entries: OverlayEntry[] = [];
	const tui = {
		terminal: { rows },
		requestRender(): void {},
		showOverlay(component: Component, options?: OverlayOptions) {
			const entry: OverlayEntry = { component, options: options ?? {}, hidden: false };
			entries.push(entry);
			return {
				hide: () => {},
				setHidden: (hidden: boolean) => {
					entry.hidden = hidden;
				},
				isHidden: () => entry.hidden,
				focus: () => {},
				unfocus: () => {},
				isFocused: () => false,
			};
		},
	};
	return { tui: tui as unknown as TUI, entries };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

/** Drive a slash-command suggestion into `editor` and return its render. */
async function activateAndRender(editor: Editor, stub: { tui: TUI }): Promise<string[]> {
	editor.setAutocompleteProvider(fakeProvider());
	editor.handleInput("/");
	await settle();
	return editor.render(WIDTH);
}

describe("AidbEditor", () => {
	it("strips the active suggestion list out of its own render output", async () => {
		const { tui } = stubTui();
		const aidb = new AidbEditor(tui, createEditorTheme());
		const lines = await activateAndRender(aidb, { tui });

		assert.ok(aidb.dropdownLines, "dropdownLines should be stashed while suggestions are active");
		const joined = aidb.dropdownLines.join("\n");
		assert.ok(joined.includes("win"), "stashed lines contain the suggestion");
		assert.ok(joined.includes("pane management"), "stashed lines contain the description");
		for (const line of lines) {
			assert.ok(!line.includes("pane management"), "render output must not contain the dropdown");
		}
	});

	it("renders exactly like stock Editor minus the stashed dropdown tail", async () => {
		const { tui } = stubTui();
		const aidb = new AidbEditor(tui, createEditorTheme());
		const stock = new Editor(tui, createEditorTheme());

		const aidbLines = await activateAndRender(aidb, { tui });
		stock.setAutocompleteProvider(fakeProvider());
		stock.handleInput("/");
		await settle();
		const stockLines = stock.render(WIDTH);

		assert.ok(aidb.dropdownLines);
		assert.deepEqual([...aidbLines, ...aidb.dropdownLines], stockLines);
	});

	it("a single Enter applies an argument completion and submits the slash command", async () => {
		const { tui } = stubTui();
		const aidb = new AidbEditor(tui, createEditorTheme());

		let submitted: string | undefined;
		aidb.onSubmit = (text) => {
			submitted = text;
		};

		// Argument completion: the prefix is the bare token ("list"), which
		// upstream classifies as a non-slash completion and would normally leave
		// the prompt open after applying it.
		aidb.setAutocompleteProvider({
			getSuggestions: () =>
				Promise.resolve({
					// Two items so Tab shows a dropdown instead of auto-applying the
					// single match; the exact "list" is what gets highlighted.
					items: [
						{ value: "list", label: "list" },
						{ value: "listicle", label: "listicle" },
					],
					prefix: "list",
				}),
			applyCompletion: (lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) => {
				const line = lines[cursorLine]!;
				const before = line.slice(0, cursorCol - prefix.length);
				const after = line.slice(cursorCol);
				const result = [...lines];
				result[cursorLine] = before + item.value + after;
				return {
					lines: result,
					cursorLine,
					cursorCol: before.length + item.value.length,
				};
			},
		});

		aidb.setText("/win list");
		aidb.handleInput("\t"); // open the argument dropdown over the typed token
		await settle();
		assert.ok(aidb.isShowingAutocomplete(), "argument dropdown is showing");

		aidb.handleInput("\r"); // one Enter
		await settle();

		assert.equal(submitted, "/win list", "single Enter applies + submits");
		assert.ok(aidb.isShowingAutocomplete() === false, "dropdown closed");
	});

	it("does not re-submit the fuzzy-picker prompt after a bare picker command submits", async () => {
		const { tui } = stubTui();
		const aidb = new AidbEditor(tui, createEditorTheme());

		const submitted: string[] = [];
		aidb.onSubmit = (text) => {
			submitted.push(text);
			// Mimic main.ts submit(): a bare picker command opens the fuzzy
			// finder, which synchronously rewrites the prompt to `> `.
			if (text === "/session") aidb.setText("> ");
		};

		aidb.setAutocompleteProvider({
			getSuggestions: () =>
				Promise.resolve({
					items: [{ value: "session", label: "session" }],
					prefix: "/",
				}),
			applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({
				lines,
				cursorLine,
				cursorCol,
			}),
		});

		for (const ch of "/session") aidb.handleInput(ch);
		await settle();
		assert.ok(aidb.isShowingAutocomplete(), "slash dropdown is showing while typing");

		aidb.handleInput("\r"); // one Enter: submit /session, picker takes over the prompt
		await settle();

		assert.deepEqual(submitted, ["/session"], "the `> ` prompt must not be submitted as a command");
		assert.equal(aidb.getText(), "> ", "the picker prompt text survives (visually only)");
	});

	it("returns to stock output once the dropdown closes", async () => {
		const { tui } = stubTui();
		const aidb = new AidbEditor(tui, createEditorTheme());
		const stock = new Editor(tui, createEditorTheme());

		await activateAndRender(aidb, { tui });
		stock.setAutocompleteProvider(fakeProvider());
		stock.handleInput("/");
		await settle();

		aidb.handleInput("\x1b"); // escape cancels the autocomplete
		stock.handleInput("\x1b");

		const aidbLines = aidb.render(WIDTH);
		const stockLines = stock.render(WIDTH);
		assert.equal(aidb.dropdownLines, null);
		assert.deepEqual(aidbLines, stockLines);
	});
});

describe("attachDropdownOverlay", () => {
	it("renders the dropdown above the prompt via a non-capturing overlay", async () => {
		const { tui, entries } = stubTui();
		const editor = new AidbEditor(tui, createEditorTheme());
		const rowsBelow = 5;
		const overlay = attachDropdownOverlay(tui, editor, { rowsBelow: () => rowsBelow });

		assert.equal(entries.length, 1);
		const entry = entries[0];
		assert.equal(entry.options.anchor, "bottom-center");
		assert.equal(entry.options.nonCapturing, true);
		assert.equal(entry.options.width, "100%");
		assert.deepEqual(entry.component.render(WIDTH), [], "no suggestions -> renders nothing");

		await activateAndRender(editor, { tui });
		assert.deepEqual(entry.component.render(WIDTH), [...editor.dropdownLines!]);
		assert.equal(overlay.options.offsetY, -(rowsBelow + editor.lastHeight));
	});

	it("renders nothing again once the autocomplete closes", async () => {
		const { tui, entries } = stubTui();
		const editor = new AidbEditor(tui, createEditorTheme());
		attachDropdownOverlay(tui, editor);
		const entry = entries[0];

		await activateAndRender(editor, { tui });
		assert.ok(entry.component.render(WIDTH).length > 0);

		editor.handleInput("\x1b");
		editor.render(WIDTH); // in a real frame the editor renders before the overlay composites
		assert.deepEqual(entry.component.render(WIDTH), []);
	});

	it("docks directly on the editor by default (covering what sits above it)", async () => {
		const { tui, entries } = stubTui();
		const editor = new AidbEditor(tui, createEditorTheme());
		attachDropdownOverlay(tui, editor);
		const entry = entries[0];

		await activateAndRender(editor, { tui });
		entry.component.render(WIDTH);
		assert.equal(entry.options.offsetY, -editor.lastHeight);
	});

	it("composites a custom source (e.g. the fuzzy picker) with the dropdown's geometry", async () => {
		const { tui, entries } = stubTui();
		const editor = new AidbEditor(tui, createEditorTheme());
		const rowsBelow = 4;
		const sources: OverlayLineSource[] = [];
		attachDropdownOverlay(tui, editor, { rowsBelow: () => rowsBelow, sources });
		const entry = entries[0];

		await activateAndRender(editor, { tui }); // editor dropdown is now active
		assert.ok(entry.component.render(WIDTH).length > 0, "editor dropdown shows when no custom source fires");

		// Register the picker source; it wins over the editor's own dropdown and
		// renders through the SAME overlay entry + live offsetY.
		let pickerOpen = true;
		sources.push((width) => (pickerOpen ? pickerBand(width) : null));
		const band = entry.component.render(WIDTH);
		assert.deepEqual(band, pickerBand(WIDTH), "custom source composites in place of the dropdown");
		assert.equal(entry.options.offsetY, -(rowsBelow + editor.lastHeight), "geometry is the dropdown's own");

		// Spent (picker closed): falls back to the editor's dropdown.
		pickerOpen = false;
		assert.deepEqual(entry.component.render(WIDTH), [...editor.dropdownLines!]);
	});
});

/** Stands in for `pickerLineSource`'s output during the overlay unit test. */
function pickerBand(width: number): string[] {
	const item = "→ session ✳  game · code-watch · bp 3 · now";
	return [item.slice(0, Math.max(1, width)), "↑/↓ move · Enter select · Esc cancel"];
}

describe("TuiMainScreen integration", () => {
	/** Full-render line count of the last frame appended to `writes`. */
	function lastFrameLineCount(writes: string[], from: number): number {
		return writes.join("").slice(from).split("\r\n").length;
	}

	async function flush(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 40));
	}

	function screenTui(width = 100, rows = 24): { tui: TuiMainScreen; input(data: string): void; writes: string[] } {
		const writes: string[] = [];
		let onInput: ((data: string) => void) | undefined;
		const terminal = {
			write: (data: string) => writes.push(data),
			start: (input: (data: string) => void) => {
				onInput = input;
			},
			stop: () => {},
			hideCursor: () => {},
			showCursor: () => {},
			get columns() {
				return width;
			},
			get rows() {
				return rows;
			},
		};
		return {
			tui: new TuiMainScreen(terminal as unknown as Terminal),
			input: (data: string) => onInput?.(data),
			writes,
		};
	}

	async function setupScreen(): Promise<{
		tui: TuiMainScreen;
		editor: AidbEditor;
		input(data: string): void;
		writes: string[];
	}> {
		const screen = screenTui();
		const transcript = new Container();
		transcript.addChild(new Text("aidb"));
		// Fill more than one viewport so opening/closing the dropdown has to
		// fight the scrollback the way it does in the real app.
		for (let i = 0; i < 40; i++) transcript.addChild(new Text(`history-${i}`));
		const statusBar = new Text("");
		const editor = new AidbEditor(screen.tui, createEditorTheme());
		editor.setAutocompleteProvider(fakeProvider());
		screen.tui.addChild(transcript);
		screen.tui.addChild(statusBar);
		screen.tui.addChild(editor);
		attachDropdownOverlay(screen.tui, editor, { rowsBelow: () => statusBar.render(100).length });
		screen.tui.setFocus(editor);
		screen.tui.start();
		await flush();

		screen.writes.length = 0;
		screen.tui.requestRender(true);
		await flush();
		return { ...screen, editor };
	}

	it("document height is unchanged while the dropdown is open or after it closes", async () => {
		const { tui, editor, input, writes } = await setupScreen();

		const baselineFrom = writes.join("").length;
		tui.requestRender(true);
		await flush();
		const baselineLines = lastFrameLineCount(writes, baselineFrom);

		input("/");
		await settle();

		const openFrom = writes.join("").length;
		tui.requestRender(true);
		await flush();
		const openFrame = writes.join("").slice(openFrom);
		const openLines = lastFrameLineCount(writes, openFrom);
		assert.ok(openFrame.includes("pane management"), "dropdown composited into the frame");
		assert.equal(openLines, baselineLines, "opening the dropdown does not grow the document");

		input("\x1b");
		await settle();

		const closedFrom = writes.join("").length;
		tui.requestRender(true);
		await flush();
		const closedFrame = writes.join("").slice(closedFrom);
		const closedLines = lastFrameLineCount(writes, closedFrom);
		assert.ok(!closedFrame.includes("pane management"), "dropdown gone after close");
		assert.equal(closedLines, baselineLines, "no gap rows remain after the dropdown closes");
		assert.ok(editor.isShowingAutocomplete() === false);
	});
});
