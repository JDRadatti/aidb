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

export interface DropdownOverlayOptions {
	/** Rows between the overlay's bottom edge and the editor's bottom border (e.g. status bar). */
	rowsBelow?: () => number;
	/** Cap on dropdown height, as pi-tui SizeValue. */
	maxHeight?: SizeValue;
}

export interface DropdownOverlayHandle {
	/** The live options object; `offsetY` is recomputed on every render pass. */
	readonly options: OverlayOptions;
}

/**
 * Host `editor.dropdownLines` in a non-capturing overlay docked directly
 * above the prompt. The editor keeps keyboard focus; the overlay entry stays
 * mounted for the app's lifetime and simply renders nothing while there are
 * no suggestions. Because compositeOverlays runs after the base render pass,
 * freshly-stashed lines composite in the same frame they arrive, and geometry
 * (offsetY) is recomputed every pass.
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
		render(_width: number): string[] {
			// Read fresh every composite pass; resolveOverlayLayout re-runs after
			// this returns, so the mutated offset applies to this very frame.
			overlayOptions.offsetY = -(rowsBelow() + editor.lastHeight);
			const lines = editor.dropdownLines;
			return lines && lines.length > 0 ? [...lines] : [];
		},
	};

	tui.showOverlay(component, overlayOptions);

	return { options: overlayOptions };
}
