// Smoke test: run the watch-pane evaluation + formatting path against a REAL
// gdb session. Exercises: ExpressionBinding (with tree expansion), auto
// dispatch, and every per-type renderer.
// Run: node --experimental-strip-types test/smoke-watch.mjs
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDebugger } from "../debugger-core/src/index.ts";
import { ExpressionBinding } from "../tui/src/viz/bindings.ts";
import { LocalsBinding } from "../tui/src/viz/bindings.ts";
import { INTERPRETERS, dispatchRenderer, renderInterpreter } from "../tui/src/viz/interpreters.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "smoke-watch");
const sourcePath = join(__dirname, "smoke-watch.c");

const source = `
#include <stdio.h>
#include <stdbool.h>
struct Point { int x; int y; };
struct Player { int hp; struct Point pos; char name[16]; };
int main(void) {
  int hp = 104;
  bool alive = 1;
  float pi = 3.1400000000000001;
  char letter = 'A';
  struct Player p = { 99, { 3, 4 }, { 'h', 'e', 'y' } };
  struct Player *pp = &p;
  int ints[4] = { 10, 20, 30, 40 };
  char msg[16] = "hello";
  const char *str = "world";
  (void)hp; (void)alive; (void)pi; (void)letter; (void)p; (void)pp; (void)ints; (void)msg; (void)str;
  for (int i = 0; i < 10; i++) { hp += i; }
  printf("%d\\n", hp);
  return 0;
}
`;
execSync(`cat > "${sourcePath}"`, { input: source });
execSync(`gcc -g -O0 -o "${programPath}" "${sourcePath}"`);

const { api, eventBus, cleanup } = createDebugger({ cwd: __dirname });
eventBus.on("output", (d) => { if (d.category === "stdout" || d.category === "console") process.stdout.write(`[GDB] ${d.output}`); });
const stopped = new Promise((resolve) => eventBus.on("stopped", resolve));

const fetchCtx = {
	evaluate: (e, c) => api.evaluate(e, c ?? "watch"),
	evaluateDetailed: (e) => api.evaluateDetailed(e),
	getVariableChildren: (ref, start, count) =>
		api.getVariableChildren(ref, start, count).then((variables) =>
			variables.map((v) => ({
				name: v.name,
				value: v.value,
				type: v.type || undefined,
				evaluateName: v.evaluateName,
				memoryReference: v.memoryReference,
				variablesReference: v.variablesReference,
				namedVariables: v.namedVariables,
				indexedVariables: v.indexedVariables,
				presentationHint: v.presentationHint,
				hasChildren: v.variablesReference > 0,
				ref: v.variablesReference > 0 ? v.variablesReference : undefined,
			})),
		),
	getFrameVariables: (scope) =>
		api.getVariables(scope ?? "local").then((variables) =>
			variables.map((v) => ({
				name: v.name,
				value: v.value,
				type: v.type || undefined,
				evaluateName: v.evaluateName,
				memoryReference: v.memoryReference,
				variablesReference: v.variablesReference,
				namedVariables: v.namedVariables,
				indexedVariables: v.indexedVariables,
				presentationHint: v.presentationHint,
				hasChildren: v.variablesReference > 0,
				ref: v.variablesReference > 0 ? v.variablesReference : undefined,
			})),
		),
	readMemory: (e, count, offset) => api.readMemory(e, count, offset),
};

const RECT = { width: 80, height: 24 };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function show(label, expr) {
	const snap = await new ExpressionBinding(expr).fetch(fetchCtx);
	const best = dispatchRenderer(snap) ?? "lines";
	console.log(`\n### ${label}  <=  /watch ${expr}`);
	console.log(`type: ${snap.type}   value(raw): ${JSON.stringify(snap.value)}   best renderer: ${best}`);
	const lines = renderInterpreter(INTERPRETERS[best], snap, undefined, RECT);
	console.log(lines.map(strip).slice(0, 8).join("\n"));
}

async function showLocals(label) {
	const snap = await new LocalsBinding().fetch(fetchCtx);
	console.log(`\n### ${label}  <=  /win load 0 locals`);
	console.log(`kind: ${snap.kind}   error: ${snap.error ?? "-"}`);
	const lines = renderInterpreter(INTERPRETERS["struct-tree"], snap, undefined, RECT);
	console.log(lines.map(strip).slice(0, 24).join("\n"));
}

try {
	await api.setBreakpoint(sourcePath, 17);
	await api.launch(programPath);
	await stopped;
	await show("char scalar", "letter");
	await show("bool", "alive");
	await show("float", "pi");
	await show("struct", "p");
	await show("struct pointer", "pp");
	await show("int array", "ints");
	await show("char array", "msg");
	await show("const char *", "str");
	await show("int scalar", "hp");
	await showLocals("frame locals after stopping");
	// A struct inside a function shows nested expansion off the frame list.
	await show("struct member via frame", "p.pos");
} finally {
	await api.quit();
	cleanup();
	execSync(`rm -f "${programPath}" "${sourcePath}"`);
}