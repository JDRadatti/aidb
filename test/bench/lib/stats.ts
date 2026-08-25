export interface Stats {
	n: number;
	min: number;
	p50: number;
	mean: number;
	p95: number;
	max: number;
}

export function computeStats(values: number[]): Stats {
	if (values.length === 0) throw new Error("Cannot compute statistics for no samples");
	const sorted = [...values].sort((a, b) => a - b);
	const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
	return {
		n: sorted.length,
		min: sorted[0],
		p50: quantile(0.5),
		mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		p95: quantile(0.95),
		max: sorted[sorted.length - 1],
	};
}

export function elapsedMs(start: bigint): number {
	return Number(process.hrtime.bigint() - start) / 1_000_000;
}
