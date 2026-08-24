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
import { AidbEditor, attachDropdownOverlay } from "../src/completion-overlay.ts";
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
});

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
