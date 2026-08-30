/**
 * Fuzzy picker — the pi/opencode `/resume` interaction, rendered like the
 * slash-command dropdown.
 *
 * Bare collection commands (`/session`, `/target`, `/layout`, `/win switch`)
 * open a picker docked flush above the prompt: type to fuzzy-narrow, ↑/↓ to
 * move, Enter to pick, Esc to cancel. Its lines flow through the SAME overlay
 * as the slash dropdown (`pickerLineSource` → `attachDropdownOverlay`), so it
 * inherits the dropdown's full-width, chrome-less band and live geometry
 * instead of opening a second floating box.
 *
 * The filter itself lives in the REAL prompt, cursor-style: the moment the
 * finder opens the prompt reads `> ` (a `>` prefix replacing the normal
 * command line) and grows to `> <query>` as you type, with a readline caret
 * inside the query (ctrl+a/e/b/f/w/u/k/y + yank all work — the block cursor
 * tracks the caret via `setPromptCaret`). Typing inserts at the caret,
 * backspace shrinks, Enter picks, Esc restores the empty prompt and closes
 * the finder. A pasted/recalled command line `> <query>` seeds the filter up
 * front via `initialFilter` (the live-typed `>` is handled by main.ts's
 * global listener).
 *
 * Create + delete add two affordances on top of the plain picker:
 *  - with `onCreate`, a `+ create … <query>` row is appended whenever the
 *    typed filter doesn't exactly match a saved item. When the filter has
 *    zero fuzzy matches the create row is auto-selected, so typing a fresh
 *    name and hitting Enter creates it directly.
 *  - with `onDelete`, ctrl+d on a highlighted item enters an inline confirm
 *    step (Enter to delete, Esc back to browsing) — no accidental deletes.
 *
 * Key-wiring notes:
 *  - The picker is non-capturing; the editor stays focused the whole time.
 *    The host's global input listener (main.ts) returns `undefined` while
 *    `pickerActive()`, so keys flow to the listener registered here, which
 *    consumes them all. The moment it closes, main.ts resumes normal
 *    dispatch.
 *  - Rendering is lazy: `pickerLineSource(width)` rebuilds the band from the
 *    live filter/list state every composite pass, so it always truncates to
 *    the real overlay width and never needs a manual repaint hook. Only the
 *    narrowed items are drawn in the band — the query itself is the prompt
 *    (`host.setPromptText`), so there is no filter row in the overlay.
 *  - `SelectList.setFilter` is prefix-only, so we pre-filter with
 *    `fuzzyFilter` over the item's search text (label by default) and
 *    rebuild the list each keystroke; SelectList handles selection keys and
 *    rendering.
 */

import {
	fuzzyFilter,
	getKeybindings,
	isKeyRelease,
	matchesKey,
	SelectList,
	type TuiInputListener,
} from "@earendil-works/pi-tui";
import { colors } from "./theme.ts";

export interface PickerItem {
	value: string;
	label: string;
	description?: string;
	/**
	 * Fuzzy-match text, when it differs from the label. Labels may carry
	 * decoration — a `/open` group tag (`session  example`), a pane index, a
	 * "current" mark — and decoration letters can fake-match a query: the tag
	 * `target` alone would make `e` match every single row. Callers whose
	 * labels are decorated set this to the RAW NAME (plus anything else the
	 * user should be able to type); matching falls back to the label when
	 * absent.
	 */
	search?: string;
}

export interface PickerOptions {
	/** Informational name of the collection, e.g. "resume session". Not drawn — the band is chrome-less like the slash dropdown. */
	title: string;
	items: PickerItem[];
	/**
	 * Seed the finder's filter with this text — how a pasted/recalled
	 * `> <query>` line (routed through handleReplInput) opens pre-narrowed.
	 */
	initialFilter?: string;
	onPick(item: PickerItem): void;
	onCancel?(): void;
	/**
	 * When set, a `+ create …` row is appended to the list whenever the
	 * filter names nothing already saved (no exact value match). Enter on it
	 * calls `onCreate` with the raw typed filter.
	 */
	onCreate?(query: string): void;
	/** Label builder for the create row, e.g. `create new layout "x"`. */
	createLabel?(query: string): string;
	/**
	 * When set, ctrl+d on a highlighted item enters an inline confirm step;
	 * Enter confirms the delete, Esc returns to browsing.
	 */
	onDelete?(item: PickerItem): void;
	/**
	 * When set, ctrl+r renames the highlighted item to the current filter
	 * text. "Save current" works via the `+ create` row on Enter.
	 */
	onRename?(item: PickerItem, newName: string): void;
}

