/**
 * Overlay-hosted autocomplete dropdown.
 *
 * pi-tui's Editor renders its suggestion list INLINE below the prompt
 * (components/editor.js appends `autocompleteList.render()` lines). In a
 * main-screen TUI whose document already fills the terminal, opening the
 * dropdown scrolls the screen and dismissing it leaves a permanent blank gap
 * at the bottom — the scrolled-in rows never come back.
 *
 * Fix, in pi's own spirit (see TuiBase.showOverlay): keep the Editor's entire
 * autocomplete machinery (triggering, keys, applyCompletion) but relocate the
 * rendered list into an overlay that composites ON TOP of the document. The
 * document height never changes, so nothing is pushed and no gap is left.
 *
 * Upstream coupling: the inline block is stripped by reading two TS-private
 * runtime fields of Editor (`autocompleteState`, `autocompleteList`). All
 * access funnels through `internalsOf` with an exact-output check — if a
 * future pi-tui changes shape, we degrade to stock inline rendering instead
 * of mangling output.
 */

import {
	type Component,
	type EditorTheme,
	Editor,
	getKeybindings,
	type OverlayOptions,
	type SizeValue,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** The pieces of Editor's autocomplete state the stripper needs. */
interface EditorInternals {
	autocompleteState(): unknown;
	autocompleteList(): { render(width: number): string[] } | undefined;
	paddingX(): number;
}

const internalsCache = new WeakMap<Editor, EditorInternals>();

function internalsOf(editor: Editor): EditorInternals | null {
	const cached = internalsCache.get(editor);
	if (cached) return cached;
	const record = editor as unknown as Record<string, unknown>;
	if (!("autocompleteState" in record)) return null;
	const internals: EditorInternals = {
		autocompleteState: () => record.autocompleteState,
		autocompleteList: () => record.autocompleteList as { render(width: number): string[] } | undefined,
		paddingX: () => (typeof record.paddingX === "number" ? record.paddingX : 0),
	};
	internalsCache.set(editor, internals);
	return internals;
}

/**
 * Editor whose active suggestion list is removed from its own render output
 * and exposed via `dropdownLines` for an overlay to draw instead. Everything
 * else (triggering, key handling, completion application) is stock Editor:
 * the editor keeps keyboard focus; the overlay is display-only.
 */
export class AidbEditor extends Editor {
	private internals: EditorInternals | null | undefined;

	/** Suggestion lines stripped out of the last render, or null when inactive. */
	dropdownLines: readonly string[] | null = null;

	/** Rows the editor itself occupied in the last render (dropdown excluded). */
	lastHeight = 3;

	/**
	 * Seed the up/down history from a persisted file.
	 * The file stores most-recent-first (matching `Editor.history`, where
	 * index 0 is newest), so entries are appended in that order.
	 */
	loadHistory(entries: readonly string[]): void {
		const rec = this as unknown as Record<string, unknown>;
		if (!Array.isArray(rec.history)) return;
		rec.history.push(
			...entries.filter((x): x is string => typeof x === "string" && x.trim().length > 0),
		);
	}

	/**
	 * Make Enter submit a slash command in one press even when an argument
	 * autocomplete dropdown is open.
	 *
	 * pi-tui's Editor only treats completions whose `autocompletePrefix` starts
	 * with "/" as "apply, then fall through to submit" (Enter). Our
	 * position-aware argument completion returns the bare token as the prefix
	 * (so highlighting and token replacement stay correct), which upstream
	 * classifies as a non-slash completion: pressing Enter applies the
	 * suggestion but leaves the prompt open — forcing a second Enter to run the
	 * command. Here we detect that "applied but not submitted" result and
	 * submit it ourselves after the stock handler runs.
	 *
	 * The post-check requires the line to STILL start with a slash: a bare
	 * picker command (`/session`, `/open`, …) submits, and the fuzzy finder
	 * synchronously rewrites the prompt to `> <query>` — which is non-empty
	 * but not a slash command. Without this guard, the rewritten prompt would
	 * be mistaken for an un-submitted completion and submitted again.
	 */
	override handleInput(data: string): void {
		const autocompleteShown = this.isShowingAutocomplete();
		const isSlashConfirm =
			autocompleteShown &&
			this.getText().trimStart().startsWith("/") &&
			getKeybindings().matches(data, "tui.select.confirm");

		super.handleInput(data);

		// Upstream applied the argument completion and kept the prompt open
		// (a line still starting with a slash) instead of submitting. Run the
		// command now.
		if (isSlashConfirm && !this.isShowingAutocomplete() && this.getText().trimStart().startsWith("/")) {
			this.submitForSlash();
		}
	}

	/** Clean up an argument-completed slash command by submitting it. */
	private submitForSlash(): void {
		const rec = this as unknown as { submitValue?: () => void };
		if (typeof rec.submitValue === "function") rec.submitValue();
	}

	render(width: number): string[] {
		const result = super.render(width);
		this.internals ??= internalsOf(this);
		const intern = this.internals;
		const inactive = (): void => {
			this.dropdownLines = null;
			this.lastHeight = result.length;
		};
		if (!intern || intern.autocompleteState() === null || !intern.autocompleteList()) {
			inactive();
			return result;
		}
		// Mirror Editor.render's width bookkeeping exactly so the recomputed
		// block matches what stock would have appended.
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(intern.paddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;
		const expected = intern.autocompleteList()!.render(contentWidth).map((line) => {
			const lineWidth = visibleWidth(line);
			const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
			return `${leftPadding}${line}${linePadding}${rightPadding}`;
		});
		const start = result.length - expected.length;
		const tail = start >= 0 ? result.slice(start) : [];
		const matches = tail.length === expected.length && tail.every((line, i) => line === expected[i]);
		if (!matches) {
			inactive(); // upstream layout changed; fall back to inline rendering
			return result;
		}
		this.dropdownLines = expected;
		this.lastHeight = start;
		return result.slice(0, start);
	}
}

/**
 * A source of overlay lines, evaluated every composite pass. Returns a
 * non-empty list to show, or null/[] to contribute nothing that frame.
 * Receives the resolved overlay width so sources like the fuzzy picker can
 * truncate to the actual band width.
 */
export type OverlayLineSource = (width: number) => readonly string[] | null;

export interface DropdownOverlayOptions {
	/** Rows between the overlay's bottom edge and the editor's bottom border (e.g. status bar). */
	rowsBelow?: () => number;
	/** Cap on dropdown height, as pi-tui SizeValue. */
	maxHeight?: SizeValue;
	/**
	 * Extra line sources composited before the editor's own dropdown (first
	 * non-empty wins). Lets another popup — e.g. the fuzzy picker — ride the
	 * SAME overlay + geometry as the slash dropdown instead of opening a
	 * second one, so width and live `offsetY` are identical by construction.
	 * Read live each pass, so sources can be registered/unregistered.
	 */
	sources?: OverlayLineSource[];
}

export interface DropdownOverlayHandle {
	/** The live options object; `offsetY` is recomputed on every render pass. */
	readonly options: OverlayOptions;
}

/** The shared band's own source: the editor's stashed dropdown (last in priority). */
function editorDropdownSource(editor: AidbEditor): OverlayLineSource {
	return (_width: number) => {
		const lines = editor.dropdownLines;
		return lines && lines.length > 0 ? [...lines] : null;
	};
}

/**
 * Host a line source (the slash dropdown, plus anything routed through it —
 * the fuzzy picker) in a non-capturing overlay docked directly above the
 * prompt. The editor keeps keyboard focus; the overlay entry stays mounted
 * for the app's lifetime and simply renders nothing while every source is
 * silent. Because compositeOverlays runs after the base render pass,
 * freshly-produced lines composite in the same frame they arrive, and
 * geometry (offsetY) is recomputed every pass.
 */
export function attachDropdownOverlay(
	tui: TUI,
	editor: AidbEditor,
	options: DropdownOverlayOptions = {},
): DropdownOverlayHandle {
	const rowsBelow = options.rowsBelow ?? (() => 0);
	const overlayOptions: OverlayOptions = {
		anchor: "bottom-center",
		width: "100%",
		maxHeight: options.maxHeight ?? "50%",
		nonCapturing: true,
		offsetY: -(rowsBelow() + editor.lastHeight),
	};

	const component: Component = {
		invalidate(): void {},
		render(width: number): string[] {
			// Read fresh every composite pass; resolveOverlayLayout re-runs after
			// this returns, so the mutated offset applies to this very frame.
			overlayOptions.offsetY = -(rowsBelow() + editor.lastHeight);
			// Custom sources first (first non-empty wins), then the editor's own
			// dropdown. `sources` is read live so callers can register/unregister.
			for (const source of options.sources ?? []) {
				const lines = source(width);
				if (lines && lines.length > 0) return [...lines];
			}
			return [...(editorDropdownSource(editor)(width) ?? [])];
		},
	};

	tui.showOverlay(component, overlayOptions);

	return { options: overlayOptions };
}
