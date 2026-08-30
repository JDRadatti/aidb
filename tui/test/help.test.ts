import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleReplInput, type ReplContext, type ReplIO } from "../src/repl.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

function makeContext() {
	const messages: string[] = [];
	const io: ReplIO = {
		line: (text) => messages.push(text),
		info: (text) => messages.push(text),
		success: (text) => messages.push(text),
		warning: (text) => messages.push(text),
		error: (text) => messages.push(text),
	};
	const ctx: ReplContext = {
		getApi: () => ({}) as never,
		reset: async () => ({}) as never,
		requestExit: () => {},
		requestRender: () => {},
		io,
		windows: {} as never,
		config: DEFAULT_CONFIG,
		configSources: { issues: [], sectionOrigin: {} as never },
		reloadConfig: () => ({ config: DEFAULT_CONFIG, sources: { issues: [], sectionOrigin: {} as never } }),
	};
	return { ctx, messages };
}

describe("help", () => {
	it("bare help mentions windows and points at the topic", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("help", ctx);
		const text = messages.join("\n");
		assert.match(text, /\/win vsplit/);
		assert.match(text, /help win/);
	});

	it("help win documents indexed panes and prompt-only control", async () => {
		for (const input of ["help win", "/help win", "h win"]) {
			const { ctx, messages } = makeContext();
			await handleReplInput(input, ctx);
			const text = messages.join("\n");
			assert.match(text, /\/win switch \x1b\[38;5;245m<idx\|name>\x1b\[0m/, `${input}: missing /win switch`);
			assert.match(text, /vsplit/, `${input}: missing vsplit`);
			assert.match(text, /indices/, `${input}: missing index warning`);
		}
	});

	it("unknown topics say so instead of dumping the general sheet", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("help florb", ctx);
		assert.match(messages.join("\n"), /No help topic 'florb'/);
	});

	it("substitutes action key tokens but keeps arg placeholders, tinted lighter", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("help", ctx);
		const text = messages.join("\n");
		// `<stepOver>` is an ACTION token → replaced by the bound chord.
		assert.match(text, /F11/, "<stepOver> becomes its chord label");
		assert.ok(!text.includes("<stepOver>"), "action tokens never survive into the sheet");
		// `<expr>` is an ARG placeholder → survives verbatim and gets the
		// lighter placeholder colour (the old fillKeys turned it into "—").
		assert.match(text, /print \x1b\[38;5;245m<expr>\x1b\[0m/, "arg placeholder tinted, not mangled");
		assert.ok(!/print —/.test(text), "args are no longer replaced with em-dashes");
	});

	it("help win tints its placeholders too", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("help win", ctx);
		const text = messages.join("\n");
		assert.match(text, /\x1b\[38;5;245m<idx\|name>\x1b\[0m/, "WIN_HELP placeholders are tinted");
	});
});
