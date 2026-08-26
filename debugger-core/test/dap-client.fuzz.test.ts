import { describe, expect, it } from "vitest";
import { DapClient } from "../src/dap-client.ts";
import { DebuggerEventBus } from "../src/event-bus.ts";

function frame(message: object): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function random(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value = (value * 1664525 + 1013904223) >>> 0;
		return value;
	};
}

describe("DAP frame parser fuzzing", () => {
	it("parses valid frames across randomized chunk boundaries", () => {
		const next = random(0xc0ffee);
		const received: string[] = [];
		const bus = new DebuggerEventBus();
		bus.on("output", ({ output }) => received.push(output));
		const client = new DapClient(bus);

		for (let i = 0; i < 500; i++) {
			const output = `value-${i}-🙂-${next()}`;
			const bytes = frame({ seq: i + 1, type: "event", event: "output", body: { category: "console", output } });
			let offset = 0;
			while (offset < bytes.length) {
				const size = 1 + (next() % 23);
				const end = Math.min(offset + size, bytes.length);
				(client as any).handleData(bytes.subarray(offset, end));
				offset = end;
			}
		}

		expect(received).toEqual(Array.from({ length: 500 }, (_, i) => expect.any(String)));
		expect(received).toHaveLength(500);
		expect(received[123]).toContain("value-123-");
	});

	it("never throws on arbitrary bytes, malformed headers, or garbage", () => {
		const next = random(0xdecafbad);
		const client = new DapClient(new DebuggerEventBus(), { maxDapFrameSize: 256 });

		expect(() => {
			for (let i = 0; i < 1000; i++) {
				const size = next() % 320;
				const bytes = Buffer.alloc(size);
				for (let j = 0; j < size; j++) bytes[j] = next() & 0xff;
				(client as any).handleData(bytes);
			}
			(client as any).handleData(Buffer.from("Content-Length: nope\r\n\r\nnot-json"));
			(client as any).handleData(Buffer.from("Content-Length: 999999999\r\n\r\n"));
		}).not.toThrow();
	});
});
