import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDebugger } from "../../debugger-core/src/index.ts";
import { appendRows, environment, type CsvRow } from "./lib/csv.ts";
import { computeStats, elapsedMs } from "./lib/stats.ts";

const root = resolve(import.meta.dirname, "../..");
const fixture = resolve(root, "test/bench/fixtures/bench-loop");
const source = resolve(root, "test/bench/fixtures/bench-loop.c");

function option(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
	if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name} value`);
	return value;
}

function csvPath(): string {
	const index = process.argv.indexOf("--csv");
	return resolve(root, index >= 0 ? process.argv[index + 1] : "results/bench.csv");
}

function waitForStop(eventBus: ReturnType<typeof createDebugger>["eventBus"]): Promise<void> {
	return new Promise((resolve) => {
		const off = eventBus.on("stopped", () => {
			off();
			resolve();
		});
	});
}

async function measure(count: number, operation: () => Promise<void>): Promise<number[]> {
	const samples: number[] = [];
	for (let i = 0; i < count; i++) {
		const start = process.hrtime.bigint();
		await operation();
		samples.push(elapsedMs(start));
	}
	return samples;
}

async function main(): Promise<void> {
	if (!existsSync(fixture)) throw new Error(`Missing compiled fixture: ${fixture}`);
	const runs = option("--runs", 30);
	const warmup = option("--warmup", 3);
	const timestamp = new Date().toISOString();
	const env = environment();
	const { api, eventBus, cleanup } = createDebugger({ cwd: root });
	const measurements = new Map<string, number[]>();
	let start: bigint;
	const record = async (name: string, count: number, operation: () => Promise<void>) => {
		const values = await measure(count + warmup, operation);
		measurements.set(name, values.slice(warmup));
	};

	try {
		start = process.hrtime.bigint();
		await api.setBreakpoint(source, 7);
		measurements.set("spawn_init", [elapsedMs(start)]);

		let breakpointLine = 8;
		await record("break_set", Math.min(runs, 10), async () => {
			const line = breakpointLine++;
			await api.setBreakpoint(source, line);
		});

		const firstStop = waitForStop(eventBus);
		start = process.hrtime.bigint();
		await api.launch(fixture);
		await firstStop;
		measurements.set("launch_first_stop", [elapsedMs(start)]);

		await record("evaluate", runs, async () => {
			await api.evaluate("sum");
		});

		const stackSamples: number[] = [];
		for (let i = 0; i < runs + warmup; i++) {
			if (i > 0) {
				const nextStop = waitForStop(eventBus);
				await api.stepOver();
				await nextStop;
			}
			start = process.hrtime.bigint();
			await api.getStack();
			stackSamples.push(elapsedMs(start));
		}
		measurements.set("get_stack", stackSamples.slice(warmup));

		const stepCount = Math.min(runs, 100);
		await record("step_over", stepCount, async () => {
			const stopped = waitForStop(eventBus);
			await api.stepOver();
			await stopped;
		});

		// The loop is long enough for this to remain at a breakpoint after stepping.
		const stopped = waitForStop(eventBus);
		start = process.hrtime.bigint();
		await api.continue();
		await stopped;
		measurements.set("continue_to_stop", [elapsedMs(start)]);

		const rows: CsvRow[] = [];
		for (const [op, values] of measurements) {
			const stats = computeStats(values);
			rows.push({ timestamp, suite: "latency", scenario: "loop1000", op, unit: "ms", ...stats, ...env });
			console.log(`${op}: p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms mean=${stats.mean.toFixed(2)}ms n=${stats.n}`);
		}
		appendRows(csvPath(), rows);
		console.log(`Appended ${rows.length} rows to ${csvPath()}`);
	} finally {
		await cleanup();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
