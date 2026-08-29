/**
 * aidb persistent state — a 3-way split of the debugging model.
 *
 * Instead of one welded session file, three independent, named stores:
 *
 *   targets/  — WHAT you run: an (optional) kind/program/args profile.
 *               Reusable across sessions (same binary, different bugs).
 *   layouts/  — VIEW: the split-tree + watch panes. Reusable across targets.
 *   sessions/ — a named *binding*: { target: <name>, layout: <name>,
 *               breakpoints[] } — the specific debugging intent (the breakpoints
 *               are the only thing a session *owns*, since breaking is the point).
 *
 * Each store is `targets/<name>.json`-style, validated against a schema version,
 * written atomically (tmp + rename) so a crash never leaves a half-written file.
 * `config.sessions.sessionDir` is the session root; targets and layouts live in
 * sibling dirs so existing config keeps working and saved sessions are untouched.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderSpec } from "./viz/render-spec.ts";
import type { SplitTreeData } from "./split-tree.ts";

export const TARGET_SCHEMA_VERSION = 1;
export const LAYOUT_SCHEMA_VERSION = 1;
export const SESSION_SCHEMA_VERSION = 2;

/* ------------------------------------------------------------------ types */

export interface SessionBreakpoint {
	file?: string;
	line?: number;
	condition?: string;
	verified: boolean;
	/** Location-only breakpoints (`break player_update`) persist this verbatim. */
	location?: string;
}

export interface SessionWatchEntry {
	expr: string;
	renderSpec: RenderSpec;
	byteCount: number;
}

export interface SessionWatchPanes {
	[id: string]: { entries: SessionWatchEntry[] };
}

/* --- target --- */
export interface TargetState {
	schemaVersion: number;
	name: string;
	kind: "launch" | "attach";
	program?: string;
	args: string[];
	pid?: number;
	savedAt: number;
}
export interface TargetMeta {
	name: string;
	file: string;
	savedAt?: number;
	kind: "launch" | "attach";
	program?: string;
	args: string[];
	pid?: number;
}

/* --- layout --- */
export interface LayoutState {
	schemaVersion: number;
	name: string;
	splitTree: SplitTreeData;
	watchPanes: SessionWatchPanes;
	savedAt: number;
}
export interface LayoutMeta {
	name: string;
	file: string;
	savedAt?: number;
	panes: number;
	watchEntries: number;
	/** The saved split-tree, so the layout can be drawn/reapplied without re-reading. */
	splitTree?: SplitTreeData;
	/** Saved watch panes, so the layout can label each pane's content. */
	watchPanes?: SessionWatchPanes;
}

/* --- session --- */
export interface SessionState {
	schemaVersion: number;
	name: string;
	/**
	 * Stable per-session UUID. Implicit (unset) target/layout profiles are
	 * named `@<id>` so two sessions named "session" (or a renamed one) never
	 * collide or cross-write each other's scratch profiles.
	 */
	id?: string;
	/** Name of a target profile, or null when no target. */
	target: string | null;
	/** Name of a layout profile, or null for a fresh single-pane repl. */
	layout: string | null;
	breakPoints: SessionBreakpoint[];
	savedAt: number;
}
export interface SessionMeta {
	name: string;
	file: string;
	savedAt?: number;
	target?: string;
	layout?: string;
	breakpoints: number;
	/** Saved breakpoint docs, so the session can be annotated on restore. */
	breakPoints?: SessionBreakpoint[];
}

/* ------------------------------------------------------------------ plumbing */

