/**
 * Window manager: turns the logical split tree into pi-tui components.
 *
 * Deliberately dumb while the mechanics are being proven:
 * - No modes, no key routing, no focus concept. The prompt is always live.
 * - Panes are addressed BY INDEX (position in `tree.panes()` order) from
 *   explicit commands like /switch 1 or /win close 2. Indices shift when a
 *   pane before them closes — /win list shows the current mapping.
 * - Every pane is tinted with its index color and titled `idx name`; blank
 *   panes render an IndexSlab so geometry is verifiable at a glance.
 * Leader keys (tmux-style) are a planned layer on top; see windows-plan.html.
 */

import { HStack, VStack, type Component, type StackChild } from "@earendil-works/pi-tui";
import { LAYOUT_NODE, type LayoutNode } from "@earendil-works/pi-tui/dist/layout-node.js";
import { MAX_PANES_PER_DIRECTION, SplitTree, type PaneId, type SplitDir, type SplitResult, type TreeNode } from "./split-tree.ts";
import { View } from "./view.ts";
import { IndexSlab, tint, type BodyRowsAware } from "./pane-slab.ts";

export const MIN_PANE_WIDTH = 10;
export const MIN_PANE_HEIGHT = 3;
const TITLE_ROWS = 1;

/**
 * Rows of screen chrome below the panes: editor (top border, input line,
 * bottom border) + status bar (1). Undercounting makes the document one
 * row taller than the terminal, which scrolls the pane titles offscreen.
 */
const CHROME_ROWS_ESTIMATE = 4;

export interface WindowManagerDeps {
	/** Panes by id; unregistered ids render as an IndexSlab placeholder. */
	panes: Map<PaneId, Component>;
	/** Available content rows for panes (terminal rows minus chrome). */
	getViewRows?: () => number;
	/** Called whenever the layout may have changed. */
	onChange?: () => void;
}

/**
 * vim naming: `v` = vertical divider = columns side by side,
 * `h` = horizontal divider = rows stacked.
 */
export type { SplitDir };

export interface PaneEntry {
	idx: number;
	id: PaneId;
	title: string;
	active: boolean;
}

/**
 * HStack whose children get explicit bases proportional to the split
 * weights, computed from the actual render width. Without this, pi-tui
 * starts from intrinsic content widths and only grows the remainder
 * proportionally — a long REPL transcript would eat the screen.
 */
class WeightedHStack extends HStack {
	private weights: number[];
	constructor(children: StackChild[], weights: number[]) {
		super(children);
		this.weights = weights;
	}
	render(width: number): string[] {
		const gaps = Math.max(0, this.entries.length - 1) * this.gap;
		const total = Math.max(0, width - gaps);
		const weightSum = this.weights.reduce((sum, weight) => sum + weight, 0) || 1;
		this.entries.forEach((entry, index) => {
			entry.basis = Math.round((total * (this.weights[index] ?? 1)) / weightSum);
		});
		return super.render(width);
	}
}

/** Title row + background-tinted body. The active pane's title gets a marker. */
class PaneChrome implements Component {
	private readonly paneId: PaneId;
	private readonly child: Component;
	private readonly manager: WindowManager;

	constructor(paneId: PaneId, child: Component, manager: WindowManager) {
		this.paneId = paneId;
		this.child = child;
		this.manager = manager;
	}

	private idx(): number {
		return this.manager.indexOf(this.paneId);
	}

