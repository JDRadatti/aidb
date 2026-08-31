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
	type EditorOptions,
	type EditorTheme,
	Editor,
	getKeybindings,
	type OverlayOptions,
	type SizeValue,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { colors } from "./theme.ts";
import type { PromptZone } from "./config.ts";
import { pickerActive } from "./picker.ts";

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

	/** Zone-frame level ("off" = stock). The rail + top-line logic live here. */
	promptZone: PromptZone = "off";

	/** Suggestion lines stripped out of the last render, or null when inactive. */
	dropdownLines: readonly string[] | null = null;

	/** Rows the editor itself occupied in the last render (dropdown excluded). */
	lastHeight = 3;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}, promptZone: PromptZone = "off") {
		super(tui, theme, options);
		this.promptZone = promptZone;
	}
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

	/** Drop the recall history entirely — `/new` starts a fresh session with no past. */
	clearHistory(): void {
		const rec = this as unknown as Record<string, unknown>;
		// Mutate in place: Editor.history is a plain array field, but a reassign
		// would break if a future pi-tui exposes it through a getter.
		if (Array.isArray(rec.history)) rec.history.length = 0;
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
		const kb = getKeybindings();
		const autocompleteShown = this.isShowingAutocomplete();
		const isSlashConfirm =
			autocompleteShown &&
			this.getText().trimStart().startsWith("/") &&
			kb.matches(data, "tui.select.confirm");
		// gdb convention: recalling a previous command should land the cursor at
		// the END (so you can edit the tail), but pi-tui's historyPrevious
		// navigation parks it at the START. Both routes there — ctrl+p bound to
		// `tui.editor.historyPrevious`, and ArrowUp - `cursorUp` - from the first
		// line — are detected via the resolved keys, so remaps stay covered.
		const recallsPrevious =
			kb.matches(data, "tui.editor.historyPrevious") || kb.matches(data, "tui.editor.cursorUp");

		// Line-level deletes (ctrl+u / ctrl+k etc.) can leave an empty or
		// irrelevant prompt with a stale list still composited above; upstream
		// never re-requests for these, so spot-drop the dropdown afterwards.
		const lineClearingDelete =
			kb.matches(data, "tui.editor.deleteToLineStart") || kb.matches(data, "tui.editor.deleteToLineEnd");

		super.handleInput(data);

		if (lineClearingDelete && this.isShowingAutocomplete() && !this.autocompleteStillRelevant()) {
			this.cancelAutocompleteForInput();
		}

		// Upstream applied the argument completion and kept the prompt open
		// (a line still starting with a slash) instead of submitting. Run the
		// command now.
		if (isSlashConfirm && !this.isShowingAutocomplete() && this.getText().trimStart().startsWith("/")) {
			this.submitForSlash();
		}

		if (recallsPrevious) this.moveCursorToEndAfterRecall();
	}

	/**
	 * Upstream `navigateHistory(-1)` leaves the cursor at column 0 of the
	 * recalled line. Re-place it at the end — but only when history browsing
	 * actually started (historyIndex >= 0): a plain cursor-up inside the
	 * current line must not jump. Reads the TS-private internals with the same
	 * shape-probe used by the dropdown stripper, so an upstream reshuffle
	 * degrades to stock behavior.
	 */
	private moveCursorToEndAfterRecall(): void {
		const rec = this as unknown as Record<string, unknown>;
		if (typeof rec.historyIndex !== "number" || (rec.historyIndex as number) < 0) return;
		const setTextInternal = rec.setTextInternal;
		if (typeof setTextInternal !== "function") return;
		(setTextInternal as (text: string, placement?: "start" | "end") => void).call(this, this.getText(), "end");
	}

	/** Clean up an argument-completed slash command by submitting it. */
	private submitForSlash(): void {
		const rec = this as unknown as { submitValue?: () => void };
		if (typeof rec.submitValue === "function") rec.submitValue();
	}

	/** Dismiss the suggestion dropdown (TS-private upstream, probed like the rest). */
	private cancelAutocompleteForInput(): void {
		const rec = this as unknown as { cancelAutocomplete?: () => void };
		if (typeof rec.cancelAutocomplete === "function") rec.cancelAutocomplete();
	}

	/**
	 * Would the current line still produce completions if a request fired?
	 * Mirrors the completion triggers (slash commands, @/path-shaped tokens,
	 * the run/file program verb). Used to spot-drop a stale dropdown after
	 * line-level edits that upstream never re-requests (e.g. ctrl+u).
	 */
	private autocompleteStillRelevant(): boolean {
		const text = this.getText();
		const col = Math.min(this.getCursor().col, text.length);
		const before = text.slice(0, col).trimStart();
		if (!before) return false;
		if (before.startsWith("/")) return true;
		const tokens = before.split(/\s+/).filter(Boolean);
		const current = tokens[tokens.length - 1] ?? "";
		if (
			current.startsWith("@") ||
			current.startsWith("./") ||
			current.startsWith("../") ||
			current.startsWith("~/") ||
			current.startsWith("/") ||
			current.includes("/")
		) {
			return true;
		}
		const verb = tokens[0] ?? "";
		return (verb === "run" || verb === "file") && tokens.length >= 2;
	}

	render(width: number): string[] {
		// With the `line+rail` frame, one column is reserved for the left rail:
		// the editor lays out its content one cell narrower and `frame` adds
		// the rail back, so the block cursor (a highlighted char IN the string)
		// stays visually correct. Default "off" renders *byte-identical* to
		// stock — the existing equivalence tests rely on that.
		const railWidth = this.promptZone === "line+rail" ? 1 : 0;
		const inner = Math.max(1, width - railWidth);
		const result = super.render(inner);
		this.internals ??= internalsOf(this);
		const intern = this.internals;
		let out: string[];
		if (!intern || intern.autocompleteState() === null || !intern.autocompleteList()) {
			this.dropdownLines = null;
			out = railWidth ? this.frame(result, inner, width) : result;
		} else {
			// Mirror Editor.render's width bookkeeping exactly so the recomputed
			// block matches what stock would have appended (at the inner width).
			const maxPadding = Math.max(0, Math.floor((inner - 1) / 2));
			const paddingX = Math.min(intern.paddingX(), maxPadding);
			const contentWidth = Math.max(1, inner - paddingX * 2);
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
				// Upstream layout changed; fall back to inline rendering.
				this.dropdownLines = null;
				out = railWidth ? this.frame(result, inner, width) : result;
			} else {
				this.dropdownLines = expected;
				out = result.slice(0, start);
				if (railWidth) out = this.frame(out, inner, width);
			}
		}
		// While a band (dropdown or fuzzy picker) is composited above the
		// prompt, the overlay's divider takes over as the zone's top line —
		// drop the editor's own top border so the two never stack. The editor
		// sees the picker/dropdown state in the SAME composite (picker state
		// changes before render; dropdownLines is computed above), so there's
		// no stale-frame flash.
		if (this.promptZone !== "off" && (this.dropdownLines !== null || pickerActive()) && out.length > 0) {
			out = out.slice(1);
		}
		this.lastHeight = out.length;
		return out;
	}

	/** Add the left rail and re-stretch the border rows back to full width. */
	private frame(rows: readonly string[], inner: number, width: number): string[] {
		return rows.map((row, index) => {
			if (index === 0 || index === rows.length - 1) return this.rebuildBorder(row, inner, width);
			return colors.inputBorder("│") + row;
		});
	}

	/** A border row (rendered inner-wide) re-stretched to `width`. */
	private rebuildBorder(row: string, inner: number, width: number): string {
		const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
		if (plain === "─".repeat(inner)) return this.borderColor("─".repeat(width));
		// Scroll-indicator border (─── ↑ N more …): extend the dashes.
		return this.borderColor(plain + "─".repeat(Math.max(0, width - plain.length)));
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
	/**
	 * Input-zone frame, read live each pass: `line` draws a divider above the
	 * band ("the line above the prompt is also above the popups");
	 * `line+rail` also adds a left rail in `theme.inputBorder` and reserves a
	 * column (the editor mirrors it on the prompt line itself). `off` =
	 * today's chrome-less band.
	 */
	promptZone?: () => PromptZone;
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
			const zone = options.promptZone?.() ?? "off";
			// line+rail reserves one column for the rail on band rows; sources
			// (and the editor's own stashed dropdown, already inner-wide) get the
			// narrower width so rail + rows = exactly `width`.
			const railWidth = zone === "line+rail" ? 1 : 0;
			const inner = Math.max(1, width - railWidth);
			// Custom sources first (first non-empty wins), then the editor's own
			// dropdown. `sources` is read live so callers can register/unregister.
			let lines: readonly string[] | null = null;
			for (const source of options.sources ?? []) {
				const candidate = source(inner);
				if (candidate && candidate.length > 0) {
					lines = candidate;
					break;
				}
			}
			if (!lines || lines.length === 0) {
				const editorLines = editorDropdownSource(editor)(inner);
				if (editorLines && editorLines.length > 0) lines = editorLines;
			}
			const banded = lines !== null && lines.length > 0;
			// Read fresh every composite pass; resolveOverlayLayout re-runs after
			// this returns, so the mutated offset applies to this very frame.
			// While a framed zone (`line`/`line+rail`) has a band up, the editor
			// suppresses its own top border (a band row takes its place): it renders
			// one fewer line AND that freed row becomes the prompt's row — the
			// prompt climbs into the row the top border used to occupy, which is
			// the exact row the band's bottom edge docks on. The base document also
			// shrinks by one row, so the band must rise a full two rows above the
			// naive `-(rowsBelow + lastHeight)`: +1 for the dropped border height
			// (lastHeight 3→2) and +1 because the prompt moved up into that border
			// row. Without it the band's last row sits on the prompt line and the
			// prompt disappears under the popup.
			overlayOptions.offsetY = -(
				rowsBelow() + editor.lastHeight + (zone !== "off" && banded ? 2 : 0)
			);
			if (!lines || lines.length === 0) return [];
			if (zone === "off") return [...lines];
			// The frame: a divider above the band (the zone's top line) and,
			// with line+rail, a rail on every band row.
			const railed = railWidth === 1 ? lines.map((line) => colors.inputBorder("│") + line) : [...lines];
			return [colors.inputBorder("─".repeat(width)), ...railed];
		},
	};

	tui.showOverlay(component, overlayOptions);

	return { options: overlayOptions };
}
