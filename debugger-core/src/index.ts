/**
 * Pi Debugger Core Extension
 *
 * Core GDB debugger extension for Pi. Provides:
 * - DAP protocol client for GDB
 * - Session state management
 * - Event bus for debugger events
 * - REPL bridge for GDB commands
 * - /debug commands for session control
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DapClient } from "./dap-client.ts";
import { DebuggerEventBus } from "./event-bus.ts";
import { SessionStateMachine } from "./session.ts";
import { createDebuggerAPI, isGdbCommand } from "./repl-bridge.ts";
import type { DebuggerAPI, DapClientConfig } from "./types.ts";

// Re-export types
export type { Breakpoint, DebuggerAPI, DebuggerEvents, DapClientConfig, SessionState, StackFrame, Variable } from "./types.ts";

// Re-export classes
export { DapClient } from "./dap-client.ts";
export { DebuggerEventBus } from "./event-bus.ts";
export { SessionStateMachine } from "./session.ts";

/**
 * Create a debugger instance.
 * This can be used standalone (without Pi) or wrapped as an extension.
 */
export function createDebugger(config: DapClientConfig = {}): {
	api: DebuggerAPI;
	cleanup: () => Promise<void>;
	eventBus: DebuggerEventBus;
} {
	const eventBus = new DebuggerEventBus();
	const stateMachine = new SessionStateMachine(eventBus);
	const dapClient = new DapClient(eventBus, config);
	const api = createDebuggerAPI(dapClient, eventBus, stateMachine);

	return {
		api,
		eventBus,
		cleanup: async () => {
			try {
				await dapClient.stop();
			} catch {
				// Ignore cleanup errors
			}
			eventBus.clear();
		},
	};
}

/**
 * Default export: Pi extension factory.
 * Registers debugger commands and REPL bridge.
 */
export default function debuggerCoreExtension(pi: ExtensionAPI) {
	let debuggerInstance: ReturnType<typeof createDebugger> | null = null;

	function getDebugger() {
		if (!debuggerInstance) {
			debuggerInstance = createDebugger();
		}
		return debuggerInstance;
	}

	pi.registerCommand("debug", {
		description: "Debugger control (usage: /debug start|stop|status|attach)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["start", "stop", "status", "attach"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.map((s) => ({ value: s, label: s }));
		},
		handler: async (args: string, ctx: any) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] ?? "status";
			const rest = parts.slice(1).join(" ");

			const { api } = getDebugger();

			switch (subcommand) {
				case "start": {
					const progParts = rest.split(/\s+/);
					if (!progParts[0]) {
						ctx.ui.notify("Usage: /debug start <program> [args...]", "error");
						return;
					}
					try {
						ctx.ui.notify(`Starting debugger for ${progParts[0]}...`, "info");
						await api.launch(progParts[0], progParts.slice(1));
						ctx.ui.notify(`Debugger started. Program: ${progParts[0]}`, "info");
					} catch (error) {
						ctx.ui.notify(`Failed to start debugger: ${error}`, "error");
					}
					break;
				}

				case "stop": {
					try {
						await api.quit();
						ctx.ui.notify("Debugger stopped", "info");
					} catch (error) {
						ctx.ui.notify(`Failed to stop debugger: ${error}`, "error");
					}
					break;
				}

				case "status": {
					const state = api.getState();
					const breakpoints = api.breakpoints.size;
					const source = api.sourceFile ?? "none";
					ctx.ui.notify(
						`State: ${state}\nBreakpoints: ${breakpoints}\nSource: ${source}`,
						"info",
					);
					break;
				}

				case "attach": {
					const pid = parseInt(rest.trim(), 10);
					if (isNaN(pid)) {
						ctx.ui.notify("Usage: /debug attach <pid>", "error");
						return;
					}
					try {
						ctx.ui.notify(`Attaching to process ${pid}...`, "info");
						await api.attach(pid);
						ctx.ui.notify(`Attached to process ${pid}`, "info");
					} catch (error) {
						ctx.ui.notify(`Failed to attach: ${error}`, "error");
					}
					break;
				}

				default:
					ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: start, stop, status, attach`, "error");
			}
		},
	});

	pi.registerCommand("step", {
		description: "Step into (alias for GDB step)",
		handler: async (_args: string, ctx: any) => {
			const { api } = getDebugger();
			if (api.getState() !== "stopped") {
				ctx.ui.notify("Debugger is not stopped", "error");
				return;
			}
			try {
				await api.stepInto();
			} catch (error) {
				ctx.ui.notify(`Step failed: ${error}`, "error");
			}
		},
	});

	pi.registerCommand("next", {
		description: "Step over (alias for GDB next)",
		handler: async (_args: string, ctx: any) => {
			const { api } = getDebugger();
			if (api.getState() !== "stopped") {
				ctx.ui.notify("Debugger is not stopped", "error");
				return;
			}
			try {
				await api.stepOver();
			} catch (error) {
				ctx.ui.notify(`Next failed: ${error}`, "error");
			}
		},
	});

	pi.registerCommand("finish", {
		description: "Step out (alias for GDB finish)",
		handler: async (_args: string, ctx: any) => {
			const { api } = getDebugger();
			if (api.getState() !== "stopped") {
				ctx.ui.notify("Debugger is not stopped", "error");
				return;
			}
			try {
				await api.stepOut();
			} catch (error) {
				ctx.ui.notify(`Finish failed: ${error}`, "error");
			}
		},
	});

	pi.registerCommand("continue", {
		description: "Continue execution (alias for GDB continue)",
		handler: async (_args: string, ctx: any) => {
			const { api } = getDebugger();
			if (api.getState() !== "stopped") {
				ctx.ui.notify("Debugger is not stopped", "error");
				return;
			}
			try {
				await api.continue();
			} catch (error) {
				ctx.ui.notify(`Continue failed: ${error}`, "error");
			}
		},
	});

	pi.on("session_shutdown", async () => {
		if (debuggerInstance) {
			await debuggerInstance.cleanup();
			debuggerInstance = null;
		}
	});
}