	render(width: number): string[] {
		const idx = this.idx();
		const bodyRows = this.manager.getBodyRows(this.paneId);
		const title = `${this.child instanceof View ? this.child.title || this.paneId : this.paneId}${this.manager.tree.active === this.paneId ? " *" : ""}`;
		let body = this.child.render(width);
		// Panes are fixed-height: clip overflow to the allotted rows, keeping
		// the tail (the latest output for a transcript). Without this a long
		// transcript stretches the whole document and pushes sibling panes
		// offscreen above.
		if (bodyRows > 0 && body.length > bodyRows) {
			body = body.slice(-bodyRows);
		}
		// Pad short panes so backgrounds stay continuous beside taller siblings.
		while (body.length < bodyRows) body.push("");
		return [tint(` ${title}`, width, idx), ...body.map((line) => tint(line, width, idx))];
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

export class WindowManager implements Component {
	readonly tree: SplitTree;
	private deps: WindowManagerDeps;
	private version = 0;
	private cachedVersion = -1;
	private cachedComponent: Component | null = null;
	/** Body rows allotted to leaves of the tallest vertical path (chrome pads to this). */
	bodyRows = 0;
	private paneBodyRows = new Map<PaneId, number>();

	constructor(tree: SplitTree, deps: WindowManagerDeps) {
		this.tree = tree;
		this.deps = deps;
	}

	register(pane: PaneId, component: Component): void {
		this.deps.panes.set(pane, component);
		this.changed();
	}

	unregister(pane: PaneId): void {
		this.deps.panes.delete(pane);
		this.changed();
	}

	/**
	 * Split the pane at `targetIdx` (`v`: columns, `h`: rows). Omitting the
	 * index targets the active pane. Pass `newPaneId` to attach content that
	 * was pre-registered under that id; otherwise a fresh blank slab is made.
	 */
	split(dir: SplitDir, targetIdx?: number, newPaneId?: PaneId): SplitResult<PaneId> {
		if (newPaneId && /^\d+$/.test(newPaneId)) {
			return { ok: false, error: "numeric pane names are reserved for indices" };
		}
		const panes = this.tree.panes();
		const resolved = targetIdx ?? panes.indexOf(this.tree.active);
		const target = panes[resolved];
		if (!target) return { ok: false, error: `no pane at index ${resolved} (/win list shows indices)` };
		const id = newPaneId ?? this.freshPaneId();
		if (panes.includes(id)) return { ok: false, error: `pane '${id}' already exists` };
		const previousActive = this.tree.active;
		this.tree.setActive(target);
		const result = this.tree.split(dir, id);
		if (!result.ok) {
			this.tree.setActive(previousActive);
			return result;
		}
		this.changed();
		return { ok: true, value: id };
	}

	/**
	 * Close a pane addressed by index or name. The repl pane refuses.
	 */
	close(ref: number | string): SplitResult<null> {
		const id = this.resolve(ref);
		if (!id) return { ok: false, error: this.unresolvedMessage(ref) };
		if (id === "repl") return { ok: false, error: "the repl pane cannot be closed" };
		const result = this.tree.close(id);
		if (!result.ok) return result;
		this.deps.panes.delete(id);
		this.changed();
		return result;
	}

	/** Swap the content of an existing pane (e.g. turn a blank slab into a live view). */
	mount(id: PaneId, component: Component): SplitResult<null> {
		if (!this.resolve(id)) {
			return { ok: false, error: `no pane named '${id}' (/win list shows panes)` };
		}
		this.register(id, component);
		return { ok: true, value: null };
	}

	/**
	 * Make the given pane active (default split target). Panes are addressed
	 * by index, digit string, or name.
	 */
	switchTo(ref: number | string): boolean {
		const id = this.resolve(ref);
		if (!id) return false;
		this.tree.setActive(id);
		this.changed();
		return true;
	}

	/**
	 * Resolve an address to a pane id: a number or digit string is an index
	 * into `tree.panes()` order; anything else matches an id (or title).
	 */
	resolve(ref: number | string): PaneId | undefined {
		const panes = this.tree.panes();
		if (typeof ref === "number") return panes[ref];
		if (/^\d+$/.test(ref)) return panes[Number.parseInt(ref, 10)];
		return panes.find((id) => id === ref || this.titleOf(id) === ref);
	}

	/** Cycle active to the next pane in index order. */
	cycle(): PaneId {
		const panes = this.tree.panes();
		const next = panes[(panes.indexOf(this.tree.active) + 1) % panes.length];
		this.tree.setActive(next);
		this.changed();
		return next;
	}

	list(): PaneEntry[] {
		const active = this.tree.active;
		return this.tree.panes().map((id, idx) => ({
			idx,
			id,
			title: this.titleOf(id),
			active: id === active,
		}));
	}

	indexOf(id: PaneId): number {
		return this.tree.panes().indexOf(id);
	}

	getBodyRows(id: PaneId): number {
		return this.paneBodyRows.get(id) ?? this.bodyRows;
	}

	/** The component currently mounted in a pane, if any. */
	component(id: PaneId): Component | undefined {
		return this.deps.panes.get(id);
	}

	get active(): PaneId {
		return this.tree.active;
	}

	private titleOf(id: PaneId): string {
		const component = this.deps.panes.get(id);
		return component instanceof View ? component.title || id : id;
	}

	private unresolvedMessage(ref: number | string): string {
		return typeof ref === "number" || /^\d+$/.test(ref)
			? `no pane at index ${ref} (/win list shows indices)`
			: `no pane named '${ref}'`;
	}

	/**
	 * Flow-mode approximation of per-pane heights until the alt-screen move
	 * supplies exact rects: stack panes share the available rows along the
	 * tallest vertical path; side-by-side panes each get that same height,
	 * minus their title row.
	 */
	private sizePanes(): void {
		const getViewRows = this.deps.getViewRows;
		if (!getViewRows) return;
		const available = Math.max(MIN_PANE_HEIGHT, getViewRows() - CHROME_ROWS_ESTIMATE);
		this.paneBodyRows.clear();
		this.assignPaneRows(this.tree.root, available);
		this.bodyRows = this.paneBodyRows.get(this.tree.panes()[0]!) ?? Math.max(MIN_PANE_HEIGHT - TITLE_ROWS, available - TITLE_ROWS);
		for (const [id, component] of this.deps.panes) {
			if (id === "repl") continue;
			const rows = this.getBodyRows(id);
			if (component instanceof View) component.setViewportHeight(rows);
			else if (isBodyRowsAware(component)) component.setBodyRows(rows);
		}
	}

	/** Assign total pane rows through the tree; vertical siblings share height. */
	private assignPaneRows(node: TreeNode, totalRows: number): void {
		if (typeof node === "string") {
			this.paneBodyRows.set(node, Math.max(MIN_PANE_HEIGHT - TITLE_ROWS, totalRows - TITLE_ROWS));
			return;
		}
		if (node.dir === "v") {
			for (const child of node.children) this.assignPaneRows(child, totalRows);
			return;
		}
		const weightTotal = node.sizes.reduce((sum, size) => sum + size, 0) || node.children.length;
		let remaining = totalRows;
		for (let i = 0; i < node.children.length; i++) {
			const slotsLeft = node.children.length - i;
			const rows = i === node.children.length - 1
				? remaining
				: Math.max(MIN_PANE_HEIGHT, Math.floor((totalRows * (node.sizes[i] ?? 1)) / weightTotal));
			this.assignPaneRows(node.children[i]!, rows);
			remaining -= rows;
		}
	}

	render(width: number): string[] {
		this.sizePanes();
		return this.layout().render(width);
	}

	invalidate(): void {
		this.cachedComponent = null;
	}

	/**
	 * Delegate to the derived stack's layout node so a future move to
	 * alt-screen (rect-based layout, scroll viewports) works unchanged.
	 */
	[LAYOUT_NODE](): LayoutNode {
		const root = this.layout() as Partial<Record<typeof LAYOUT_NODE, () => LayoutNode>>;
		const node = root[LAYOUT_NODE]?.();
		if (!node) throw new Error("window manager root must be a stack component");
		return node;
	}

	private changed(): void {
		this.version++;
		this.deps.onChange?.();
	}

	private freshPaneId(): PaneId {
		const taken = new Set(this.tree.panes());
		let i = this.deps.panes.size + 1;
		while (taken.has(`pane${i}`)) i++;
		return `pane${i}`;
	}

	private layout(): Component {
		if (this.cachedComponent && this.cachedVersion === this.version) return this.cachedComponent;
		// The root is always a stack (single leaves get wrapped) so the
		// LAYOUT_NODE delegation above always has something to hand back.
		const wrap = (node: TreeNode): Component => {
			if (typeof node === "string") {
				return new PaneChrome(node, this.contentFor(node), this);
			}
			const children: StackChild[] = node.children.map((child, index) => ({
				component: wrap(child),
				grow: node.sizes[index] ?? 1,
				minSize: node.dir === "v" ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT,
			}));
			const weights = node.children.map((_, index) => node.sizes[index] ?? 1);
			return node.dir === "v"
				? new WeightedHStack(children, weights)
				: new VStack(children);
		};
		const root: Component =
			typeof this.tree.root === "string"
				? new VStack([wrap(this.tree.root)])
				: wrap(this.tree.root);
		this.cachedComponent = root;
		this.cachedVersion = this.version;
		return root;
	}

	private contentFor(pane: PaneId): Component {
		const existing = this.deps.panes.get(pane);
		if (existing) return existing;
		// Blank pane: giant index numeral for visual verification.
		const slab = new IndexSlab(() => this.indexOf(pane));
		this.register(pane, slab);
		return slab;
	}
}

export { MAX_PANES_PER_DIRECTION };

function isBodyRowsAware(component: Component): component is Component & BodyRowsAware {
	return "setBodyRows" in component && typeof component.setBodyRows === "function";
}
