// Postprocessing for Zeta2 / Zeta2.1 model output. Mirrors parseCompletion
// in cursortab.nvim's server/provider/zeta2/zeta2.go for the 2.0 path.
// Zeta2.1 uses numbered boundaries: the first and last markers emitted by
// the model identify the original document span replaced by the text
// between them.
//
// The common API returns an array, but a Zeta2.1 response represents one
// contiguous marker span and therefore produces at most one edit.
//
// Unlike Sweep, the model output is *only* the new editable region (not
// a full window rewrite), so trimCommonEnds runs against the editable
// slice rather than the full original/current/updated window.

import { logger } from "~/core/logger.ts";
import type { CompletionResult } from "./completion-client.ts";
import type { EditRegion, ModelPrompt } from "./model-format.ts";
import type { AutocompleteResponse } from "./schemas.ts";
import { stripInjectedFixmesFromLines } from "./sweep-completion.ts";
import {
	ZETA2_1_EOS_MARKER,
	ZETA2_CURSOR_MARKER,
	ZETA2_END_MARKER,
	ZETA2_NO_EDITS,
} from "./zeta2-prompt.ts";

export function buildZeta2Response(
	completion: CompletionResult,
	prompt: ModelPrompt,
	autocompleteId: string,
): AutocompleteResponse[] | null {
	if (completion.finishReason === "length") return null;

	const regions = prompt.regions ?? [
		{
			startLine: prompt.windowStartLine,
			endLine: prompt.windowEndLine,
			isPrimary: true,
		},
	];
	const primary = regions.find((r) => r.isPrimary) ?? regions[0];
	if (!primary) return null;

	const responses: AutocompleteResponse[] = [];

	if (prompt.format === "zeta2.1") {
		const markerSpan = parseMarkerSpan(
			completion.text,
			regions,
			primary,
			prompt.markerBoundaryLines,
		);
		if (markerSpan) {
			const response = buildRegionResponse(
				markerSpan.replacement,
				markerSpan.region,
				prompt,
				autocompleteId,
				completion.finishReason,
			);
			if (response) responses.push(response);
		} else if (NUMBERED_MARKER_RE.test(completion.text)) {
			// Numbered markers were present but did not form a safe,
			// increasing span. Falling back to the primary window here can
			// apply correct-looking text to the wrong part of the file.
			logger.debug("zeta2.1 response contained an invalid marker span");
			return null;
		} else {
			// Lenient fallback for servers/checkpoints that omit both
			// boundary markers and return the primary replacement directly.
			const cleaned = stripZeta21Eos(completion.text);
			if (cleaned.trim() === "") return null;
			const response = buildRegionResponse(
				cleaned,
				primary,
				prompt,
				autocompleteId,
				completion.finishReason,
			);
			if (response) responses.push(response);
		}
	} else {
		// 2.0 single-region path. Strip the end-of-edit scaffolding once,
		// then run a diff against the primary region.
		let cleaned = completion.text;
		// Strip trailing >>>>>>> UPDATED.
		if (cleaned.endsWith(ZETA2_END_MARKER)) {
			cleaned = cleaned.slice(0, -ZETA2_END_MARKER.length);
		} else {
			const trimmed = ZETA2_END_MARKER.replace(/\n$/, "");
			if (cleaned.endsWith(trimmed)) {
				cleaned = cleaned.slice(0, -trimmed.length);
			}
		}
		if (cleaned.trim() === "") return null;
		if (cleaned.trimStart().startsWith(ZETA2_NO_EDITS)) return null;
		const response = buildRegionResponse(
			cleaned,
			primary,
			prompt,
			autocompleteId,
			completion.finishReason,
		);
		if (response) responses.push(response);
	}

	return responses.length > 0 ? responses : null;
}

const NUMBERED_MARKER_RE = /<\|marker_\d+\|>/;

interface MarkerSpan {
	replacement: string;
	region: EditRegion;
}

