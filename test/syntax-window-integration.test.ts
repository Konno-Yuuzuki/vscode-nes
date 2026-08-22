import { describe, expect, test } from "bun:test";
import { selectZetaCursorWindowFromLineProvider } from "~/api/zeta2-prompt.ts";

function makeGetLine(lines: string[]): (line: number) => string {
	return (line: number) => lines[line] ?? "";
}

describe("selectZetaCursorWindowFromLineProvider syntaxAware", () => {
		test("syntaxAware=false does pure line-wise expansion", () => {
			const lines = [
				"function foo() {",
				"    let x = 1;",
				"    let y = 2;",
				"}",
				"function bar() {",
				"    let z = 3;",
				"    let w = 4;",
				"}",
			];
			const getLine = makeGetLine(lines);
			const result = selectZetaCursorWindowFromLineProvider(
				lines.length, 5, 20, 5, getLine, false,
			);
			// Pure line-wise: window is centered on cursor line 5,
			// not expanded to bar() function boundaries (lines 4-7)
			expect(result.editableStart).toBe(3); // one line above cursor
			expect(result.editableEnd).toBe(8);   // covers to end
		});

	test("syntaxAware=true expands to enclosing function when budget fits", () => {
		const lines = [
			"function foo() {",
			"    let x = 1;",
			"    let y = 2;",
			"}",
			"function bar() {",
			"    let z = 3;",
			"    let w = 4;",
			"}",
		];
		const getLine = makeGetLine(lines);
		const result = selectZetaCursorWindowFromLineProvider(
			lines.length, 5, 200, 5, getLine, true,
		);
		// bar() starts at line 4, closing } at line 7 included (depth 1)
		expect(result.editableStart).toBe(4);
		expect(result.editableEnd).toBe(8); // exclusive end after }
	});

	test("syntaxAware=true falls back to line-wise when budget too small", () => {
		const lines = [
			"function foo() {",
			"    let x = 1;",
			"    let y = 2;",
			"    let a = 3;",
			"    let b = 4;",
			"    let c = 5;",
			"    let d = 6;",
			"}",
		];
		const getLine = makeGetLine(lines);
		const result = selectZetaCursorWindowFromLineProvider(
			lines.length, 3, 2, 1, getLine, true,
		);
		// Budget too small for the whole function, falls back to line-wise
		expect(result.editableEnd - result.editableStart).toBeLessThan(4);
		expect(result.editableStart).toBeGreaterThanOrEqual(0);
		expect(result.editableEnd).toBeLessThanOrEqual(lines.length);
	});

	test("syntaxAware=true expands to Rust function by bracket depth", () => {
		const lines = [
			"pub fn compute() -> i32 {",
			"    let a = 1;",
			"    let b = 2;",
			"    a + b",
			"}",
		];
		const getLine = makeGetLine(lines);
		const result = selectZetaCursorWindowFromLineProvider(
			lines.length, 2, 200, 5, getLine, true,
		);
		// compute() starts at line 0, closing } at line 4 included
		expect(result.editableStart).toBe(0);
		expect(result.editableEnd).toBe(5); // exclusive end after }
	});
});