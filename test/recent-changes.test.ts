import { describe, expect, test } from "bun:test";

import {
	excludeSweepBroadWindowChanges,
	formatRecentChanges,
} from "~/api/client.ts";

function diffWithBody(bodyLines: string[]): string {
	return [
		"Index: src/example.ts",
		"===================================================================",
		"--- src/example.ts",
		"+++ src/example.ts",
		"@@ -1,1 +1,1 @@",
		...bodyLines,
	].join("\n");
}

describe("formatRecentChanges", () => {
	test("omits history when the character budget is zero", () => {
		const result = formatRecentChanges(
			[{ path: "src/example.ts", diff: diffWithBody(["+const x = 1;"]) }],
			0,
		);

		expect(result).toBe("");
	});

	test("omits active-file hunks already covered by the Sweep broad window", () => {
		const lines = Array.from({ length: 100 }, () => "x".repeat(19));
		const changes = [
			{ path: "src/active.ts", diff: "@@ -50,1 +50,1 @@\n-old\n+new" },
			{ path: "src/active.ts", diff: "@@ -80,1 +80,1 @@\n-old\n+new" },
			{ path: "src/other.ts", diff: "@@ -50,1 +50,1 @@\n-old\n+new" },
			{ path: "src/active.ts", diff: "unparseable active diff" },
		];
		const result = excludeSweepBroadWindowChanges(
			changes,
			"src/active.ts",
			lines,
			50,
			30,
		);

		expect(result).toEqual([changes[1], changes[2]]);
	});

	test("keeps multiple small cleaned diff records", () => {
		const result = formatRecentChanges(
			[
				{ path: "src/a.ts", diff: diffWithBody(["+const a = 1;"]) },
				{ path: "src/b.ts", diff: diffWithBody(["+const b = 2;"]) },
			],
			1000,
		);

		expect(result).toContain("File: src/a.ts:");
		expect(result).toContain("File: src/b.ts:");
		expect(result).toContain("@@ -1,1 +1,1 @@");
		expect(result).not.toContain("Index:");
		expect(result).not.toContain("--- src/example.ts");
		expect(result).not.toContain("+++ src/example.ts");
	});

	test("caps formatted history by characters, not just record count", () => {
		const body = Array.from({ length: 80 }, (_, i) => `+line ${i}`);
		const result = formatRecentChanges(
			[
				{ path: "src/huge.ts", diff: diffWithBody(body) },
				{ path: "src/later.ts", diff: diffWithBody(["+should not fit"]) },
			],
			220,
		);

		expect(result.length).toBeLessThanOrEqual(220);
		expect(result).toContain("File: src/huge.ts:");
		expect(result).toContain("...[truncated]");
		expect(result).not.toContain("File: src/later.ts:");
	});

	test("can select the newest entries and render them oldest first for Zeta", () => {
		const result = formatRecentChanges(
			[
				{ path: "src/newest.ts", diff: diffWithBody(["+newest"]) },
				{ path: "src/previous.ts", diff: diffWithBody(["+previous"]) },
				{ path: "src/oldest.ts", diff: diffWithBody(["+oldest"]) },
			],
			1000,
			{ maxEntries: 2, oldestFirst: true },
		);

		const previous = result.indexOf("File: src/previous.ts:");
		const newest = result.indexOf("File: src/newest.ts:");
		expect(previous).toBeGreaterThanOrEqual(0);
		expect(newest).toBeGreaterThan(previous);
		expect(result).not.toContain("File: src/oldest.ts:");
	});

	test("evicts chronological history from its old end to retain newest edits", () => {
		const largeOldDiff = diffWithBody(Array.from({ length: 24 }, () => "+old"));
		const result = formatRecentChanges(
			[
				{ path: "src/newest.ts", diff: diffWithBody(["+newest"]) },
				{ path: "src/previous.ts", diff: diffWithBody(["+previous"]) },
				{ path: "src/oldest.ts", diff: largeOldDiff },
			],
			220,
			{ oldestFirst: true, evictOldestToFit: true },
		);

		const previous = result.indexOf("File: src/previous.ts:");
		const newest = result.indexOf("File: src/newest.ts:");
		expect(result).not.toContain("File: src/oldest.ts:");
		expect(previous).toBeGreaterThanOrEqual(0);
		expect(newest).toBeGreaterThan(previous);
		expect(result.length).toBeLessThanOrEqual(220);
	});
});
