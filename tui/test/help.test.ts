import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleReplInput, type ReplContext, type ReplIO } from "../src/repl.ts";

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
		io,
		windows: {} as never,
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
			assert.match(text, /\/switch <idx>/, `${input}: missing /switch`);
			assert.match(text, /vsplit/, `${input}: missing vsplit`);
			assert.match(text, /indices/, `${input}: missing index warning`);
		}
	});

	it("unknown topics say so instead of dumping the general sheet", async () => {
		const { ctx, messages } = makeContext();
		await handleReplInput("help florb", ctx);
		assert.match(messages.join("\n"), /No help topic 'florb'/);
	});
});
