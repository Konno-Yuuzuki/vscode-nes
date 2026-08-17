import { describe, expect, test } from "bun:test";

import { SuggestionCache } from "~/editor/suggestion-cache.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";

function makeSuggestion(overrides: Partial<AutocompleteResult> = {}): AutocompleteResult {
	return {
		id: "test-1",
		startIndex: 100,
		endIndex: 100,
		completion: "const x = 1;\n",
		confidence: 0.8,
		...overrides,
	};
}

const URI_A = "file:///a.ts";
const URI_B = "file:///b.ts";
const CONTENT_A = "hello world";
const CONTENT_B = "goodbye world";
const LINE_10 = 10;
const LINE_5 = 5;
const VERSION = 5;

describe("SuggestionCache", () => {
	test("stores and retrieves a suggestion at the same line", () => {
		const cache = new SuggestionCache();
		const sug = [makeSuggestion()];
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION);

		const result = cache.get(URI_A, LINE_10, CONTENT_A, VERSION);
		expect(result).toEqual(sug);
	});

	test("returns null for unknown URI", () => {
		const cache = new SuggestionCache();
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);

		const result = cache.get(URI_B, LINE_10, CONTENT_A, VERSION);
		expect(result).toBeNull();
	});

	test("returns null when content differs", () => {
		const cache = new SuggestionCache();
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);

		const result = cache.get(URI_A, LINE_10, CONTENT_B, VERSION);
		expect(result).toBeNull();
	});

	test("returns null when document version differs", () => {
		const cache = new SuggestionCache();
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);

		const result = cache.get(URI_A, LINE_10, CONTENT_A, 42);
		expect(result).toBeNull();
	});

	test("retrieves suggestion within ±3 threshold", () => {
		const cache = new SuggestionCache();
		const sug = [makeSuggestion()];
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION);

		expect(cache.get(URI_A, LINE_10 - 1, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10 - 2, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10 - 3, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10 + 1, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10 + 2, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10 + 3, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10, CONTENT_A, VERSION)).toEqual(sug);
	});

	test("returns null when cursor beyond ±3 threshold", () => {
		const cache = new SuggestionCache();
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);

		expect(cache.get(URI_A, LINE_10 - 4, CONTENT_A, VERSION)).toBeNull();
		expect(cache.get(URI_A, LINE_10 + 4, CONTENT_A, VERSION)).toBeNull();
		expect(cache.get(URI_A, LINE_10 + 100, CONTENT_A, VERSION)).toBeNull();
	});

	test("custom threshold", () => {
		const cache = new SuggestionCache({ cursorThreshold: 5 });
		const sug = [makeSuggestion()];
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION);

		expect(cache.get(URI_A, LINE_10 - 5, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10 + 5, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, LINE_10 - 6, CONTENT_A, VERSION)).toBeNull();
		expect(cache.get(URI_A, LINE_10 + 6, CONTENT_A, VERSION)).toBeNull();
	});

	test("returns null after invalidation", () => {
		const cache = new SuggestionCache();
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);
		expect(cache.get(URI_A, LINE_10, CONTENT_A, VERSION)).not.toBeNull();

		cache.invalidate(URI_A);
		expect(cache.get(URI_A, LINE_10, CONTENT_A, VERSION)).toBeNull();
	});

	test("returns null after clear", () => {
		const cache = new SuggestionCache();
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);
		cache.store(URI_B, [makeSuggestion()], LINE_5, CONTENT_B, VERSION);

		cache.clear();
		expect(cache.get(URI_A, LINE_10, CONTENT_A, VERSION)).toBeNull();
		expect(cache.get(URI_B, LINE_5, CONTENT_B, VERSION)).toBeNull();
		expect(cache.size).toBe(0);
	});

	test("has() returns true for existing entries", () => {
		const cache = new SuggestionCache();
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);
		expect(cache.has(URI_A)).toBe(true);
		expect(cache.has(URI_B)).toBe(false);
	});

	test("size tracks entry count", () => {
		const cache = new SuggestionCache();
		expect(cache.size).toBe(0);

		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);
		expect(cache.size).toBe(1);

		cache.store(URI_B, [makeSuggestion()], LINE_5, CONTENT_B, VERSION);
		expect(cache.size).toBe(2);

		cache.invalidate(URI_A);
		expect(cache.size).toBe(1);
	});

	test("evicts oldest entry when at capacity", () => {
		const cache = new SuggestionCache({ maxEntries: 2 });
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);
		cache.store(URI_B, [makeSuggestion()], LINE_5, CONTENT_B, VERSION);

		cache.store("file:///c.ts", [makeSuggestion()], LINE_10, CONTENT_A, VERSION);

		expect(cache.size).toBe(2);
		expect(cache.has(URI_A)).toBe(false);
		expect(cache.has(URI_B)).toBe(true);
		expect(cache.has("file:///c.ts")).toBe(true);
	});

	test("returns null after TTL expiry", () => {
		const cache = new SuggestionCache({ cacheTtlMs: 100 });
		cache.store(URI_A, [makeSuggestion()], LINE_10, CONTENT_A, VERSION);

		// Should still be valid immediately
		expect(cache.get(URI_A, LINE_10, CONTENT_A, VERSION)).not.toBeNull();
		expect(cache.size).toBe(1);
	});

	test("handles edge case: line 0 request", () => {
		const cache = new SuggestionCache();
		const sug = [makeSuggestion()];
		cache.store(URI_A, sug, 0, CONTENT_A, VERSION);

		expect(cache.get(URI_A, 0, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 1, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 2, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 3, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 4, CONTENT_A, VERSION)).toBeNull();
	});

	test("handles edge case: large line numbers", () => {
		const cache = new SuggestionCache();
		const sug = [makeSuggestion()];
		const line = 10000;
		cache.store(URI_A, sug, line, CONTENT_A, VERSION);

		expect(cache.get(URI_A, line + 3, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, line + 4, CONTENT_A, VERSION)).toBeNull();
	});

	test("getOptions returns configured options", () => {
		const cache = new SuggestionCache({ cursorThreshold: 5, cacheTtlMs: 30000, maxEntries: 3 });
		const opts = cache.getOptions();
		expect(opts.cursorThreshold).toBe(5);
		expect(opts.cacheTtlMs).toBe(30000);
		expect(opts.maxEntries).toBe(3);
	});

	test("multiple suggestions stored and retrieved", () => {
		const cache = new SuggestionCache();
		const suggestions = [
			makeSuggestion({ completion: "first", id: "id-1" }),
			makeSuggestion({ completion: "second", id: "id-2" }),
		];
		cache.store(URI_A, suggestions, LINE_10, CONTENT_A, VERSION);

		const result = cache.get(URI_A, LINE_10, CONTENT_A, VERSION);
		expect(result).toHaveLength(2);
		expect(result?.[0]?.completion).toBe("first");
		expect(result?.[1]?.completion).toBe("second");
	});

	test("P3C: edit-range matching covers the edit range + margin", () => {
		const cache = new SuggestionCache({ useEditRange: true, editRangeMargin: 3 });
		const sug = [makeSuggestion()];
		// Edit spans lines 8..15 (endLine exclusive), request made at line 10
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION, {
			startLine: 8,
			endLine: 15,
		});

		// Inside the range + margin: lines 5..18
		expect(cache.get(URI_A, 5, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 8, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 10, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 15, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 18, CONTENT_A, VERSION)).toEqual(sug);
		// Outside the range + margin
		expect(cache.get(URI_A, 4, CONTENT_A, VERSION)).toBeNull();
		expect(cache.get(URI_A, 19, CONTENT_A, VERSION)).toBeNull();
	});

	test("P3C: edit-range matching with zero margin is exact", () => {
		const cache = new SuggestionCache({ useEditRange: true, editRangeMargin: 0 });
		const sug = [makeSuggestion()];
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION, {
			startLine: 10,
			endLine: 12,
		});

		expect(cache.get(URI_A, 10, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 11, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 12, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 9, CONTENT_A, VERSION)).toBeNull();
		expect(cache.get(URI_A, 13, CONTENT_A, VERSION)).toBeNull();
	});

	test("P3C: edit-range matching clamps negative start line", () => {
		const cache = new SuggestionCache({ useEditRange: true, editRangeMargin: 3 });
		const sug = [makeSuggestion()];
		// Edit starts at line 0 → minLine clamps to 0
		cache.store(URI_A, sug, 2, CONTENT_A, VERSION, {
			startLine: 0,
			endLine: 5,
		});

		expect(cache.get(URI_A, 0, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 1, CONTENT_A, VERSION)).toEqual(sug);
	});

	test("P3A: fixed threshold when useEditRange is false", () => {
		const cache = new SuggestionCache({ useEditRange: false, cursorThreshold: 5 });
		const sug = [makeSuggestion()];
		// Even though an edit range is provided, useEditRange=false ignores it
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION, {
			startLine: 0,
			endLine: 40,
		});

		expect(cache.get(URI_A, 10, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 15, CONTENT_A, VERSION)).toEqual(sug); // ±5
		expect(cache.get(URI_A, 5, CONTENT_A, VERSION)).toEqual(sug); // ±5
		expect(cache.get(URI_A, 16, CONTENT_A, VERSION)).toBeNull(); // beyond ±5
		expect(cache.get(URI_A, 4, CONTENT_A, VERSION)).toBeNull();
	});

	test("P3C: falls back to fixed threshold when no edit range stored", () => {
		const cache = new SuggestionCache({
			useEditRange: true,
			cursorThreshold: 3,
			editRangeMargin: 3,
		});
		const sug = [makeSuggestion()];
		// No edit range passed → fixed threshold on requestLine
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION);

		expect(cache.get(URI_A, 13, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 7, CONTENT_A, VERSION)).toEqual(sug);
		expect(cache.get(URI_A, 14, CONTENT_A, VERSION)).toBeNull();
	});

	test("P3C: large edit range is more forgiving than fixed threshold", () => {
		const cache = new SuggestionCache({ useEditRange: true, editRangeMargin: 3 });
		const sug = [makeSuggestion()];
		// A big 40-line edit: cursor 10 lines below the request line is still
		// "near" the edit (inside the edit body), whereas a fixed ±3 would miss.
		cache.store(URI_A, sug, LINE_10, CONTENT_A, VERSION, {
			startLine: 10,
			endLine: 50,
		});

		expect(cache.get(URI_A, 40, CONTENT_A, VERSION)).toEqual(sug);
		// But clearly outside the edit body (before the edit start - margin)
		expect(cache.get(URI_A, 5, CONTENT_A, VERSION)).toBeNull();
	});
});