import { describe, expect, test } from "bun:test";

import { classifyEditDisplay } from "~/editor/edit-display-classifier.ts";

describe("classifyEditDisplay", () => {
	test("returns JUMP when edit is far from cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 20,
			editStartLine: 5,
			editEndLine: 6,
			cursorOffset: 500,
			startIndex: 120,
			endIndex: 120,
			completion: "x",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "far-from-cursor",
		});
	});

	test("returns JUMP for multiline edits before cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 9,
			editEndLine: 9,
			cursorOffset: 200,
			startIndex: 120,
			endIndex: 120,
			completion: "foo\nbar",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "before-cursor-multiline",
		});
	});

	test("returns JUMP for same-line single-line edits before cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 120,
			endIndex: 120,
			completion: "replacement",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "before-cursor-single-line",
		});
	});

	test("returns JUMP for multiline edits below cursor within padding (not on cursor line)", () => {
		const result = classifyEditDisplay({
			cursorLine: 8,
			editStartLine: 10,
			editEndLine: 12,
			cursorOffset: 160,
			startIndex: 200,
			endIndex: 280,
			completion: "foo\nbar",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "not-on-cursor-line",
		});
	});

	test("returns JUMP for single-line edits on a different line within padding", () => {
		const result = classifyEditDisplay({
			cursorLine: 5,
			editStartLine: 6,
			editEndLine: 6,
			cursorOffset: 100,
			startIndex: 120,
			endIndex: 125,
			completion: "baz",
			replacedText: "bar",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "not-on-cursor-line",
		});
	});

	test("returns JUMP for single-line edits on a different line below cursor within padding", () => {
		const result = classifyEditDisplay({
			cursorLine: 12,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 250,
			startIndex: 200,
			endIndex: 205,
			completion: "baz",
			replacedText: "bar",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "before-cursor-single-line",
		});
	});

	test("returns INLINE for safe at-cursor suggestions", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 200,
			endIndex: 200,
			completion: "suffix",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "INLINE",
			reason: "inline-safe",
		});
	});

	test("returns INLINE on single-newline boundary for multiline at-cursor edit", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 200,
			endIndex: 200,
			completion: "foo\nbar",
			isOnSingleNewlineBoundary: true,
		});

		expect(result).toEqual({
			decision: "INLINE",
			reason: "single-newline-boundary",
		});
	});

	test("returns JUMP for multiline replacement at cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 18,
			cursorOffset: 200,
			startIndex: 200,
			endIndex: 350,
			completion: '"label");\n\tauto *x = ...',
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "multiline-replacement-at-cursor",
		});
	});

	test("returns JUMP for same-line replacement at cursor that does not extend existing text", () => {
		const result = classifyEditDisplay({
			cursorLine: 0,
			editStartLine: 0,
			editEndLine: 0,
			cursorOffset: 7,
			startIndex: 7,
			endIndex: 32,
			completion: "*",
			replacedText: "broken import tail",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "same-line-replacement-at-cursor",
		});
	});

	test("returns INLINE for same-line replacement at cursor when completion extends existing text", () => {
		const result = classifyEditDisplay({
			cursorLine: 0,
			editStartLine: 0,
			editEndLine: 0,
			cursorOffset: 14,
			startIndex: 14,
			endIndex: 18,
			completion: "highWatermark",
			replacedText: "high",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "INLINE",
			reason: "inline-safe",
		});
	});
});