function sanitize(name: string): string {
	const trimmed = name.trim();
	const safe = trimmed.replace(/[\\/:.]+/g, "_");
	return safe || "default";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function layoutPaneCount(layout: SplitTreeData): number {
	const walk = (node: unknown): number => {
		if (typeof node === "string") return 1;
		if (isPlainObject(node) && Array.isArray(node.children)) {
			return node.children.reduce((sum, child) => sum + walk(child), 0);
		}
		return 0;
	};
	return walk(layout.root);
}

/* ------------------------------------------------------------------ readers */

function readTarget(raw: unknown): TargetState | { error: string } {
	if (!isPlainObject(raw) || raw.schemaVersion !== TARGET_SCHEMA_VERSION) {
		return { error: `unsupported or missing schema version (wanted ${TARGET_SCHEMA_VERSION})` };
	}
	const name = typeof raw.name === "string" ? raw.name : "target";
	const kind = raw.kind === "attach" ? ("attach" as const) : ("launch" as const);
	return {
		schemaVersion: TARGET_SCHEMA_VERSION,
		name,
		kind,
		program: kind === "launch" && typeof raw.program === "string" ? raw.program : undefined,
		args: Array.isArray(raw.args) ? raw.args.map(String) : [],
		pid: kind === "attach" && typeof raw.pid === "number" ? raw.pid : undefined,
		savedAt: typeof raw.savedAt === "number" ? raw.savedAt : Date.now(),
	};
}

function readLayout(raw: unknown): LayoutState | { error: string } {
	if (!isPlainObject(raw) || raw.schemaVersion !== LAYOUT_SCHEMA_VERSION) {
		return { error: `unsupported or missing schema version (wanted ${LAYOUT_SCHEMA_VERSION})` };
	}
	const name = typeof raw.name === "string" ? raw.name : "layout";
	const splitTree = isPlainObject(raw.splitTree) ? (raw.splitTree as unknown as SplitTreeData) : { root: "repl", active: "repl" };
	const watchPanes: SessionWatchPanes = {};
	if (isPlainObject(raw.watchPanes)) {
		for (const [paneId, value] of Object.entries(raw.watchPanes)) {
			if (!isPlainObject(value) || !Array.isArray(value.entries)) continue;
			const entries: SessionWatchEntry[] = value.entries
				.filter(isPlainObject)
				.map((entry) => ({
					expr: typeof entry.expr === "string" ? entry.expr : "",
					renderSpec: isPlainObject(entry.renderSpec)
						? {
								rendererId: String(entry.renderSpec.rendererId ?? "lines"),
								flags: typeof entry.renderSpec.flags === "number" ? entry.renderSpec.flags : undefined,
								options: entry.renderSpec.options as RenderSpec["options"] | undefined,
							}
						: { rendererId: "lines" },
					byteCount: typeof entry.byteCount === "number" ? entry.byteCount : 192,
				}))
				.filter((entry) => entry.expr);
			if (entries.length > 0) watchPanes[paneId] = { entries };
		}
	}
	return {
		schemaVersion: LAYOUT_SCHEMA_VERSION,
		name,
		splitTree,
		watchPanes,
		savedAt: typeof raw.savedAt === "number" ? raw.savedAt : Date.now(),
	};
}

function readSession(raw: unknown): SessionState | { error: string } {
	if (!isPlainObject(raw) || raw.schemaVersion !== SESSION_SCHEMA_VERSION) {
		return { error: `unsupported or missing schema version (wanted ${SESSION_SCHEMA_VERSION})` };
	}
	const name = typeof raw.name === "string" ? raw.name : "session";
	const breakPoints: SessionBreakpoint[] = Array.isArray(raw.breakPoints)
		? raw.breakPoints.filter(isPlainObject).map((bp) => ({
				file: typeof bp.file === "string" ? bp.file : undefined,
				line: typeof bp.line === "number" ? bp.line : undefined,
				condition: typeof bp.condition === "string" ? bp.condition : undefined,
				verified: bp.verified !== false,
				location: typeof bp.location === "string" ? bp.location : undefined,
			}))
		: [];
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		name,
		id: typeof raw.id === "string" && raw.id ? raw.id : undefined,
		target: typeof raw.target === "string" ? raw.target : null,
		layout: typeof raw.layout === "string" ? raw.layout : null,
		breakPoints,
		savedAt: typeof raw.savedAt === "number" ? raw.savedAt : Date.now(),
	};
}

/* ------------------------------------------------------------ keyed json store */

/**
 * Namespace an implicit profile (`@<key>`) so a fresh session never writes
 * into a shared default that another session references. Explicit profiles
 * (set via running a program / `/layout save`) come through unchanged.
 */
export function sessionScopedName(key: string): string {
	return `@${key}`;
}

/** A fresh stable per-session id (UUID). */
import { randomUUID } from "node:crypto";
export function newSessionId(): string {
	return randomUUID();
}

export interface StoreMeta {
	name: string;
	file: string;
	savedAt?: number;
}

/** Read + transform one validated doc into display metadata. */
type MetaFn<S, M> = (state: S, file: string) => M;

/**
 * One named-key JSON store: writes atomically (tmp + rename), validates against
 * a schema version on read, degrades corrupt/stale files to a clear error, and
 * lists valid docs as metadata.
 */
class JsonStore<S extends { name: string; schemaVersion: number; savedAt: number }, M extends StoreMeta> {
	readonly dir: string;
	readonly schemaVersion: number;
	private active: { name: string; file: string } | null = null;
	private readonly read: (raw: unknown) => S | { error: string };
	private readonly meta: (state: S, file: string) => M;

