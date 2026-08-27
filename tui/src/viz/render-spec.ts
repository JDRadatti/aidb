/**
 * A render specification shared by watch entries and live panes: a renderer
 * id, orthogonal bitflags, and typed options. Flags and options are
 * presentation-time only — `requiredBytes()` never reads them, so toggling
 * a flag or tweaking options never triggers a debugger refetch.
 */

import { ViewFlags } from "./types.ts";
import type { BitmapOptions, BytesOptions, CharsOptions, TupleOptions } from "./types.ts";
export { VIEW_FLAG_META, ViewFlags } from "./types.ts";
export type { FlagDescriptor } from "./types.ts";

/** Renderer ids in display/cycle order; a pane's flag surface is renderer-independent. */
export const RENDERER_ORDER: readonly string[] = [
	"lines", "text", "bytes", "chars", "tuple", "bitmap", "hexdump",
	"code", "iasm", "struct-tree", "sparkline", "table",
];

export interface RenderSpec {
	rendererId: string;
	flags?: ViewFlags;
	options?: BytesOptions | CharsOptions | TupleOptions | BitmapOptions;
}

export const DEFAULT_RENDER_SPEC: RenderSpec = { rendererId: "lines" };

const MEMORY_RENDERERS = new Set(["hexdump", "bytes", "chars", "tuple", "bitmap"]);

/** Byte budget an expression binding should fetch for a render spec. */
export function requiredBytes(spec: RenderSpec): number {
	if (spec.rendererId === "bitmap") {
		const options = (spec.options ?? {}) as BitmapOptions;
		if (options.width && options.height && options.tupleWidth) {
			return options.width * options.height * options.tupleWidth;
		}
	}
	if (spec.rendererId === "lines" || spec.rendererId === "text") return 0;
	if (MEMORY_RENDERERS.has(spec.rendererId)) return 192;
	return 0;
}

/** True when cached bytes are enough to render with the new spec without refetching. */
export function canReuseObservation(
	byteCount: number,
	snapBytes: number | undefined,
	next: RenderSpec,
): boolean {
	return requiredBytes(next) <= Math.max(byteCount, snapBytes ?? 0);
}

/** Next renderer (or previous when `back`) in display order; never repeats the current. */
export function cycleRenderer(current: string, back = false): string {
	const index = RENDERER_ORDER.indexOf(current);
	if (index < 0) return RENDERER_ORDER[0]!;
	const next = back ? (index - 1 + RENDERER_ORDER.length) % RENDERER_ORDER.length : (index + 1) % RENDERER_ORDER.length;
	return RENDERER_ORDER[next]!;
}

/**
 * Next renderer within an allowed subset (e.g. only renderers that can consume
 * the current observation), forward or backward. Falls back to the first when
 * `current` isn't in the subset, and to `RENDERER_ORDER` when the subset is empty.
 */
export function cycleAllowed(current: string, allowed: readonly string[], back = false): string {
	const pool = allowed.length > 0 ? allowed : RENDERER_ORDER;
	const index = pool.indexOf(current);
	if (index < 0) return back ? pool[pool.length - 1]! : pool[0]!;
	const next = back ? (index - 1 + pool.length) % pool.length : (index + 1) % pool.length;
	return pool[next]!;
}

/** The mutable flag bits in cycle order, least significant first. */
export const CYCLE_FLAGS: readonly ViewFlags[] = [
	ViewFlags.ADDRESSES,
	ViewFlags.TYPES,
	ViewFlags.HIDE_CHANGES,
	ViewFlags.ASCII,
];

/** Flip one flag bit on a spec, returning a fresh spec (never mutates the input). */
export function withFlagToggle(spec: RenderSpec, flag: ViewFlags): RenderSpec {
	return { ...spec, flags: (spec.flags ?? 0) ^ flag };
}