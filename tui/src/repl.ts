import type { DebuggerAPI } from "@earendil-works/pi-debugger-core";

export interface ReplIO {
	line(text: string): void;
	info(text: string): void;
	success(text: string): void;
	error(text: string): void;
}

export interface ReplContext {
	getApi(): DebuggerAPI;
	reset(): Promise<DebuggerAPI>;
	requestExit(): void;
	io: ReplIO;
}

const HELP = [
	"aidb commands:",
	"  /launch <program> [args...]   start a new debug session",
	"  /attach <pid>                 attach to a running process",
	"  /break <file:line> [cond]     set a breakpoint",
	"  /breaks                       list breakpoints",
	"  /remove <id>                  remove a breakpoint",
	"  /step (F11)                   step into",
	"  /next (F10)                   step over",
	"  /finish (Shift+F11)           step out",
	"  /continue (F5)                continue execution",
	"  /stack                        print the call stack",
	"  /locals                       print local variables",
	"  /status                       session summary",
	"  /quit                         quit aidb",
	"",
	"Anything else is sent to GDB verbatim (print x, info registers, ...).",
].join("\n");

function requireStopped(api: DebuggerAPI, io: ReplIO): boolean {
	if (api.getState() !== "stopped") {
		io.error("Target is not stopped. Use /continue first, or wait for a breakpoint.");
		return false;
	}
	return true;
}

async function passthrough(input: string, api: DebuggerAPI, io: ReplIO): Promise<void> {
	const result = await api.evaluate(input, "repl");
	if (result !== undefined && result !== "") {
		io.line(String(result));
	}
}

export async function handleReplInput(rawInput: string, ctx: ReplContext): Promise<void> {
	const input = rawInput.trim();
	if (!input) return;

	const io = ctx.io;

	try {
		if (!input.startsWith("/")) {
			await passthrough(input, ctx.getApi(), io);
			return;
		}

		const words = input.slice(1).split(/\s+/);
		const command = words[0] ?? "";
		const rest = words.slice(1);
		const args = rest.join(" ");
		let api = ctx.getApi();

		switch (command) {
			case "help":
				io.line(HELP);
				break;

			case "launch": {
				const program = rest[0];
				if (!program) {
					io.error("Usage: /launch <program> [args...]");
					return;
				}
				const state = api.getState();
				if (!["not-started", "error", "detached", "exited"].includes(state)) {
					io.info(`Stopping current session (${state}) first...`);
					api = await ctx.reset();
				}
				io.info(`Launching ${program}...`);
				await api.launch(program, rest.slice(1));
				break;
			}

			case "attach": {
				const pid = Number.parseInt(rest[0] ?? "", 10);
				if (Number.isNaN(pid)) {
					io.error("Usage: /attach <pid>");
					return;
				}
				io.info(`Attaching to ${pid}...`);
				await api.attach(pid);
				break;
			}

			case "break": {
				const match = args.match(/^(\S+?):(\d+)(?:\s+(.+))?$/);
				if (!match) {
					io.error("Usage: /break <file:line> [condition]");
					return;
				}
				const bp = await api.setBreakpoint(match[1], Number.parseInt(match[2], 10), match[3]);
				io.success(
					bp.verified
						? `Breakpoint ${bp.id} at ${bp.file}:${bp.line}`
						: `Breakpoint ${bp.id} pending at ${bp.file}:${bp.line}`,
				);
				break;
			}

			case "breaks": {
				const bps = await api.listBreakpoints();
				if (bps.length === 0) {
					io.info("No breakpoints.");
					return;
				}
				for (const bp of bps) {
					io.line(`${bp.id}\t${bp.file}:${bp.line}${bp.condition ? ` if ${bp.condition}` : ""}`);
				}
				break;
			}

			case "remove": {
				const id = Number.parseInt(rest[0] ?? "", 10);
				if (Number.isNaN(id)) {
					io.error("Usage: /remove <breakpoint-id>");
					return;
				}
				await api.removeBreakpoint(id);
				io.success(`Removed breakpoint ${id}`);
				break;
			}

			case "step":
				if (requireStopped(api, io)) await api.stepInto();
				break;

			case "next":
				if (requireStopped(api, io)) await api.stepOver();
				break;

			case "finish":
				if (requireStopped(api, io)) await api.stepOut();
				break;

			case "continue":
				if (requireStopped(api, io)) await api.continue();
				break;

			case "stack": {
				if (!requireStopped(api, io)) return;
				const frames = await api.getStack();
				frames.forEach((frame, i) => {
					io.line(`#${i} ${frame.name} at ${frame.file || "?"}:${frame.line}`);
				});
				break;
			}

			case "locals": {
				if (!requireStopped(api, io)) return;
				const vars = await api.getVariables("local");
				if (vars.length === 0) {
					io.info("No locals.");
					return;
				}
				for (const v of vars) {
					io.line(`${v.name} = ${v.value}`);
				}
				break;
			}

			case "status": {
				const state = api.getState();
				const location = api.sourceFile ? `${api.sourceFile}:${api.currentLine}` : "no location";
				io.line(`state: ${state} | breakpoints: ${api.breakpoints.size} | thread: ${api.activeThreadId} | ${location}`);
				break;
			}

			case "quit":
				io.info("Shutting down...");
				ctx.requestExit();
				break;

			default:
				io.error(`Unknown command: /${command}. Type /help for commands.`);
		}
	} catch (error) {
		io.error(error instanceof Error ? error.message : String(error));
	}
}
