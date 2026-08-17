import { describe, expect, test } from "bun:test";

import {
	computeLineDepths,
	inferSyntaxBlock,
	netBracketChange,
	type SyntaxBlock,
} from "~/api/syntax-window.ts";

describe("netBracketChange", () => {
	test("ignores brackets inside strings", () => {
		expect(netBracketChange('let x = "{";')).toBe(0);
		expect(netBracketChange("let y = '{';")).toBe(0);
		expect(netBracketChange("let z = `{`;")).toBe(0);
	});

	test("ignores line comments", () => {
		expect(netBracketChange("// { [ ( ")).toBe(0);
	});

	test("ignores block comments", () => {
		expect(netBracketChange("/* { [ ( */")).toBe(0);
	});

	test("counts opening brackets", () => {
		expect(netBracketChange("function foo() {")).toBe(1);
		expect(netBracketChange("if (x) {")).toBe(1);
		expect(netBracketChange("[1, 2, 3]")).toBe(0);
	});

	test("counts closing brackets", () => {
		expect(netBracketChange("}")).toBe(-1);
		expect(netBracketChange("]")).toBe(-1);
		expect(netBracketChange(");")).toBe(-1);
	});

	test("handles mixed brackets", () => {
		expect(netBracketChange("} else {")).toBe(0);
		expect(netBracketChange("fn() { return [1,2]; }")).toBe(0);
	});

	test("parses through block comment before counting", () => {
		expect(netBracketChange("/* { */ }")).toBe(-1);
		expect(netBracketChange("{ /* } */")).toBe(1);
	});

	test("handles escape sequences in strings", () => {
		expect(netBracketChange('let s = "\\"";')).toBe(0);
	});
});

describe("computeLineDepths", () => {
	test("top-level lines have depth 0", () => {
		const lines = ["const x = 1;", "const y = 2;"];
		expect(computeLineDepths(lines)).toEqual([0, 0]);
	});

	test("depth increases after opening brace", () => {
		const lines = ["function foo() {", "bar();", "}"];
		expect(computeLineDepths(lines)).toEqual([0, 1, 1]);
	});

	test("depth decreases after closing brace", () => {
		const lines = ["function foo() {", "bar();", "}", "baz();"];
		expect(computeLineDepths(lines)).toEqual([0, 1, 1, 0]);
	});

	test("nested blocks", () => {
		const lines = [
			"if (x) {",       // depth 0
			"  if (y) {",     // depth 1
			"    foo();",     // depth 2
			"  }",            // depth 2
			"  bar();",       // depth 1
			"}",              // depth 1
			"baz();",         // depth 0
		];
		expect(computeLineDepths(lines)).toEqual([0, 1, 2, 2, 1, 1, 0]);
	});

	test("brackets in strings do not affect depth", () => {
		const lines = [
			"const s = '{' + '}';",  // depth 0
			"more();",                // depth 0
		];
		expect(computeLineDepths(lines)).toEqual([0, 0]);
	});
});

describe("inferSyntaxBlock", () => {
	const functionBlock = [
		"function foo() {",     // 0  depth 0
		"  const x = 1;",      // 1  depth 1
		"  const y = 2;",      // 2  depth 1
		"  return x + y;",     // 3  depth 1
		"}",                    // 4  depth 1
		"const z = 3;",        // 5  depth 0
	];

	test("finds enclosing function block", () => {
		const result = inferSyntaxBlock(functionBlock, 2);
		expect(result).toEqual({ start: 0, end: 5 });
	});

	test("returns null for top-level cursor", () => {
		expect(inferSyntaxBlock(functionBlock, 5)).toBeNull();
	});

	test("returns null for empty file", () => {
		expect(inferSyntaxBlock([], 0)).toBeNull();
	});

	const nestedBlock = [
		"function outer() {",    // 0  depth 0
		"  if (x) {",           // 1  depth 1
		"    inner();",         // 2  depth 2
		"  }",                  // 3  depth 2
		"  const y = 1;",       // 4  depth 1
		"}",                    // 5  depth 1
		"after();",             // 6  depth 0
	];

	test("finds innermost block first", () => {
		// Cursor inside the if block (depth 2)
		const result = inferSyntaxBlock(nestedBlock, 2);
		// The enclosing block should be the if block, not the outer function
		expect(result).toEqual({ start: 1, end: 4 });
	});

	test("finds outer block when cursor is at depth 1 but not 2", () => {
		const result = inferSyntaxBlock(nestedBlock, 4); // const y = 1;
		expect(result).toEqual({ start: 0, end: 6 }); // outer function
	});

	const classBlock = [
		"class Foo {",           // 0  depth 0
		"  bar() {",             // 1  depth 1
		"    doSomething();",    // 2  depth 2
		"  }",                   // 3  depth 2
		"  baz() {",             // 4  depth 1
		"    return 1;",         // 5  depth 2
		"  }",                   // 6  depth 2
		"}",                    // 7  depth 1
	];

	test("finds method block inside class", () => {
		const result = inferSyntaxBlock(classBlock, 5); // return 1 (inside baz)
		expect(result).toEqual({ start: 4, end: 7 }); // baz method
	});

	test("finds class block when cursor at bar method", () => {
		const result = inferSyntaxBlock(classBlock, 2); // inside bar()
		expect(result).toEqual({ start: 1, end: 4 }); // bar method
	});

	const rustCode = [
		"fn foo() {",          // 0  depth 0
		"    let x = 1;",      // 1  depth 1
		"    if x > 0 {",      // 2  depth 1
		"        bar();",      // 3  depth 2
		"    }",                // 4  depth 2
		"}",                    // 5  depth 1
	];

	test("works with Rust-style code", () => {
		const result = inferSyntaxBlock(rustCode, 3); // inside the if
		expect(result).toEqual({ start: 2, end: 5 }); // if block
	});

	const tsCode = [
		"export function foo() {",  // 0  depth 0
		"  const result: string[] = [];", // 1  depth 1
		"  items.forEach(item => {", // 2  depth 1 (arrow fn has `{`)
		"    result.push(item);",   // 3  depth 2
		"  });",                    // 4  depth 2
		"  return result;",         // 5  depth 1
		"}",                        // 6  depth 1
	];

	test("works with TypeScript arrow functions", () => {
		const result = inferSyntaxBlock(tsCode, 3); // inside arrow fn
		expect(result).toEqual({ start: 2, end: 5 }); // arrow block
	});

	test("ignores brackets in strings", () => {
		const lines = [
			'function foo() {',  // 0  depth 0
			'  const s = "{";',  // 1  depth 1 (brace in string, ignored)
			'  bar();',          // 2  depth 1
			'}',                 // 3  depth 1
		];
		const result = inferSyntaxBlock(lines, 1);
		expect(result).toEqual({ start: 0, end: 4 }); // entire function
	});
});