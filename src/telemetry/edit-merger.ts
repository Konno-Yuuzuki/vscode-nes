import type { EditRecord } from "~/telemetry/document-tracker.ts";

export interface ParsedRange {
	newStart: number;
	newEnd: number;
}

export const MERGE_WINDOW_MS = 120_000;
// Tolerates a single inserted/removed line shifting downstream ranges
// (the common Enter case). Larger structural moves stay as distinct
// records — they are meaningful context.
export const MERGE_LINE_FUZZ = 1;

const HUNK_HEADER_RE = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g;

export function parseNewSideRanges(diff: string): ParsedRange[] {
	const ranges: ParsedRange[] = [];
	for (const match of diff.matchAll(HUNK_HEADER_RE)) {
		const newStart = Number.parseInt(match[1] ?? "", 10);
		const newCount = Number.parseInt(match[2] ?? "1", 10);
		if (!Number.isFinite(newStart) || !Number.isFinite(newCount)) continue;
		ranges.push({
			newStart,
			newEnd: newStart + Math.max(0, newCount - 1),
		});
	}
	return ranges;
}

export function parseNewSideRange(diff: string): ParsedRange | null {
	return parseNewSideRanges(diff)[0] ?? null;
}

export function rangesOverlap(
	a: ParsedRange,
	b: ParsedRange,
	fuzz: number,
): boolean {
	return a.newStart - fuzz <= b.newEnd && b.newStart - fuzz <= a.newEnd;
}

export function shouldCoalesce(
	existing: EditRecord,
	incoming: EditRecord,
	now: number,
): boolean {
	if (existing.filepath !== incoming.filepath) return false;
	if (now - existing.timestamp > MERGE_WINDOW_MS) return false;
	const existingRange = parseNewSideRange(existing.diff);
	const incomingRange = parseNewSideRange(incoming.diff);
	if (!existingRange || !incomingRange) return false;
	return rangesOverlap(existingRange, incomingRange, MERGE_LINE_FUZZ);
}
