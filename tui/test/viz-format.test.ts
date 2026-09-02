import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrayTypeLabel, cleanupStringResult, collapseValue, formatCharCode, formatValue } from "../src/viz/format.ts";

describe("formatValue", () => {
	it("formats char scalars with a glyph", () => {
		assert.equal(formatValue("65", "char"), "65 'A'");
		assert.equal(formatValue("104", "unsigned char"), "104 'h'");
		assert.equal(formatValue("10", "char"), "10 '\\n'");
		// gdb often formats char itself — keep its shape untouched.
		assert.equal(formatValue("99 'c'", "char"), "99 'c'");
		assert.equal(formatValue("'A'", "char"), "'A'");
		// ints are not chars, even when the value looks like one.
		assert.equal(formatValue("65", "int"), "65");
	});

	it("maps bool 0/1 to true/false, keeping already-named values", () => {
		assert.equal(formatValue("1", "_Bool"), "true");
		assert.equal(formatValue("0", "bool"), "false");
		assert.equal(formatValue("true", "bool"), "true");
	});

	it("cleans char-array nul padding but keeps real strings", () => {
		assert.equal(formatValue('"hello\\000\\000\\377"', "char [16]"), '"hello"');
		// An embedded nul is still a terminator for the C-string form.
		assert.equal(formatValue('"hello\\000world"', "char [12]"), '"hello"');
		assert.equal(formatValue('"hello world"', "char *"), '"hello world"');
		assert.equal(formatValue('"a b"', "char [4]"), '"a b"');
	});

	it("rounds noisy float to-strings", () => {
		assert.equal(formatValue("3.1400000000000001", "float"), "3.14");
		assert.equal(formatValue("1.1", "double"), "1.1");
		assert.equal(formatValue("0x10", "float"), "0x10");
	});

	it("collapses gdb's padded whitespace and truncates long values", () => {
		assert.equal(formatValue("RED  ", "enum Color"), "RED");
		assert.equal(formatValue("0x5555555550a0  <main+20>", "void *"), "0x5555555550a0 <main+20>");
		const long = formatValue("a".repeat(200), undefined, 20);
		assert.ok(long.endsWith("…"));
		assert.ok(long.length <= 20);
	});

	it("falls back gracefully for empty and undefined values", () => {
		assert.equal(formatValue(""), "");
		assert.equal(formatValue(undefined), "—");
		assert.equal(formatValue("", "int [4]"), "");
	});
});

describe("format helpers", () => {
	it("formatCharCode builds C escapes for control characters", () => {
		assert.equal(formatCharCode(65), "65 'A'");
		assert.equal(formatCharCode(10), "10 '\\n'");
		assert.equal(formatCharCode(0), "0 '\\0'");
		assert.equal(formatCharCode(31), "31 '\\x1f'");
	});

	it("cleanupStringResult only strips nul padding from quoted literals", () => {
		assert.equal(cleanupStringResult('"hi\\000\\000\\377"'), '"hi"');
		assert.equal(cleanupStringResult("42"), "42");
	});

	it("collapseValue collapses and trims", () => {
		assert.equal(collapseValue("  a   b\tc  "), "a b c");
	});

	it("arrayTypeLabel shortens templates and adds counts", () => {
		assert.equal(arrayTypeLabel("int [4]"), "int [4]");
		assert.equal(arrayTypeLabel("struct Pixel [4]"), "struct Pixel [4]");
		assert.equal(arrayTypeLabel("std::vector<int, std::allocator<int> >", 4), "std::vector<…> · 4 elements");
		assert.equal(arrayTypeLabel(undefined, 3), "array · 3 elements");
		assert.equal(arrayTypeLabel("", undefined), "array");
	});
});