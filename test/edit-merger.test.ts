import { describe, expect, test } from "bun:test";

import type { EditRecord } from "~/telemetry/document-tracker.ts";
import {
	MERGE_WINDOW_MS,
	parseNewSideRange,
	parseNewSideRanges,
	rangesOverlap,
	shouldCoalesce,
} from "~/telemetry/edit-merger.ts";

function rec(diff: string, timestamp: number, filepath = "a.ts"): EditRecord {
	return { filepath, diff, timestamp };
}

function diffAt(newStart: number, newCount: number, payload = "+x"): string {
	return [
		"Index: a.ts",
		"===================================================================",
		`@@ -${newStart},1 +${newStart},${newCount} @@`,
		payload,
	].join("\n");
}

describe("parseNewSideRange", () => {
	test("extracts new-side start/end from the hunk header", () => {
		const r = parseNewSideRange(diffAt(10, 3));
		expect(r).toEqual({ newStart: 10, newEnd: 12 });
	});

	test("handles zero new count as collapsed deletion at start line", () => {
		const r = parseNewSideRange("@@ -5,1 +5,0 @@");
		expect(r).toEqual({ newStart: 5, newEnd: 5 });
	});

	test("returns null when no hunk header present", () => {
		expect(parseNewSideRange("not a diff")).toBeNull();
	});

	test("returns every new-side hunk range", () => {
		expect(
			parseNewSideRanges("@@ -5 +7 @@\n-old\n+new\n@@ -20,2 +30,3 @@"),
		).toEqual([
			{ newStart: 7, newEnd: 7 },
			{ newStart: 30, newEnd: 32 },
		]);
	});
});

describe("rangesOverlap", () => {
	test("disjoint ranges do not overlap", () => {
		expect(
			rangesOverlap(
				{ newStart: 10, newEnd: 10 },
				{ newStart: 20, newEnd: 20 },
				0,
			),
		).toBe(false);
	});

	test("touching ranges overlap with fuzz=1", () => {
		expect(
			rangesOverlap(
				{ newStart: 10, newEnd: 10 },
				{ newStart: 11, newEnd: 11 },
				1,
			),
		).toBe(true);
	});

	test("two-apart does not overlap with fuzz=1", () => {
		expect(
			rangesOverlap(
				{ newStart: 10, newEnd: 10 },
				{ newStart: 12, newEnd: 12 },
				1,
			),
		).toBe(false);
	});

	test("contained range overlaps", () => {
		expect(
			rangesOverlap(
				{ newStart: 10, newEnd: 20 },
				{ newStart: 15, newEnd: 15 },
				0,
			),
		).toBe(true);
	});
});

describe("shouldCoalesce", () => {
	const now = 1_000_000;

	test("typing burst on same line within 60s collapses", () => {
		const a = rec(diffAt(42, 1, "+spdlog::"), now - 5_000);
		const b = rec(diffAt(42, 1, "+spdlog::info()"), now);
		expect(shouldCoalesce(a, b, now)).toBe(true);
	});

	test("edits 90s apart on same line coalesce (window is 120s)", () => {
		const a = rec(diffAt(42, 1), now - 90_000);
		const b = rec(diffAt(42, 1), now);
		expect(shouldCoalesce(a, b, now)).toBe(true);
	});

	test("edits beyond the merge window do not coalesce", () => {
		const a = rec(diffAt(42, 1), now - MERGE_WINDOW_MS - 1_000);
		const b = rec(diffAt(42, 1), now);
		expect(shouldCoalesce(a, b, now)).toBe(false);
	});

	test("exactly at the merge window boundary coalesces", () => {
		const a = rec(diffAt(42, 1), now - MERGE_WINDOW_MS);
		const b = rec(diffAt(42, 1), now);
		expect(shouldCoalesce(a, b, now)).toBe(true);
	});

	test("edits on different files do not coalesce", () => {
		const a = rec(diffAt(42, 1), now - 1_000, "a.ts");
		const b = rec(diffAt(42, 1), now, "b.ts");
		expect(shouldCoalesce(a, b, now)).toBe(false);
	});

	test("adjacent lines (±1) coalesce — fuzz tolerates Enter shift", () => {
		const a = rec(diffAt(42, 1), now - 1_000);
		const b = rec(diffAt(43, 1), now);
		expect(shouldCoalesce(a, b, now)).toBe(true);
	});

	test("two-line gap does not coalesce", () => {
		const a = rec(diffAt(42, 1), now - 1_000);
		const b = rec(diffAt(44, 1), now);
		expect(shouldCoalesce(a, b, now)).toBe(false);
	});

	test("deletion collapsing to newCount=0 coalesces with same-line edit", () => {
		const a = rec(diffAt(42, 1), now - 1_000);
		const b = rec("@@ -42,1 +42,0 @@", now);
		expect(shouldCoalesce(a, b, now)).toBe(true);
	});

	test("unparseable diffs do not coalesce", () => {
		const a = rec("garbage", now - 1_000);
		const b = rec(diffAt(42, 1), now);
		expect(shouldCoalesce(a, b, now)).toBe(false);
	});
});
