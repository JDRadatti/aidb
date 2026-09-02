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
import { INTERPRETERS, renderInterpreter } from "../viz/interpreters.ts";
import { ViewFlags } from "../viz/types.ts";
import type { Binding, BindingSnapshot, FetchCtx, LivePane, Rect } from "../viz/types.ts";

export class LivePaneView extends View implements LivePane {
	private readonly binding: Binding;
	private fetchCtx: FetchCtx;
	private interpreterId: string;
	private flags: ViewFlags | undefined;
	private snap: BindingSnapshot | undefined;
	private prevSnap: BindingSnapshot | undefined;
	private fetching = false;
	private generation = 0;
	/** Set when refreshAll is requested mid-fetch; drains one extra fetch. */
	private refetch = false;
	/** Keep the first assembly location centered through the initial pane resize. */
	private centerAssemblyOnResize = false;
	/** The location the current source buffer is anchored on (line number). */
	private sourceAnchorLine: number | undefined;

	constructor(binding: Binding, interpreterId: string, fetchCtx: FetchCtx, options: ViewOptions = {}, flags?: ViewFlags) {
		super(options.id ?? "live", { ...options, title: options.title ?? LivePaneView.titleFor(binding, interpreterId) });
		this.binding = binding;
		this.fetchCtx = fetchCtx;
		this.flags = flags;
		this.interpreterId = "";
		this.setInterpreter(interpreterId);
	}

	static titleFor(binding: Binding, interpreterId: string): string {
		return `${binding.describe()} · ${INTERPRETERS[interpreterId]?.title ?? interpreterId}`;
	}

	getInterpreterId(): string {
		return this.interpreterId;
	}

	/** The mounted binding; layout persistence serializes it via viz/bindings. */
	getBinding(): Binding {
		return this.binding;
	}

	/** Current render flags; undefined means "use the renderer's defaults". */
	getFlags(): ViewFlags | undefined {
		return this.flags;
	}

	/** Flip one render flag; render-only, so no refetch occurs. Starts from the
	 * renderer's declared defaults so toggling one flag keeps the others on. */
	toggleFlag(flag: ViewFlags): void {
		const base = this.flags ?? (INTERPRETERS[this.interpreterId]?.defaultFlags ?? ViewFlags.None);
		this.flags = base ^ flag;
		this.touch();
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
		this.centerAssemblyOnResize = false;
		this.sourceAnchorLine = undefined;
		this.refetch = this.fetching;
		this.touch();
	}

	override setViewportHeight(rows: number): void {
		const changed = rows !== this.getViewportHeight();
		super.setViewportHeight(rows);
		if (this.binding.setViewportHeight?.(rows)) void this.refreshAll();
		if (!changed || !this.centerAssemblyOnResize || (this.snap?.kind !== "assembly" && this.snap?.kind !== "interleaved")) return;
		const current = this.snap.kind === "assembly"
			? this.snap.instructions?.findIndex((instruction) => instruction.current) ?? -1
			: this.snap.interleaved?.findIndex((row) => row.kind === "instruction" && row.instruction.current) ?? -1;
		if (current >= 0) this.centerCursor(current);
		this.centerAssemblyOnResize = false;
	}

	async refreshAll(advance = false): Promise<void> {
		// A refresh after a genuinely new stop advances prevSnap to the previous
		// stop's snapshot so renderers can highlight what changed. We capture it
		// here — synchronously, before any in-flight fetch commits the new stop's
		// data — because several events (stopped, location, breakpoints-changed)
		// each trigger a refresh for the same stop. A coalesced duplicate would
		// otherwise set prevSnap to the just-fetched (identical) snapshot and
		// erase the change highlight after a single frame.
		if (advance) this.prevSnap = this.snap;
		if (this.fetching) {
			this.refetch = true;
			return;
		}
		this.fetching = true;
		const generation = this.generation;
		try {
			const next = await this.binding.fetch(this.fetchCtx, this.snap);
			if (generation === this.generation) {
					this.snap = next;
					this.touch();
					if (next.kind === "assembly" || next.kind === "interleaved") {
						const current = next.kind === "assembly"
							? next.instructions?.findIndex((instruction) => instruction.current) ?? -1
							: next.interleaved?.findIndex((row) => row.kind === "instruction" && row.instruction.current) ?? -1;
						if (current >= 0) {
							this.centerCursor(current);
							this.centerAssemblyOnResize = true;
						}
					} else if (next.kind === "source" && next.lines && next.startLine !== undefined && next.currentLine !== undefined) {
						this.anchorSource(next.lines.length, next.startLine, next.currentLine);
					}
			}
		} catch (error) {
			// Bindings promise not to throw; keep the pane alive regardless.
			const message = error instanceof Error ? error.message : String(error);
			if (generation === this.generation) {
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

	/**
	 * Center the pane on the debugger's current source line. The source
	 * binding fetches a wide buffer with the location somewhere inside, so the
	 * View's cursor must be moved to that line or the window would show the
	 * top of the buffer and hide the ▶. Refresh events fire several times for a
	 * single stop, so only re-anchor when the tracked line actually moved —
	 * preserving the user's scroll while looking around a stopped frame.
	 */
	private anchorSource(bufferLines: number, startLine: number, currentLine: number): void {
		const count = Math.max(1, bufferLines);
		const index = currentLine - startLine;
		if (index === this.sourceAnchorLine) return;
		this.sourceAnchorLine = index;
		this.cursorLine = Math.max(0, Math.min(count - 1, index));
		const maxScroll = Math.max(0, count - this.getViewportHeight());
		this.scrollRow = Math.max(0, Math.min(maxScroll, this.cursorLine - Math.floor(this.getViewportHeight() / 2)));
		this.changed();
	}

	protected content(width: number): string[] {
		const interpreter = INTERPRETERS[this.interpreterId];
		if (!interpreter) return [`✗ unknown view '${this.interpreterId}'`];
		const rect: Rect = { width, height: this.getViewportHeight() };
		return renderInterpreter(interpreter, this.snap, this.prevSnap, rect, this.flags);
	}
}