/** The TUI surface the picker needs; main.ts installs the real things. */
export interface PickerHost {
	addInputListener(listener: TuiInputListener): () => void;
	requestRender(): void;
	/**
	 * Replace the prompt text (e.g. `"> " + filter`), moving the cursor to the
	 * end. The fuzzy filter lives in the real prompt, cursor-style; pass "" to
	 * restore the empty prompt on close.
	 */
	setPromptText(text: string): void;
	/** Move the prompt cursor to an absolute column (readline ctrl+a etc.). */
	setPromptCaret?(col: number): void;
}

/** Prompt prefix shown while the finder is open (`>` prompt, cursor-style). */
const PROMPT_PREFIX = "> ";

/** Push the current filter into the real prompt as `> <query>` (`> ` when empty).
 * The caret sits after `caret` filter characters (readline editing). */
function syncPrompt(text: string, caret = text.length): void {
	host?.setPromptText(PROMPT_PREFIX + text);
	host?.setPromptCaret?.(PROMPT_PREFIX.length + caret);
}

let host: PickerHost | null = null;
let active = false;

/** The band currently being shown, rebuilt lazily from live picker state. */
let renderCurrent: ((width: number) => readonly string[] | null) | null = null;

/** Install the host (main.ts at startup); null detaches and resets (tests). */
export function installPickerHost(next: PickerHost | null): void {
	host = next;
	if (!next) {
		active = false;
		renderCurrent = null;
	}
}

/** True while a picker overlay is open (main.ts defers to it). */
export function pickerActive(): boolean {
	return active;
}

/**
 * The picker's contribution to the shared prompt-overlay band. Registered as
 * `attachDropdownOverlay`'s first source so the picker renders through the
 * exact same full-width, chrome-less overlay (and its live `offsetY`) as the
 * slash dropdown. Returns null while no picker is open.
 */
export function pickerLineSource(width: number): readonly string[] | null {
	if (!active || !renderCurrent) return null;
	return renderCurrent(width);
}

