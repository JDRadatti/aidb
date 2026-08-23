/**
 * /debug start command - Start a debugging session.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DebuggerAPI } from "../types.ts";

/**
 * Create the /debug start command.
 */
export function createDebugStartCommand(debuggerAPI: DebuggerAPI) {
	return {
		description: "Start a debugging session (usage: /debug start <program> [args...])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			if (parts.length === 0 || !parts[0]) {
				ctx.ui.notify("Usage: /debug start <program> [args...]", "error");
				return;
			}

			const program = parts[0];
			const programArgs = parts.slice(1);

			try {
				ctx.ui.notify(`Starting debugger for ${program}...`, "info");
				await debuggerAPI.launch(program, programArgs);
				ctx.ui.notify(`Debugger started. Program: ${program}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to start debugger: ${error}`, "error");
			}
		},
	};
}

/**
 * Create the /debug attach command.
 */
export function createDebugAttachCommand(debuggerAPI: DebuggerAPI) {
	return {
		description: "Attach to a running process (usage: /debug attach <pid>)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const pid = parseInt(args.trim(), 10);
			if (isNaN(pid)) {
				ctx.ui.notify("Usage: /debug attach <pid>", "error");
				return;
			}

			try {
				ctx.ui.notify(`Attaching to process ${pid}...`, "info");
				await debuggerAPI.attach(pid);
				ctx.ui.notify(`Attached to process ${pid}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to attach: ${error}`, "error");
			}
		},
	};
}

/**
 * Create the /debug stop command.
 */
export function createDebugStopCommand(debuggerAPI: DebuggerAPI) {
	return {
		description: "Stop the current debugging session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				await debuggerAPI.quit();
				ctx.ui.notify("Debugger stopped", "info");
			} catch (error) {
				ctx.ui.notify(`Failed to stop debugger: ${error}`, "error");
			}
		},
	};
}

/**
 * Create the /debug status command.
 */
export function createDebugStatusCommand(debuggerAPI: DebuggerAPI) {
	return {
		description: "Show current debugger status",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const state = debuggerAPI.getState();
			const breakpoints = debuggerAPI.breakpoints.size;
			const source = debuggerAPI.sourceFile ?? "none";

			ctx.ui.notify(
				`State: ${state}\nBreakpoints: ${breakpoints}\nSource: ${source}`,
				"info",
			);
		},
	};
}
