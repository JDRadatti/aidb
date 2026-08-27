/**
 * Minimal render specification shared by watch entries and live panes.
 * Phase 6 will add bitflags; today this is renderer id + typed options.
 */

import type { BitmapOptions, BytesOptions, CharsOptions, TupleOptions } from "./types.ts";

export interface RenderSpec {
	rendererId: string;
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