/** "now", "40s ago", "3m ago", "2h ago", "4d ago". */
export function relativeTime(savedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
	if (seconds < 5) return "now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

const MAX_VISIBLE = 8;

/** Sentinel value for the "+ create …" pseudo-row. */
const CREATE_VALUE = "__create__";

const selectTheme = {
	selectedPrefix: (s: string) => colors.accent(s),
	selectedText: (s: string) => colors.bold(colors.accent(s)),
	description: (s: string) => colors.muted(s),
	scrollInfo: (s: string) => colors.muted(s),
	noMatch: (s: string) => colors.error(s),
};

interface BuiltList {
	list: SelectList;
	/** Exact label of the create row, or null when the row is hidden. */
	createLabelText: string | null;
}

/**
 * Build a fresh SelectList over fuzzy-filtered items, plus (when the filter
 * names nothing saved) the `+ create` row. Search only the label (name):
 * descriptions are for the eyes after narrowing, not search terms — "me"
 * would otherwise match every session whose description mentions "game".
 *
 * Selection: the create row is appended after any matches (one ↓ away), but
 * auto-selected when there are zero matches so Enter creates immediately.
 * An exact value match suppresses the create row entirely — no accidental
 * overwrite of an existing profile by renaming onto it.
 */
function buildList(items: PickerItem[], filter: string, options: PickerOptions): BuiltList {
	// Search the item's `search` text (defaulting to the label): callers set
	// `search` to the raw name when the label carries decoration (a /open
	// group tag, a pane index, a "current" mark). Two traps kept out of the
	// match text: SGR codes end in a literal 'm' (a query like "mem" would
	// match the escape sequences themselves and return everything), and a
	// group tag like "target" contains enough letters that a one-key query
	// ("e") would match every tagged row instead of narrowing by name.
	// Strip the codes for matching; the rendered rows keep their colors.
	const searchText = (item: PickerItem) => (item.search ?? item.label).replace(/\x1b\[[0-9;]*m/g, "");
	const filtered = filter ? fuzzyFilter(items, filter, searchText) : items;
	const exactMatch =
		filter.length > 0 && items.some((item) => item.value.toLowerCase() === filter.toLowerCase());
	const showCreate = options.onCreate !== undefined && filter.length > 0 && !exactMatch;

	const rows = filtered.map((item) => ({
		value: item.value,
		label: item.label,
		description: item.description,
	}));
	let createLabelText: string | null = null;
	if (showCreate) {
		const label = `+ ${options.createLabel?.(filter) ?? `create "${filter}"`}`;
		createLabelText = label;
		rows.push({ value: CREATE_VALUE, label, description: "" });
	}

	const list = new SelectList(rows, MAX_VISIBLE, selectTheme, {
		minPrimaryColumnWidth: 18,
		maxPrimaryColumnWidth: 30,
	});
	if (showCreate && filtered.length === 0) list.setSelectedIndex(rows.length - 1);
	return { list, createLabelText };
}

/** A single printable character (key ids arrive as bare glyphs). */
function isFilterChar(data: string): boolean {
	return data.length === 1 && /^[\p{L}\p{N}_\-./]$/u.test(data);
}

/** Word characters for readline word-moves (alnum + underscore). */
function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/** Cursor position at the start of the word before `pos` (readline alt+b/ctrl+left). */
function wordStartAt(text: string, pos: number): number {
	let p = Math.min(pos, text.length);
	while (p > 0 && !isWordChar(text[p - 1]!)) p--;
	while (p > 0 && isWordChar(text[p - 1]!)) p--;
	return p;
}

/** Cursor position at the end of the word after `pos` (readline alt+f/ctrl+right). */
function wordEndAt(text: string, pos: number): number {
	let p = Math.max(0, pos);
	while (p < text.length && !isWordChar(text[p]!)) p++;
	while (p < text.length && isWordChar(text[p]!)) p++;
	return p;
}

/**
 * Start of the kill region for ctrl+w: from `pos`, back over the word AND the
 * whitespace before it, so a readline-style kill takes both (bash: `a b` +
 * ctrl+w → `a`, not `a `).
 */
function killBackStartAt(text: string, pos: number): number {
	let p = Math.min(pos, text.length);
	while (p > 0 && isWordChar(text[p - 1]!)) p--;
	while (p > 0 && !isWordChar(text[p - 1]!)) p--;
	return p;
}

/** End of the kill region for alt+d: from `pos`, forward over the word and the
 * whitespace after it (readline kill-word parity). */
function killForwardEndAt(text: string, pos: number): number {
	let p = Math.max(0, pos);
	while (p < text.length && isWordChar(text[p]!)) p++;
	while (p < text.length && !isWordChar(text[p]!)) p++;
	return p;
}

/**
 * The picker's contribution to the shared prompt-overlay band: the narrowed
 * SelectList rows (the query lives in the prompt itself, not the band) plus a
 * one-row muted footer for the invisible affordances. No borders, no title bar
 * — it looks like (and is) the slash dropdown.
 */
function buildBand(
	options: PickerOptions,
	width: number,
	list: SelectList,
	createLabelText: string | null,
	confirmTarget: PickerItem | null,
): string[] {
	const lines: string[] = [];
	if (confirmTarget) {
		lines.push(colors.warning(`delete "${confirmTarget.value}"?`));
	} else {
		for (const line of list.render(width)) {
			lines.push(createLabelText && line.includes(createLabelText) ? colors.accent(line) : line);
		}
	}
	const footer = confirmTarget
		? "Enter to confirm · Esc to cancel"
		: [
				"↑/↓ move",
				"Enter select",
				...(options.onCreate ? ["Enter new = save"] : []),
				...(options.onDelete ? ["ctrl+d delete"] : []),
				...(options.onRename ? ["ctrl+r rename"] : []),
				"Esc cancel",
		  ].join(" · ");
	lines.push(colors.muted(footer));
	return lines;
}

export function openPicker(options: PickerOptions): void {
	if (!host || active) return;
	// An empty list only opens when there is something to create; otherwise
	// the picker would be a dead end (caller supplies a placeholder item).
	if (options.items.length === 0 && !options.onCreate) {
		options.onCancel?.();
		return;
	}

	active = true;
	// Filter lives in the real prompt, cursor-style: the `>` prompt shows the
	// instant the finder opens (empty query → `> `), then grows as you type.
	// A pasted/recalled `> <query>` line seeds the filter up front.
	// Restored to "" on close.
	let filter = options.initialFilter ?? "";
	let caret = filter.length;
	/** Last killed text (ctrl+u/k/w), yanked back with ctrl+y. */
	let killed = "";
	syncPrompt(filter, caret);
	let confirmTarget: PickerItem | null = null;
	let built = buildList(options.items, filter, options);
	let list = built.list;
	let createLabelText = built.createLabelText;

	// The shared overlay re-reads this on every composite pass, so it always
	// reflects the latest list/confirm state and the real band width.
	renderCurrent = (width: number): readonly string[] | null =>
		buildBand(options, width, list, createLabelText, confirmTarget);
	host.requestRender();

	function close(kind: "pick" | "create" | "delete" | "rename" | "cancel", item?: PickerItem, extra?: { newName: string }): void {
		if (!active) return;
		active = false;
		removeListener();
		renderCurrent = null;
		host?.setPromptText("");
		host?.setPromptCaret?.(0);
		host?.requestRender();
		if (kind === "pick" && item) options.onPick(item);
		else if (kind === "create" && options.onCreate) options.onCreate(filter);
		else if (kind === "delete" && item && options.onDelete) options.onDelete(item);
		else if (kind === "rename" && item && options.onRename && extra) options.onRename(item, extra.newName);
		else options.onCancel?.();
	}

	const removeListener = host.addInputListener((data) => {
		if (!active) return undefined;

		// Kitty keyboard protocol (flag 2: report event types) sends a
		// key-release sequence after every press, and the release parses to the
		// same key id as the press (e.g. "\x1b[1;1B" press + "\x1b[1;1:3B"
		// release are both `down`). pi-tui filters releases for focused
		// components but NOT for addInputListener listeners, so without this a
		// single physical arrow key would step the selection twice. Repeats
		// (event type 2) deliberately still act — holding a key auto-repeats in
		// legacy terminals too.
		if (isKeyRelease(data)) {
			return { consume: true };
		}

		const kb = getKeybindings();

		// Inline delete confirm: only Enter (confirm) and Esc (back out) act.
		if (confirmTarget) {
			if (kb.matches(data, "tui.select.confirm")) {
				close("delete", confirmTarget);
				return { consume: true };
			}
			if (kb.matches(data, "tui.select.cancel")) {
				confirmTarget = null;
				host?.requestRender();
				return { consume: true };
			}
			return { consume: true };
		}

		if (matchesKey(data, "ctrl+r") && options.onRename) {
			const item = list.getSelectedItem();
			if (item && item.value !== CREATE_VALUE && filter.length > 0) {
				close("rename", item, { newName: filter });
			}
			return { consume: true };
		}

		// ---- caret-aware filter editing (readline keys: ctrl+a/e/b/f/w/u/k/y) ----
		// The editor's bindings drive a caret that moves INSIDE the query; the
		// block cursor in the real prompt follows it via setPromptCaret. Every
		// mutation rebuilds the narrowed list + prompt at once.
		const rebuildFilter = (next: string, nextCaret: number): void => {
			filter = next;
			caret = nextCaret;
			built = buildList(options.items, filter, options);
			list = built.list;
			createLabelText = built.createLabelText;
			syncPrompt(filter, caret);
			host?.requestRender();
		};

		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			// backspace — delete the char before the caret.
			if (caret > 0) rebuildFilter(filter.slice(0, caret - 1) + filter.slice(caret), caret - 1);
			return { consume: true };
		}
		// ctrl+d conflicts with the picker's item-delete affordance: readline
		// parity says ctrl+d forward-deletes a char, but at the tail of the
		// query there IS no char — that's where the item-delete confirm lives.
		// The Delete key forward-deletes unconditionally (never item-delete).
		const isCtrlD = matchesKey(data, "ctrl+d");
		if (isCtrlD && options.onDelete && caret === filter.length) {
			const item = list.getSelectedItem();
			// The create row isn't a real item — nothing to delete.
			if (item && item.value !== CREATE_VALUE) {
				confirmTarget = item;
				host?.requestRender();
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			// ctrl+d mid-query (or Delete) — delete the char under the caret.
			if (caret < filter.length) rebuildFilter(filter.slice(0, caret) + filter.slice(caret + 1), caret);
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			// ctrl+a / home — front of the query.
			if (caret !== 0) {
				caret = 0;
				syncPrompt(filter, caret);
				host?.requestRender();
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			// ctrl+e / end — back of the query.
			if (caret !== filter.length) {
				caret = filter.length;
				syncPrompt(filter, caret);
				host?.requestRender();
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			// ctrl+b / left — one char back.
			if (caret > 0) {
				caret -= 1;
				syncPrompt(filter, caret);
				host?.requestRender();
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			// ctrl+f / right — one char forward.
			if (caret < filter.length) {
				caret += 1;
				syncPrompt(filter, caret);
				host?.requestRender();
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			// alt+b / ctrl+left / alt+left — back to the previous word start.
			const target = wordStartAt(filter, caret);
			if (target !== caret) {
				caret = target;
				syncPrompt(filter, caret);
				host?.requestRender();
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			// alt+f / ctrl+right / alt+right — forward to the next word end.
			const target = wordEndAt(filter, caret);
			if (target !== caret) {
				caret = target;
				syncPrompt(filter, caret);
				host?.requestRender();
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			// ctrl+w — kill the word before the caret into the kill ring
			// (readline takes the preceding whitespace too).
			const start = killBackStartAt(filter, caret);
			if (start !== caret) {
				killed = filter.slice(start, caret);
				rebuildFilter(filter.slice(0, start) + filter.slice(caret), start);
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			// alt+d / alt+delete — kill the word after the caret into the ring
			// (readline takes the following whitespace too).
			const end = killForwardEndAt(filter, caret);
			if (end !== caret) {
				killed = filter.slice(caret, end);
				rebuildFilter(filter.slice(0, caret) + filter.slice(end), caret);
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			// ctrl+u — kill from the line start to the caret (the whole query
			// when the caret is at the end, which is the usual case).
			if (caret > 0) {
				killed = filter.slice(0, caret);
				rebuildFilter(filter.slice(caret), 0);
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			// ctrl+k — kill from the caret to the line end.
			if (caret < filter.length) {
				killed = filter.slice(caret);
				rebuildFilter(filter.slice(0, caret), caret);
			}
			return { consume: true };
		}
		if (kb.matches(data, "tui.editor.yank")) {
			// ctrl+y — paste the last kill at the caret.
			if (killed) {
				rebuildFilter(filter.slice(0, caret) + killed + filter.slice(caret), caret + killed.length);
			}
			return { consume: true };
		}

		if (kb.matches(data, "tui.select.confirm")) {
			const item = list.getSelectedItem();
			if (item) {
				if (item.value === CREATE_VALUE) close("create");
				else close("pick", item);
			}
			return { consume: true };
		}
		// Esc (or an unbound/remapped cancel) always closes the finder.
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
			close("cancel");
			return { consume: true };
		}
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown")
		) {
			list.handleInput(data);
			host?.requestRender();
			return { consume: true };
		}
		if (isFilterChar(data)) {
			// Insert at the caret (default: end, so plain typing behaves exactly
			// as before — but after ctrl+a/b/f the char lands mid-query). Keeps
			// the raw case — the create row shows exactly what the user typed;
			// fuzzyFilter matches case-insensitively regardless.
			rebuildFilter(filter.slice(0, caret) + data + filter.slice(caret), caret + 1);
			return { consume: true };
		}
		// Block everything else while open so the editor never sees the key.
		return { consume: true };
	});
}