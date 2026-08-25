import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export const CSV_HEADER = "timestamp,suite,scenario,op,unit,n,min,p50,mean,p95,max,machine,commit,dirty,gdb_version,node_version,notes\n";

export interface CsvRow {
	timestamp: string;
	suite: string;
	scenario: string;
	op: string;
	unit: string;
	n: number;
	min?: number;
	p50?: number;
	mean?: number;
	p95?: number;
	max?: number;
	machine: string;
	commit: string;
	dirty: boolean;
	gdb_version: string;
	node_version: string;
	notes?: string;
}

function command(command: string, args: string[]): string {
	try {
		return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "unknown";
	}
}

export function environment() {
	return {
		machine: hostname(),
		commit: command("git", ["rev-parse", "--short", "HEAD"]),
		dirty: Boolean(command("git", ["status", "--porcelain"])),
		gdb_version: command("gdb", ["--version"]).split("\n")[0]?.match(/\b(\d+\.\d+(?:\.\d+)?)\s*$/)?.[1] ?? "unknown",
		node_version: process.version,
	};
}

function csv(value: unknown): string {
	const text = value == null ? "" : String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function appendRows(path: string, rows: CsvRow[]): void {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) writeFileSync(path, CSV_HEADER);
	appendFileSync(path, rows.map((row) => [
		row.timestamp, row.suite, row.scenario, row.op, row.unit, row.n,
		row.min, row.p50, row.mean, row.p95, row.max, row.machine,
		row.commit, row.dirty, row.gdb_version, row.node_version, row.notes,
	].map(csv).join(",")).join("\n") + "\n");
}