	constructor(
		dir: string,
		schemaVersion: number,
		read: (raw: unknown) => S | { error: string },
		meta: (state: S, file: string) => M,
	) {
		this.dir = dir;
		this.schemaVersion = schemaVersion;
		this.read = read;
		this.meta = meta;
	}

	get label(): string {
		return path.basename(this.dir);
	}

	private ensureDir(): void {
		fs.mkdirSync(this.dir, { recursive: true });
	}
	private fileFor(name: string): string {
		return path.join(this.dir, `${sanitize(name)}.json`);
	}

	setActive(name: string): void {
		this.ensureDir();
		this.active = { name, file: this.fileFor(name) };
	}
	clearActive(): void {
		this.active = null;
	}
	activeName(): string | null {
		return this.active?.name ?? null;
	}
	activePath(): string | null {
		return this.active?.file ?? null;
	}
	pathFor(name: string): string {
		return this.fileFor(name);
	}

	/** Read + validate one doc. `{ error }` for missing/corrupt/stale. */
	load(name: string): { state: S; file: string } | { error: string } {
		const file = this.fileFor(name);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			return { error: `no ${this.label} '${name}'` };
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return { error: `${this.label} '${name}': not valid JSON` };
		}
		const result = this.read(raw);
		if ("error" in result) return { error: result.error };
		return { state: result, file: this.fileFor(result.name) };
	}

	/** Metadata for every valid doc; corrupt/stale files are skipped. */
	list(): M[] {
		let files: string[];
		try {
			files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
		const out: M[] = [];
		for (const f of files) {
			const file = path.join(this.dir, f);
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				continue;
			}
			const result = this.read(raw);
			if (!("error" in result)) out.push(this.meta(result, file));
		}
		return out.sort((a, b) => String(a.savedAt ?? 0).localeCompare(String(b.savedAt ?? 0)));
	}

	/** Atomic write. Resolves after the rename. */
	async save(state: S): Promise<void> {
		this.ensureDir();
		const file = this.fileFor(state.name);
		const payload = JSON.stringify(state, null, 2);
		const tmp = `${file}.tmp`;
		await fs.promises.writeFile(tmp, payload);
		await fs.promises.rename(tmp, file);
		this.active = { name: state.name, file };
	}

	async remove(name: string): Promise<void> {
		const file = this.fileFor(name);
		try {
			fs.unlinkSync(file);
		} catch {
			/* already gone — fine */
		}
		if (this.active?.name === name) this.active = null;
	}
}

/* --------------------------------------------------------------- stores bundle */

export interface StateStores {
	sessions: JsonStore<SessionState, SessionMeta>;
	targets: JsonStore<TargetState, TargetMeta>;
	layouts: JsonStore<LayoutState, LayoutMeta>;
	/** The shared workspace root they hang under (parent of the sessions dir). */
	root: string;
}

/** Build the three stores bound to the sessions dir (targets/layouts are siblings). */
export function createStores(sessionDir: string): StateStores {
	const parent = path.dirname(sessionDir);
	const targetMetaFn = (a: TargetState, file: string): TargetMeta => ({
		name: a.name, file, savedAt: a.savedAt, kind: a.kind, program: a.program, args: a.args, pid: a.pid,
	});
	const layoutMetaFn = (a: LayoutState, file: string): LayoutMeta => ({
		name: a.name, file, savedAt: a.savedAt,
		panes: layoutPaneCount(a.splitTree),
		watchEntries: Object.values(a.watchPanes).reduce((n, p) => n + p.entries.length, 0),
		splitTree: a.splitTree,
		watchPanes: a.watchPanes,
	});
	const sessionMetaFn = (a: SessionState, file: string): SessionMeta => ({
		name: a.name, file, savedAt: a.savedAt,
		target: a.target ?? undefined, layout: a.layout ?? undefined,
		breakpoints: a.breakPoints.length,
		breakPoints: a.breakPoints,
	});
	return {
		sessions: new JsonStore(sessionDir, SESSION_SCHEMA_VERSION, readSession, sessionMetaFn),
		targets: new JsonStore(path.join(parent, "targets"), TARGET_SCHEMA_VERSION, readTarget, targetMetaFn),
		layouts: new JsonStore(path.join(parent, "layouts"), LAYOUT_SCHEMA_VERSION, readLayout, layoutMetaFn),
		root: parent,
	};
}