// Extract one Zeta2.1 marker span. Marker numbers index document boundaries,
// not independent region pairs: marker_2 → marker_3 replaces the unchanged
// gap between focused regions, while marker_1 → marker_4 replaces the whole
// excerpt. A single marker is accepted as a compatibility fallback for
// servers that strip the adjacent closing boundary as a stop sequence.
// When the model echoes more than two markers (a full-excerpt rewrite), the
// first and last markers delimit the span and any intermediate markers are
// stripped from the replacement.
function parseMarkerSpan(
	text: string,
	regions: EditRegion[],
	primary: EditRegion,
	markerBoundaryLines?: number[],
): MarkerSpan | null {
	type MarkerHit = { num: number; start: number; end: number };
	const re = /<\|marker_(\d+)\|>/g;
	const hits: MarkerHit[] = [];
	for (const m of text.matchAll(re)) {
		const idx = m.index ?? -1;
		if (idx < 0) continue;
		hits.push({
			num: Number.parseInt(m[1] ?? "0", 10),
			start: idx,
			end: idx + m[0].length,
		});
	}

	if (hits.length === 0) return null;
	const start = hits[0];
	if (!start || start.num < 1) return null;
	// Marker numbers must form a strictly increasing sequence. A real
	// full-excerpt rewrite echoes every boundary in order (1, 2, 3, …);
	// repeats or decreases mean the model produced malformed scaffolding.
	for (let i = 1; i < hits.length; i++) {
		if (hits[i]?.num <= (hits[i - 1]?.num ?? 0)) return null;
	}
	// The last echoed marker bounds the replacement. For a normal two-marker
	// span this is hits[1]; a full-excerpt rewrite echoes every boundary the
	// prompt placed, so the trailing one is the closing boundary. A single
	// marker keeps the legacy adjacent-boundary inference.
	const explicitEnd = hits.length > 1 ? hits[hits.length - 1] : undefined;
	const endMarkerNum = explicitEnd?.num ?? start.num + 1;
	if (endMarkerNum <= start.num) return null;

	// New V0318 prompts persist their exact contiguous marker boundaries.
	// Fall back to the former focused-region mapping for cached/test prompts
	// created before markerBoundaryLines was added.
	const boundaryLines =
		markerBoundaryLines ??
		regions.flatMap((region) => [region.startLine, region.endLine]);
	const startLine = boundaryLines[start.num - 1];
	const endLine = boundaryLines[endMarkerNum - 1];
	if (startLine === undefined || endLine === undefined || endLine < startLine) {
		return null;
	}

	const contentEnd = explicitEnd?.start ?? text.length;
	let replacement = stripZeta21Eos(text.slice(start.end, contentEnd));
	// Markers are rendered on their own lines. Remove only their structural
	// newline, preserving any additional blank lines produced by the model.
	replacement = replacement.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
	replacement = replacement.replace(/<\|marker_\d+\|>/g, "");

	return {
		replacement,
		region: {
			startLine,
			endLine,
			isPrimary: startLine < primary.endLine && endLine > primary.startLine,
		},
	};
}

function stripZeta21Eos(text: string): string {
	const eosIndex = text.indexOf(ZETA2_1_EOS_MARKER);
	return eosIndex === -1 ? text : text.slice(0, eosIndex);
}

// Map one region's replacement text to a UTF-8 byte-offset edit. Shared
// between single-region and per-region multi-region paths. The caller
// is responsible for stripping end-of-edit / marker scaffolding before
// passing `text` in.
function buildRegionResponse(
	rawText: string,
	region: EditRegion,
	prompt: ModelPrompt,
	autocompleteId: string,
	finishReason: string,
): AutocompleteResponse | null {
	let text = rawText;

	// Replace the FIRST cursor marker with a sentinel so we can track
	// the post-edit cursor position through the line-diff and surface
	// it as a snippet $0 placeholder. Accept both <|user_cursor|>
	// (Zeta2's trained marker) and <|cursor|> (sweep-style — some
	// SeedCoder checkpoints echo it back). Only the primary region is
	// expected to contain a cursor marker, but secondary regions are
	// safe to run through this — countCursorMarkers will return 0.
	const markerCount = countCursorMarkers(text);
	if (markerCount > 0) {
		logger.debug(
			`zeta2 response contained ${markerCount} cursor marker(s); stripping`,
		);
	}
	text = injectCursorSentinel(text);
	text = text.replace(/[ \t\n\r]+$/g, "");

	const stripped = stripRepetition(text);
	if (stripped === null) return null;

	const newLines = stripped.split("\n");
	stripInjectedFixmesFromLines(
		newLines,
		prompt.injectedFixmeMessages,
		prompt.commentPrefix,
		prompt.inlineDiagnosticsMarker,
	);
	const oldLines = prompt.lines
		.slice(region.startLine, region.endLine)
		.map((l) => l.content);

	if (trimRight(newLines.join("\n")) === trimRight(oldLines.join("\n"))) {
		return null;
	}

	const trimmed = trimCommonEnds(oldLines, newLines);
	if (trimmed === null) return null;

	const { skipPrefix, oldMiddle, newMiddle } = trimmed;
	const startLineIdx = region.startLine + skipPrefix;
	const endLineIdx = startLineIdx + oldMiddle.length; // exclusive

	const startByte = prompt.cursorLineByteOffsets[startLineIdx] ?? 0;
	let endByte: number;
	let completionText: string;

	if (oldMiddle.length === 0) {
		// Pure insertion — splice new lines in front of the suffix line.
		endByte = startByte;
		completionText = `${newMiddle.join("\n")}\n`;
	} else if (newMiddle.length === 0) {
		// Pure deletion — gobble the trailing newline of the last removed line.
		endByte = prompt.cursorLineByteOffsets[endLineIdx] ?? startByte;
		completionText = "";
	} else {
		const lastLineIdx = endLineIdx - 1;
		const lineStart = prompt.cursorLineByteOffsets[lastLineIdx] ?? startByte;
		const lineContent = prompt.lines[lastLineIdx]?.content ?? "";
		endByte = lineStart + Buffer.byteLength(lineContent, "utf8");
		completionText = newMiddle.join("\n");
	}

	const { text: cleanedCompletion, cursorTargetOffset } =
		extractCursorSentinel(completionText);
	completionText = cleanedCompletion;
	if (cursorTargetOffset !== undefined) {
		logger.debug(
			`zeta2 cursor target at offset ${cursorTargetOffset} of ${completionText.length}-char completion`,
		);
	}

	if (completionText.length === 0 && endByte === startByte) return null;

	return {
		autocomplete_id: autocompleteId,
		start_index: startByte,
		end_index: endByte,
		completion: completionText,
		confidence: 0.8,
		finish_reason: finishReason,
		...(cursorTargetOffset !== undefined
			? { cursor_target_offset: cursorTargetOffset }
			: {}),
	};
}

