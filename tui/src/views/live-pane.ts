/**
 * A live pane: one Binding observed after every stop, drawn by one
 * Interpreter (watch-windows.html §4's binding × interpreter grid).
 *
 * The view owns the snapshot history — `snap` is what the last fetch saw,
 * `prevSnap` the stop before it, which interpreters use for change marking.
 * Fetches never throw into the render path: failures become error snapshots
 * so a pane keeps showing its last good frame plus a ✗ line until the next
 * stop retries. Overlapping refreshes coalesce: a call that arrives while a
 * fetch is in flight marks the pane dirty and one more fetch runs after.
 */

import { View, type ViewOptions } from "../view.ts";
import { INTERPRETERS } from "../viz/interpreters.ts";
import type { Binding, BindingSnapshot, FetchCtx, LivePane, Rect } from "../viz/types.ts";

export class LivePaneView extends View implements LivePane {
	private readonly binding: Binding;
	private fetchCtx: FetchCtx;
	private interpreterId: string;
	private snap: BindingSnapshot | undefined;
	private prevSnap: BindingSnapshot | undefined;
	private fetching = false;
	private generation = 0;
	/** Set when refreshAll is requested mid-fetch; drains one extra fetch. */
	private refetch = false;

	constructor(binding: Binding, interpreterId: string, fetchCtx: FetchCtx, options: ViewOptions = {}) {
		super(options.id ?? "live", { ...options, title: options.title ?? LivePaneView.titleFor(binding, interpreterId) });
		this.binding = binding;
		this.fetchCtx = fetchCtx;
		this.interpreterId = "";
		this.setInterpreter(interpreterId);
	}

	static titleFor(binding: Binding, interpreterId: string): string {
		return `${binding.describe()} · ${INTERPRETERS[interpreterId]?.title ?? interpreterId}`;
	}

	getInterpreterId(): string {
		return this.interpreterId;
	}

	/** Cache key of the mounted binding; tests and /win list use this. */
	getBindingIdentity(): string {
		return this.binding.identity();
	}

	setInterpreter(id: string): boolean {
		if (!INTERPRETERS[id]) return false;
		this.interpreterId = id;
		this.title = LivePaneView.titleFor(this.binding, id);
		this.touch();
		return true;
	}

	reset(): void {
		this.generation++;
		this.binding.reset?.();
		this.snap = undefined;
		this.prevSnap = undefined;
		this.refetch = this.fetching;
		this.touch();
	}

	async refreshAll(): Promise<void> {
		if (this.fetching) {
			this.refetch = true;
			return;
		}
		this.fetching = true;
		const generation = this.generation;
		try {
			const next = await this.binding.fetch(this.fetchCtx, this.snap);
			if (generation === this.generation) {
				this.prevSnap = this.snap;
				this.snap = next;
				if (next.kind === "assembly") {
					const current = next.instructions?.findIndex((instruction) => instruction.current) ?? -1;
					if (current >= 0) this.setCursor(current);
				}
				this.touch();
			}
		} catch (error) {
			// Bindings promise not to throw; keep the pane alive regardless.
			const message = error instanceof Error ? error.message : String(error);
			if (generation === this.generation) {
				this.prevSnap = this.snap;
				this.snap = { kind: this.binding.kind, error: message };
				this.touch();
			}
		} finally {
			this.fetching = false;
			if (this.refetch) {
				this.refetch = false;
				void this.refreshAll();
			}
		}
	}

	protected content(width: number): string[] {
		const interpreter = INTERPRETERS[this.interpreterId];
		if (!interpreter) return [`✗ unknown view '${this.interpreterId}'`];
		const rect: Rect = { width, height: this.getViewportHeight() };
		return interpreter.render(this.snap, this.prevSnap, rect);
	}
}
