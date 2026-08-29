/**
 * Logical split-tree model for the window manager.
 *
 * Pure data + operations: no rendering, no terminal, fully unit-testable.
 * Geometry (rects, clipping, scrollbars) is pi-tui's job; this file only
 * decides what is split where, under these constraints:
 *
 * - At most MAX_PANES_PER_DIRECTION panes along each direction (3 columns, 3 rows).
 * - Splitting inserts next to the ACTIVE pane, into the nearest enclosing
 *   group of the same direction when it has room, otherwise by wrapping the
 *   active pane in a fresh group. When such a group exists but is full, the
 *   split is rejected instead of exceeding the cap.
 */

export type PaneId = string;

/**
 * vim naming: `vsplit` = vertical divider = columns side by side,
 * `hsplit` = horizontal divider = rows stacked.
 */
export type SplitDir = "v" | "h";

export const MAX_PANES_PER_DIRECTION = 3;

export interface SplitGroupData {
	dir: SplitDir;
	/** 2..MAX_PANES_PER_DIRECTION entries; groups and leaves alternate direction by construction */
	children: TreeNode[];
	/** positive integer weights per child; splitting halves the active pane's weight */
	sizes: number[];
}

export type TreeNode = SplitGroupData | PaneId;

export type SplitResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isGroup(node: TreeNode): node is SplitGroupData {
	return typeof node !== "string";
}

function contains(node: TreeNode, pane: PaneId): boolean {
	if (typeof node === "string") return node === pane;
	return node.children.some((child) => contains(child, pane));
}

/** Index of the child whose subtree holds `pane`, or -1. */
function subtreeIndex(children: TreeNode[], pane: PaneId): number {
	return children.findIndex((child) => contains(child, pane));
}

/**
 * Serialized form: nested groups or bare pane ids.
 */
export interface SplitTreeData {
	root: TreeNode;
	active: PaneId;
}

export class SplitTree {
	private rootNode: TreeNode;
	private activePane: PaneId;

	constructor(rootPane: PaneId) {
		this.rootNode = rootPane;
		this.activePane = rootPane;
	}

	get active(): PaneId {
		return this.activePane;
	}

	get root(): TreeNode {
		return this.rootNode;
	}

	setActive(pane: PaneId): void {
		if (this.panes().includes(pane)) this.activePane = pane;
	}

	panes(): PaneId[] {
		const out: PaneId[] = [];
		const walk = (node: TreeNode): void => {
			if (isGroup(node)) node.children.forEach(walk);
			else out.push(node);
		};
		walk(this.rootNode);
		return out;
	}

	groups(): SplitGroupData[] {
		const out: SplitGroupData[] = [];
		const walk = (node: TreeNode): void => {
			if (!isGroup(node)) return;
			out.push(node);
			node.children.forEach(walk);
		};
		walk(this.rootNode);
		return out;
	}

	/**
	 * Split the active pane, adding `newPane` beside it (`v`: right, `h`: below).
	 * Rejected when the enclosing same-direction group is already at the cap.
	 */
	split(dir: SplitDir, newPane: PaneId): SplitResult<null> {
		if (this.panes().includes(newPane)) {
			return { ok: false, error: `pane '${newPane}' already exists` };
		}

		let inserted = false;
		let limitHit = false;

		const visit = (node: TreeNode): TreeNode => {
			if (!isGroup(node)) {
				// The active leaf itself: reached only when no enclosing group has
				// this direction, so wrap it in a fresh two-pane group.
				if (node === this.activePane && !inserted && !limitHit) {
					inserted = true;
					return { dir, children: [node, newPane], sizes: [1, 1] };
				}
				return node;
			}
			if (inserted || limitHit) return node;
			if (node.dir !== dir) {
				// Opposite direction: descend into the active pane's subtree; the
				// new pane lands there (a fresh wrapper or a same-direction group).
				node.children = node.children.map(visit);
				return node;
			}
			// The slot that contains the active pane — possibly via nested
			// groups — is the one that splits; this keeps the pane's enclosing
			// cell (not some unrelated sibling) giving up space.
			const index = subtreeIndex(node.children, this.activePane);
			// A sibling same-direction group that doesn't hold the active pane is
			// irrelevant to this split: leave it untouched. Rejecting on it (the
			// old bug) wrongly refused to wrap the active pane in a fresh group
			// just because a neighboring column was itself full of rows.
			if (index === -1) return node;
			// Nearest enclosing same-direction group of the active pane. If it's
			// full there's nowhere to insert, so reject instead of exceeding the cap.
			if (node.children.length >= MAX_PANES_PER_DIRECTION) {
				limitHit = true;
				return node;
			}
			// Vim-style: the new pane takes half the active pane's space.
			// Fractional so repeated splits stay proportional instead of
			// bottoming out at the integer floor.
			const share = (node.sizes[index] ?? 1) / 2;
			node.sizes[index] = share;
			node.sizes.splice(index + 1, 0, share);
			node.children.splice(index + 1, 0, newPane);
			inserted = true;
			return node;
		};

		this.rootNode = visit(this.rootNode);

		if (limitHit) {
			return {
				ok: false,
				error: `cannot ${dir === "v" ? "vsplit" : "hsplit"}: max ${MAX_PANES_PER_DIRECTION} ${dir === "v" ? "columns" : "rows"}`,
			};
		}
		this.activePane = inserted ? newPane : this.activePane;
		return inserted ? { ok: true, value: null } : { ok: false, error: `pane '${this.activePane}' not found` };
	}

