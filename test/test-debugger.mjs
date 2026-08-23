/**
 * Test script for debugger-core.
 * Uses the standalone API (no Pi needed) to debug a real C program.
 *
 * Run: node --import tsx test/test-debugger.mjs
 */

import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDebugger } from "../debugger-core/src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
	const programPath = join(__dirname, "test");
	const sourcePath = join(__dirname, "test.c");

	// Step 0: Compile the test program
	console.log("=== Step 0: Compiling test.c ===");
	try {
		execSync(`gcc -g -o "${programPath}" "${sourcePath}"`, { stdio: "pipe" });
		console.log("Compiled successfully.");
	} catch (e) {
		console.error("Compilation failed:", e.stderr?.toString());
		process.exit(1);
	}

	// Step 1: Create debugger instance
	console.log("\n=== Step 1: Creating debugger ===");
	const { api, eventBus, cleanup } = createDebugger({
		cwd: __dirname,
	});

	// Listen for events
	eventBus.on("output", (data) => {
		if (data.category === "stdout" || data.category === "console") {
			process.stdout.write(`[GDB] ${data.output}`);
		}
	});

	eventBus.on("stopped", (data) => {
		console.log(`\n[STOPPED] Reason: ${data.reason}`);
	});

	eventBus.on("session:running", () => {
		console.log("[RUNNING]");
	});

	try {
		// Step 2: Set breakpoint on the buggy line (line 12: sum += arr[i]).
		// Must be done before launch; this also starts GDB.
		console.log("\n=== Step 2: Setting breakpoint on line 12 (the bug) ===");
		const bp = await api.setBreakpoint(sourcePath, 12);
		console.log("Breakpoint set:", bp);

		// Step 3: Launch the program (it stops at the breakpoint)
		console.log("\n=== Step 3: Launching program ===");
		await api.launch(programPath);

		// Wait a bit for the breakpoint to be hit
		await new Promise((r) => setTimeout(r, 1000));
		console.log("State:", api.getState());

		// Step 4: Check the stack
		console.log("\n=== Step 4: Stack trace ===");
		const stack = await api.getStack();
		for (const frame of stack) {
			console.log(`  #${frame.id} ${frame.name} at ${frame.file}:${frame.line}`);
		}

		// Step 5: Get local variables
		console.log("\n=== Step 5: Local variables ===");
		const vars = await api.getVariables("local");
		for (const v of vars) {
			console.log(`  ${v.name} = ${v.value} (${v.type})`);
		}

		// Step 6: Evaluate an expression
		console.log("\n=== Step 6: Evaluate expression ===");
		const sumVal = await api.evaluate("sum");
		console.log(`  sum = ${sumVal}`);
		const iVal = await api.evaluate("i");
		console.log(`  i = ${iVal}`);

		// Step 7: Step over a few times
		console.log("\n=== Step 7: Step over 3 times ===");
		for (let s = 0; s < 3; s++) {
			await api.stepOver();
			await new Promise((r) => setTimeout(r, 500));
			const varsNow = await api.getVariables("local");
			const iNow = varsNow.find((v) => v.name === "i");
			const sumNow = varsNow.find((v) => v.name === "sum");
			console.log(`  Step ${s + 1}: i=${iNow?.value}, sum=${sumNow?.value}`);
		}

		// Step 8: Remove breakpoints so the run can finish
		console.log("\n=== Step 8: Removing breakpoints ===");
		for (const b of await api.listBreakpoints()) {
			await api.removeBreakpoint(b.id);
			console.log(`  Removed breakpoint ${b.id}`);
		}

		// Step 9: Continue to finish
		console.log("\n=== Step 9: Continue to program end ===");
		await api.continue();
		await new Promise((r) => setTimeout(r, 1000));
		console.log("State:", api.getState());

		// Step 10: Cleanup
		console.log("\n=== Step 10: Cleanup ===");
		await cleanup();
		console.log("Done!");
	} catch (error) {
		console.error("\n=== ERROR ===");
		console.error(error);
		await cleanup();
		process.exit(1);
	}
}

main();