// U+E000 (Private Use Area) — never appears in real source, so it survives
// line-splitting / repetition trimming / line-diff trimming intact.
const SENTINEL = String.fromCharCode(0xe000);
const CURSOR_MARKERS = [ZETA2_CURSOR_MARKER, "<|cursor|>"];

function countCursorMarkers(text: string): number {
	let n = 0;
	for (const m of CURSOR_MARKERS) {
		const parts = text.split(m).length - 1;
		n += parts;
	}
	return n;
}

function injectCursorSentinel(text: string): string {
	let firstIdx = -1;
	let firstLen = 0;
	for (const m of CURSOR_MARKERS) {
		const i = text.indexOf(m);
		if (i !== -1 && (firstIdx === -1 || i < firstIdx)) {
			firstIdx = i;
			firstLen = m.length;
		}
	}
	let result = text;
	if (firstIdx !== -1) {
		result =
			result.slice(0, firstIdx) + SENTINEL + result.slice(firstIdx + firstLen);
	}
	for (const m of CURSOR_MARKERS) {
		if (result.includes(m)) result = result.split(m).join("");
	}
	return result;
}

function extractCursorSentinel(text: string): {
	text: string;
	cursorTargetOffset: number | undefined;
} {
	const idx = text.indexOf(SENTINEL);
	if (idx === -1) return { text, cursorTargetOffset: undefined };
	const cleaned = text.slice(0, idx) + text.slice(idx + SENTINEL.length);
	return { text: cleaned, cursorTargetOffset: idx };
}

interface TrimmedDiff {
	skipPrefix: number;
	oldMiddle: string[];
	newMiddle: string[];
}

function trimCommonEnds(
	oldLines: string[],
	newLines: string[],
): TrimmedDiff | null {
	// splitLines on a file ending with '\n' produces a phantom trailing ""
	// that has no counterpart in the model output (text is right-trimmed),
	// so suffix-match would fail at the last comparison and the diff would
	// blow up to span the whole window. Drop trailing empties from both
	// sides before aligning.
	let oldEnd = oldLines.length;
	while (oldEnd > 0 && oldLines[oldEnd - 1] === "") oldEnd--;
	let newEnd = newLines.length;
	while (newEnd > 0 && newLines[newEnd - 1] === "") newEnd--;

	let skipPrefix = 0;
	const minLen = Math.min(oldEnd, newEnd);
	while (skipPrefix < minLen && oldLines[skipPrefix] === newLines[skipPrefix]) {
		skipPrefix++;
	}

	let skipSuffix = 0;
	const remainingOld = oldEnd - skipPrefix;
	const remainingNew = newEnd - skipPrefix;
	const maxSuffix = Math.min(remainingOld, remainingNew);
	while (
		skipSuffix < maxSuffix &&
		oldLines[oldEnd - 1 - skipSuffix] === newLines[newEnd - 1 - skipSuffix]
	) {
		skipSuffix++;
	}

	const oldMiddle = oldLines.slice(skipPrefix, oldEnd - skipSuffix);
	const newMiddle = newLines.slice(skipPrefix, newEnd - skipSuffix);
	if (oldMiddle.length === 0 && newMiddle.length === 0) return null;
	return { skipPrefix, oldMiddle, newMiddle };
}

function trimRight(s: string): string {
	return s.replace(/[ \t\n\r]+$/g, "");
}

function stripRepetition(text: string): string | null {
	const lines = text.split("\n");
	let cutIdx = -1;
	for (let i = 2; i < lines.length; i++) {
		const a = lines[i];
		const b = lines[i - 1];
		const c = lines[i - 2];
		if (a === b && a === c && a !== undefined && a.trim() !== "") {
			cutIdx = i - 2;
			break;
		}
	}
	if (cutIdx < 0) return text;
	if (cutIdx === 0) return null;
	return lines.slice(0, cutIdx).join("\n");
}