	/**
	 * Exchange the positions of two panes: each keeps its content (components
	 * follow pane ids) and moves into the other's cell. Every group's weights
	 * stay where they are, so the geometry of the layout is unchanged — tmux
	 * `swap-pane` semantics. The first pane (`idA`) becomes active.
	 */
	swap(idA: PaneId, idB: PaneId): SplitResult<null> {
		const all = this.panes();
		if (idA === idB) return { ok: false, error: "cannot swap a pane with itself" };
		if (!all.includes(idA)) return { ok: false, error: `no such pane '${idA}'` };
		if (!all.includes(idB)) return { ok: false, error: `no such pane '${idB}'` };

		const transform = (node: TreeNode): TreeNode => {
			if (!isGroup(node)) return node === idA ? idB : node === idB ? idA : node;
			node.children = node.children.map(transform);
			return node;
		};
		this.rootNode = transform(this.rootNode);
		this.activePane = idA;
		return { ok: true, value: null };
	}

	/**
	 * Remove a pane; its space collapses into a neighbor. Groups reduced to a
	 * single child dissolve into their parent. The last pane cannot be closed.
	 */
	close(id: PaneId): SplitResult<null> {
		const all = this.panes();
		if (!all.includes(id)) return { ok: false, error: `no such pane '${id}'` };
		if (all.length === 1) return { ok: false, error: "cannot close the last pane" };

		let focusNeighbor: PaneId | undefined;

		const remove = (node: TreeNode): TreeNode => {
			if (!isGroup(node)) return node;
			const index = node.children.indexOf(id);
			if (index !== -1) {
				const neighbor = node.children[index - 1] ?? node.children[index + 1];
				if (!isGroup(neighbor)) focusNeighbor = neighbor;
				node.children.splice(index, 1);
				node.sizes.splice(index, 1);
				// Dissolve: a group down to one child is replaced by that child.
				return node.children.length === 1 ? node.children[0]! : node;
			}
			node.children = node.children.map(remove);
			return node;
		};

		this.rootNode = remove(this.rootNode);
		rebalanceAll(this);
		if (this.activePane === id) {
			this.activePane = focusNeighbor ?? this.panes()[0]!;
		}
		return { ok: true, value: null };
	}

	cycleFocus(): PaneId {
		const all = this.panes();
		const next = all[(all.indexOf(this.activePane) + 1) % all.length];
		this.activePane = next!;
		return this.activePane;
	}

	serialize(): SplitTreeData {
		return structuredClone({ root: this.rootNode, active: this.activePane });
	}

	static deserialize(data: SplitTreeData): SplitTree {
		const tree = new SplitTree("");
		tree.rootNode = structuredClone(data.root);
		tree.activePane = data.active;
		return tree;
	}
}

/** Normalize weights after membership changes so they stay positive integers. */
function rebalanceAll(tree: SplitTree): void {
	for (const group of tree.groups()) {
		for (let i = 0; i < group.sizes.length; i++) {
			if (!Number.isInteger(group.sizes[i]) || group.sizes[i]! < 1) group.sizes[i] = 1;
		}
	}
}
