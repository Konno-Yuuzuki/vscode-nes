// Zeta2 / Zeta2.1 (Zed's SeedCoder-8B edit-prediction model family)
// prompt builder. Ported from cursortab.nvim's
// server/provider/zeta2/zeta2.go. The 2.0 checkpoint is distributed as
// `zed-industries/zeta2`; the 2.1 checkpoint is `zed-industries/zeta-2.1`.
// Both use the SeedCoder SPM Fill-In-Middle layout — they only differ in
// the markers wrapping the editable region and the stop tokens. We
// parameterise on `protocolVersion` (2.0 or 2.1) and dispatch the right
// markers from a small table.
//
// Prompt layout (single completion text fed to /v1/completions). Pseudo-
// files inside the prefix block are ordered with rules first, then volatile
// context, with diagnostics last so the model sees them adjacent to the
// cursor file's editable region.
//
//   <[fim-suffix]>{code after editable region}\n
//
//   <[fim-prefix]><filename>context/rules     (omitted if no rules)
//   {rules body}
//
//   <filename>{path}                          (recent buffer pseudo-files)
//   {file body}
//
//   <filename>edit_history                    (omitted if no recent changes)
//   --- a/{path}
//   +++ b/{path}
//   {unified diff}
//
//   <filename>context/outline                 active + nearby LSP symbols
//   active_symbol: Class::method
//   nearby_functions:
//   ...
//
//   <filename>diagnostics                     (omitted if no diagnostics)
//   line N: [severity] message
//
//   <filename>{cursor file path}
//   {code before editable region}
//   <openRegion>                              2.0: "<<<<<<< CURRENT\n"
//   {editable region with <|user_cursor|> inline}     2.1: "<|marker_1|>\n"
//   <closeRegion>                             2.0: "=======\n"
//   <[fim-middle]>                                      2.1: "<|marker_2|>\n"
//
// 2.0 model emits the replacement editable region terminated by
// ">>>>>>> UPDATED". A literal "NO_EDITS" output means no change.
// 2.1 numbered markers are Zed V0318 boundaries inside one contiguous
// editable excerpt. The model returns one span from any marker N to a later M:
// "<|marker_N|>\n{replacement}\n<|marker_M|>". The response parser maps
// those two boundary numbers back to document offsets.

import type { MessageTransform } from "~/core/config.ts";
import {
	DEFAULT_EDITABLE_TOKENS,
	DEFAULT_MAX_CONTEXT_FILES,
	DEFAULT_ZETA_CONTEXT_TOKENS,
	ESTIMATED_BYTES_PER_TOKEN,
} from "~/core/constants.ts";
import { utf8ByteOffsetToUtf16Offset } from "~/utils/text.ts";
import type {
	EditRegion,
	ModelPrompt,
	PromptContextStats,
} from "./model-format.ts";
import type {
	AutocompleteRequest,
	EditorDiagnostic,
	FileChunk,
} from "./schemas.ts";
import {
	computeLineByteOffsets,
	locateCursor,
	normalizeDiagnosticMessage,
	renderDiagnosticsAsComments,
	splitLines,
} from "./sweep-prompt.ts";

export const ZETA2_STOP_TOKENS = [">>>>>>> UPDATED\n", ">>>>>>> UPDATED"];
export const ZETA2_1_EOS_MARKER = "<[end▁of▁sentence]>";
export const ZETA2_1_STOP_TOKENS = [ZETA2_1_EOS_MARKER];

const FIM_SUFFIX = "<[fim-suffix]>";
const FIM_PREFIX = "<[fim-prefix]>";
const FIM_MIDDLE = "<[fim-middle]>";
const FILE_MARKER = "<filename>";
export const ZETA2_CURRENT_MARKER = "<<<<<<< CURRENT\n";
export const ZETA2_SEPARATOR = "=======\n";
export const ZETA2_END_MARKER = ">>>>>>> UPDATED\n";
export const ZETA2_NO_EDITS = "NO_EDITS";
export const ZETA2_CURSOR_MARKER = "<|user_cursor|>";
export const ZETA2_1_OPEN_MARKER = "<|marker_1|>\n";
export const ZETA2_1_CLOSE_MARKER = "<|marker_2|>";

export type Zeta2Protocol = "2" | "2.1";

interface Zeta2RegionMarkers {
	openRegion: string;
	closeRegion: string;
	stopTokens: string[];
}

export function getZeta2RegionMarkers(
	protocol: Zeta2Protocol,
): Zeta2RegionMarkers {
	if (protocol === "2.1") {
		return {
			openRegion: ZETA2_1_OPEN_MARKER,
			closeRegion: `${ZETA2_1_CLOSE_MARKER}\n`,
			stopTokens: ZETA2_1_STOP_TOKENS,
		};
	}
	return {
		openRegion: ZETA2_CURRENT_MARKER,
		closeRegion: ZETA2_SEPARATOR,
		stopTokens: ZETA2_STOP_TOKENS,
	};
}

const MAX_DIAGNOSTICS = 15;

// Zeta 2.1's V0318 marker-placement parameters. A boundary is considered
// after at least six lines, forced after sixteen lines, and may move forward
// by up to five lines to avoid starting a block on a structural tail.
const V0318_MIN_BLOCK_LINES = 6;
const V0318_MAX_BLOCK_LINES = 16;
const MAX_NUDGE_LINES = 5;

export interface Zeta2PromptOptions {
	diagRadius: number;
	rules: string;
	// Single-line comment prefix for the document's language. See sweep-
	// prompt.ts SweepPromptOptions.commentPrefix for rationale.
	commentPrefix: string;
	// Mega-hack toggle. See sweep-prompt's SweepPromptOptions field of
	// the same name.
	injectInlineDiagnostics: boolean;
	// Marker phrase between comment prefix and diagnostic body. See
	// SweepPromptOptions.inlineDiagnosticsMarker.
	inlineDiagnosticsMarker: string;
	// User-supplied regex transforms applied after built-in diagnostic
	// normalisations. See SweepPromptOptions.messageTransforms.
	messageTransforms: MessageTransform[];
	// Which Zeta SeedCoder protocol the configured model speaks. "2"
	// uses git-conflict markers around the editable region; "2.1" uses
	// numbered boundary markers and expects the model to return the two
	// boundaries surrounding its rewritten span.
	protocolVersion: Zeta2Protocol;
	// Provider-profile budgets estimated as UTF-8 bytes / 3. Excerpts grow
	// symmetrically from the cursor and remain aligned to whole lines, so
	// no tokenizer is needed in the extension host.
	editableTokens: number;
	contextTokens: number;
	// Total number of related excerpts. LSP retrieval is preferred over
	// visible/recent buffers so high-signal definitions survive the cap.
	maxRelatedChunks: number;
}

const DEFAULT_OPTIONS: Zeta2PromptOptions = {
	diagRadius: 12,
	rules: "",
	commentPrefix: "//",
	injectInlineDiagnostics: false,
	inlineDiagnosticsMarker: "BUG: LSP error here",
	messageTransforms: [],
	protocolVersion: "2",
	editableTokens: DEFAULT_EDITABLE_TOKENS,
	contextTokens: DEFAULT_ZETA_CONTEXT_TOKENS,
	maxRelatedChunks: DEFAULT_MAX_CONTEXT_FILES,
};

export interface ZetaCursorWindow {
	editableStart: number;
	editableEnd: number;
	contextStart: number;
	contextEnd: number;
}

/**
 * Select a contiguous, line-aligned cursor excerpt using Zeta's approximate
 * token budgets. Estimating one token per three UTF-8 bytes matches Zed's
 * cheap cursor-excerpt heuristic without putting a tokenizer on VS Code's
 * extension-host hot path.
 */
export function selectZetaCursorWindow(
	lines: string[],
	cursorLine: number,
	editableTokens: number,
	contextTokens: number,
): ZetaCursorWindow {
	return selectZetaCursorWindowFromLineProvider(
		lines.length,
		cursorLine,
		editableTokens,
		contextTokens,
		(line) => lines[line] ?? "",
	);
}

export function selectZetaCursorWindowFromLineProvider(
	lineCount: number,
	cursorLine: number,
	editableTokens: number,
	contextTokens: number,
	getLine: (line: number) => string,
): ZetaCursorWindow {
	if (lineCount === 0) {
		return {
			editableStart: 0,
			editableEnd: 0,
			contextStart: 0,
			contextEnd: 0,
		};
	}

	const boundedCursorLine = Math.min(Math.max(0, cursorLine), lineCount - 1);
	const editableBudgetBytes =
		Math.max(1, Math.floor(editableTokens)) * ESTIMATED_BYTES_PER_TOKEN;
	const cursorLineBytes = linePromptByteLength(
		lineCount,
		getLine,
		boundedCursorLine,
	);
	const editable = expandLineAlignedWindow(
		lineCount,
		getLine,
		boundedCursorLine,
		boundedCursorLine + 1,
		editableBudgetBytes,
		cursorLineBytes,
	);

	const contextBudgetBytes =
		Math.max(0, Math.floor(contextTokens)) * ESTIMATED_BYTES_PER_TOKEN;
	const context = expandLineAlignedWindow(
		lineCount,
		getLine,
		editable.start,
		editable.end,
		contextBudgetBytes,
		0,
	);

	return {
		editableStart: editable.start,
		editableEnd: editable.end,
		contextStart: context.start,
		contextEnd: context.end,
	};
}

function expandLineAlignedWindow(
	lineCount: number,
	getLine: (line: number) => string,
	initialStart: number,
	initialEnd: number,
	budgetBytes: number,
	initialBytes: number,
): { start: number; end: number } {
	let start = initialStart;
	let end = initialEnd;
	let usedBytes = initialBytes;
	let beforeOpen = start > 0;
	let afterOpen = end < lineCount;
	let preferBefore = true;

	while (beforeOpen || afterOpen) {
		let expanded = false;
		const sides = preferBefore
			? (["before", "after"] as const)
			: (["after", "before"] as const);

		for (const side of sides) {
			if (side === "before") {
				if (!beforeOpen) continue;
				const candidate = start - 1;
				const candidateBytes = linePromptByteLength(
					lineCount,
					getLine,
					candidate,
				);
				if (usedBytes + candidateBytes <= budgetBytes) {
					start = candidate;
					usedBytes += candidateBytes;
					beforeOpen = start > 0;
					preferBefore = false;
					expanded = true;
					break;
				}
				beforeOpen = false;
				continue;
			}

			if (!afterOpen) continue;
			const candidate = end;
			const candidateBytes = linePromptByteLength(
				lineCount,
				getLine,
				candidate,
			);
			if (usedBytes + candidateBytes <= budgetBytes) {
				end = candidate + 1;
				usedBytes += candidateBytes;
				afterOpen = end < lineCount;
				preferBefore = true;
				expanded = true;
				break;
			}
			afterOpen = false;
		}

		if (!expanded && !beforeOpen && !afterOpen) break;
	}

	return { start, end };
}

function linePromptByteLength(
	lineCount: number,
	getLine: (line: number) => string,
	line: number,
): number {
	const newlineBytes = line < lineCount - 1 ? 1 : 0;
	return Buffer.byteLength(getLine(line), "utf8") + newlineBytes;
}

export function buildZeta2Prompt(
	req: AutocompleteRequest,
	overrides: Partial<Zeta2PromptOptions> = {},
): ModelPrompt {
	const opts: Zeta2PromptOptions = { ...DEFAULT_OPTIONS, ...overrides };
	const lines = splitLines(req.file_contents);
	const lineOffsets = computeLineByteOffsets(lines);

	const { line: cursorLine, col: cursorCol } = locateCursor(
		lineOffsets,
		req.cursor_position,
	);

	const selectedWindow = selectZetaCursorWindow(
		lines,
		cursorLine,
		opts.editableTokens,
		opts.contextTokens,
	);
	const editableStart = selectedWindow.editableStart;
	const editableEnd = selectedWindow.editableEnd;
	const contextStart =
		opts.protocolVersion === "2.1" ? selectedWindow.contextStart : 0;
	const contextEnd =
		opts.protocolVersion === "2.1" ? selectedWindow.contextEnd : lines.length;
	const promptDiagnostics = req.editor_diagnostics;

	// `lines` reflects the actual document and is preserved on prompt.lines
	// for response mapping. `promptLines` is the rendered view that may
	// carry inline FIXME suffixes; the response builder strips those via
	// injectedFixmeMessages before line-diffing.
	const { promptLines, injectedFixmeMessages } = decorateLinesWithFixmes(
		lines,
		promptDiagnostics,
		cursorLine,
		opts,
	);

	// Zeta 2.1's "multi-region" format subdivides one contiguous cursor
	// excerpt with numbered boundaries. Diagnostics remain related context;
	// they do not create discontiguous editable windows.
	const primary: EditRegion = {
		startLine: editableStart,
		endLine: editableEnd,
		isPrimary: true,
	};
	const regions = [primary];

	let body = "";
	const contextStats: PromptContextStats = {};

	// The V0318 suffix contains only the trailing part of the selected
	// cursor context. Legacy Zeta2 keeps its previous full-file behaviour.
	const suffixLines = promptLines.slice(primary.endLine, contextEnd);
	body += FIM_SUFFIX;
	const suffixText = suffixLines.join("\n");
	contextStats.activeFileSuffix = suffixText.length;
	body += suffixText;
	body += suffixText.endsWith("\n") || suffixText === "" ? "" : "\n";
	if (suffixText === "") body += "\n";

	// Prefix section: <[fim-prefix]>{rules}{recent files}{edit_history}{outline}{diagnostics}{cursor file}
	body += FIM_PREFIX;

	// Workspace rules pseudo-file first inside the prefix block. Rules
	// are session-stable (only change when the user edits
	// .vscode/nes-{lang}.md) while every later pseudo-file is volatile,
	// so this maximises prefix-cache reuse across requests. NESweep
	// extension — cursortab's zeta2 has no equivalent slot.
	if (opts.rules !== "") {
		contextStats.rules = opts.rules.length;
		body += `${FILE_MARKER}context/rules\n${opts.rules}`;
		if (!opts.rules.endsWith("\n")) body += "\n";
		body += "\n";
	}

	// Zed fills this slot primarily with LSP-related excerpts. Prefer
	// definitions/usages/clipboard retrieval, omit current-file snippets
	// already visible in the local cursor window, then use visible/recent
	// buffers to fill the remaining fixed-size budget.
	const relatedChunks = selectZetaRelatedChunks(
		req.retrieval_chunks,
		req.file_chunks,
		req.file_path,
		contextStart,
		contextEnd,
		opts.maxRelatedChunks,
	);
	const relatedFilesText = formatRecentFilesPseudoFiles(relatedChunks);
	if (relatedFilesText !== "") {
		contextStats.relatedFiles = relatedFilesText.length;
		body += relatedFilesText;
	}

	// Preserve Zed's training-time edit-history-first order. In particular,
	// keep the suffix-first FIM layout above even though it limits prefix
	// cache reuse when the cursor moves.
	const editHistory = req.recent_changes.trim();
	const editHistoryText =
		editHistory === "" ? "" : `${FILE_MARKER}edit_history\n${editHistory}\n\n`;
	const diagnosticsText = opts.injectInlineDiagnostics
		? ""
		: formatDiagnosticsPseudoFile(
				promptDiagnostics,
				cursorLine + 1,
				opts.diagRadius,
				opts.commentPrefix,
				lines,
				lineOffsets,
				opts.messageTransforms,
			);

	if (editHistoryText !== "") {
		contextStats.editHistory = editHistory.length;
	}
	body += editHistoryText;

	// The active symbol is cursor-dependent, unlike the chronological history.
	// Keep it after history so cursor moves do not invalidate that prefix.
	const symbolOutline = req.symbol_outline?.trim() ?? "";
	if (symbolOutline !== "") {
		contextStats.outline = symbolOutline.length;
		body += `${FILE_MARKER}context/outline\n${symbolOutline}\n\n`;
	}

	if (diagnosticsText !== "") {
		contextStats.diagnostics = diagnosticsText.length;
	}
	body += diagnosticsText;

	// Cursor file section
	const cursorFileStart = body.length;
	body += `${FILE_MARKER}${req.file_path}\n`;

	// Render the selected leading context and the contiguous editable
	// excerpt. V0318 marker placement is deterministic and independent of
	// diagnostics. Zeta2.0 keeps its single CURRENT/======= scaffold.
	const markerResult = appendCursorFileBodyAndMarkers(
		(s) => {
			body += s;
		},
		promptLines,
		primary,
		contextStart,
		cursorLine,
		cursorCol,
		opts.protocolVersion,
	);
	body += FIM_MIDDLE;
	contextStats.activeFilePrefixAndEditable = body.length - cursorFileStart;

	return {
		prompt: body,
		contextStats,
		// FIM has no prefill — the model continues directly after <[fim-middle]>.
		prefill: "",
		format: opts.protocolVersion === "2.1" ? "zeta2.1" : "zeta2",
		stopTokens: markerResult.stopTokens,
		windowStartLine: primary.startLine,
		windowEndLine: primary.endLine,
		regions,
		...(markerResult.markerBoundaryLines
			? { markerBoundaryLines: markerResult.markerBoundaryLines }
			: {}),
		lines: lines.map((content, i) => ({
			startByte: lineOffsets[i] ?? 0,
			content,
		})),
		cursorLineByteOffsets: lineOffsets,
		...(injectedFixmeMessages.length > 0
			? {
					injectedFixmeMessages,
					commentPrefix: opts.commentPrefix,
					inlineDiagnosticsMarker: opts.inlineDiagnosticsMarker,
				}
			: {}),
	};
}

interface MarkerRenderResult {
	stopTokens: string[];
	markerBoundaryLines?: number[];
}

// Emit one contiguous editable excerpt. In 2.1, numbered markers subdivide
// that excerpt using Zed's V0318 boundary algorithm; a response may start at
// any marker and end at any later marker.
function appendCursorFileBodyAndMarkers(
	push: (s: string) => void,
	promptLines: string[],
	primary: EditRegion,
	contextStartLine: number,
	cursorLine: number,
	cursorCol: number,
	protocolVersion: Zeta2Protocol,
): MarkerRenderResult {
	if (protocolVersion === "2") {
		const beforeLines = promptLines.slice(0, primary.startLine);
		const editLines = promptLines.slice(primary.startLine, primary.endLine);
		const markers = getZeta2RegionMarkers("2");
		if (beforeLines.length > 0) push(`${beforeLines.join("\n")}\n`);
		push(markers.openRegion);
		const editableText = formatEditableWithCursor(
			editLines,
			cursorLine - primary.startLine,
			cursorCol,
		);
		push(editableText);
		if (!editableText.endsWith("\n")) push("\n");
		push(markers.closeRegion);
		return { stopTokens: markers.stopTokens };
	}

	const leadingContext = promptLines.slice(contextStartLine, primary.startLine);
	if (leadingContext.length > 0) {
		push(`${leadingContext.join("\n")}\n`);
	}

	const editableText = textForLineRange(
		promptLines,
		primary.startLine,
		primary.endLine,
	);
	const cursorOffsetInEditable = relativeCursorByte(
		promptLines,
		primary.startLine,
		cursorLine,
		cursorCol,
	);
	const rendered = renderV0318Editable(
		editableText,
		cursorOffsetInEditable,
		primary.startLine,
	);
	push(rendered.text);
	if (!rendered.text.endsWith("\n")) push("\n");

	// Never use a numbered boundary as a server stop token: a valid output
	// can begin with marker_2 (or any later boundary), and stopping on a
	// marker would either erase the closing boundary or terminate before
	// the replacement is generated. The model's native EOS is unambiguous.
	return {
		stopTokens: ZETA2_1_STOP_TOKENS,
		markerBoundaryLines: rendered.markerBoundaryLines,
	};
}

interface V0318LineInfo {
	startByte: number;
	isBlank: boolean;
	isGoodStart: boolean;
}

interface RenderedV0318Editable {
	text: string;
	markerBoundaryLines: number[];
}

function renderV0318Editable(
	editableText: string,
	cursorOffsetInEditable: number,
	editableStartLine: number,
): RenderedV0318Editable {
	const markerOffsets = computeV0318MarkerOffsets(editableText);
	const lineInfo = collectV0318LineInfo(editableText);
	const editableByteLength = Buffer.byteLength(editableText, "utf8");
	const boundedCursorOffset = Math.min(
		Math.max(0, cursorOffsetInEditable),
		editableByteLength,
	);
	const lineByStartByte = new Map(
		lineInfo.map((line, index) => [line.startByte, index]),
	);
	const markerBoundaryLines = markerOffsets.map((offset) => {
		if (offset === editableByteLength) {
			return editableStartLine + lineInfo.length;
		}
		return editableStartLine + (lineByStartByte.get(offset) ?? 0);
	});

	let text = "";
	let cursorPlaced = false;
	for (let i = 0; i < markerOffsets.length; i++) {
		const offset = markerOffsets[i];
		if (offset === undefined) continue;
		if (text !== "" && !text.endsWith("\n")) text += "\n";
		text += `<|marker_${i + 1}|>`;

		const nextOffset = markerOffsets[i + 1];
		if (nextOffset === undefined) continue;
		text += "\n";
		const startUtf16 = utf8ByteOffsetToUtf16Offset(editableText, offset);
		const endUtf16 = utf8ByteOffsetToUtf16Offset(editableText, nextOffset);
		const block = editableText.slice(startUtf16, endUtf16);
		if (
			!cursorPlaced &&
			boundedCursorOffset >= offset &&
			boundedCursorOffset <= nextOffset
		) {
			cursorPlaced = true;
			const cursorUtf16 = utf8ByteOffsetToUtf16Offset(
				block,
				boundedCursorOffset - offset,
			);
			text +=
				block.slice(0, cursorUtf16) +
				ZETA2_CURSOR_MARKER +
				block.slice(cursorUtf16);
		} else {
			text += block;
		}
	}

	return { text, markerBoundaryLines };
}

function computeV0318MarkerOffsets(editableText: string): number[] {
	if (editableText === "") return [0, 0];

	const lines = collectV0318LineInfo(editableText);
	const offsets = [0];
	let lastBoundaryLine = 0;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (!line) break;
		const gap = i - lastBoundaryLine;

		if (
			gap >= V0318_MIN_BLOCK_LINES &&
			!line.isBlank &&
			i > 0 &&
			lines[i - 1]?.isBlank
		) {
			const target = line.isGoodStart
				? i
				: (skipToGoodV0318Start(lines, i) ?? i);
			const targetLine = lines[target];
			if (
				targetLine &&
				lines.length - target >= V0318_MIN_BLOCK_LINES &&
				targetLine.startByte > (offsets.at(-1) ?? 0)
			) {
				offsets.push(targetLine.startByte);
				lastBoundaryLine = target;
				i = target + 1;
				continue;
			}
		}

		if (gap >= V0318_MAX_BLOCK_LINES) {
			const target = skipToGoodV0318Start(lines, i) ?? i;
			const targetLine = lines[target];
			if (targetLine && targetLine.startByte > (offsets.at(-1) ?? 0)) {
				offsets.push(targetLine.startByte);
				lastBoundaryLine = target;
				i = target + 1;
				continue;
			}
		}

		i++;
	}

	const end = Buffer.byteLength(editableText, "utf8");
	if ((offsets.at(-1) ?? 0) !== end) offsets.push(end);
	return offsets;
}

function collectV0318LineInfo(text: string): V0318LineInfo[] {
	if (text === "") return [];
	const lines: V0318LineInfo[] = [];
	let startByte = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const isBlank = trimmed === "";
		lines.push({
			startByte,
			isBlank,
			isGoodStart: !isBlank && !isStructuralTail(trimmed),
		});
		startByte += Buffer.byteLength(line, "utf8") + 1;
	}
	if (text.endsWith("\n") && lines.length > 1) lines.pop();
	return lines;
}

function skipToGoodV0318Start(
	lines: V0318LineInfo[],
	from: number,
): number | undefined {
	const end = Math.min(lines.length, from + MAX_NUDGE_LINES);
	for (let i = from; i < end; i++) {
		if (lines[i]?.isGoodStart) return i;
	}
	return undefined;
}

function isStructuralTail(trimmedLine: string): boolean {
	if (/^[}\])]/.test(trimmedLine)) return true;
	const withoutSemicolon = trimmedLine.replace(/;$/, "");
	return ["break", "continue", "return", "throw", "end"].includes(
		withoutSemicolon,
	);
}

function textForLineRange(
	lines: string[],
	startLine: number,
	endLine: number,
): string {
	let text = lines.slice(startLine, endLine).join("\n");
	if (endLine < lines.length && !text.endsWith("\n")) text += "\n";
	return text;
}

function relativeCursorByte(
	lines: string[],
	startLine: number,
	cursorLine: number,
	cursorCol: number,
): number {
	let offset = 0;
	for (let i = startLine; i < cursorLine; i++) {
		offset += Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
	}
	return offset + cursorCol;
}

function decorateLinesWithFixmes(
	lines: string[],
	diagnostics: EditorDiagnostic[],
	cursorLine: number,
	opts: Zeta2PromptOptions,
): { promptLines: string[]; injectedFixmeMessages: string[] } {
	if (!opts.injectInlineDiagnostics || diagnostics.length === 0) {
		return { promptLines: lines, injectedFixmeMessages: [] };
	}
	const cursorLine1 = cursorLine + 1;
	// See sweep-prompt.ts decorateLinesWithFixmes for the format / strip
	// anchor rationale.
	type Entry = { message: string; code: string | undefined };
	const byLine = new Map<number, Entry[]>();
	for (const d of diagnostics) {
		if (
			opts.diagRadius > 0 &&
			Math.abs(d.line - cursorLine1) > opts.diagRadius
		) {
			continue;
		}
		const arr = byLine.get(d.line - 1) ?? [];
		arr.push({
			message: normalizeDiagnosticMessage(d.message, opts.messageTransforms),
			code: d.code,
		});
		byLine.set(d.line - 1, arr);
	}
	if (byLine.size === 0) {
		return { promptLines: lines, injectedFixmeMessages: [] };
	}
	const messages: string[] = [];
	const promptLines = lines.map((line, i) => {
		const entries = byLine.get(i);
		if (!entries) return line;
		const joinedMsg = entries.map((e) => e.message).join(" / ");
		const codes = entries
			.map((e) => e.code)
			.filter((c): c is string => Boolean(c));
		const codePart = codes.length > 0 ? ` (code: ${codes.join(",")})` : "";
		messages.push(joinedMsg);
		return `${line} ${opts.commentPrefix} ${opts.inlineDiagnosticsMarker}${codePart} - ${joinedMsg}`;
	});
	return { promptLines, injectedFixmeMessages: messages };
}

function formatEditableWithCursor(
	editLines: string[],
	cursorRelLine: number,
	cursorCol: number,
): string {
	if (editLines.length === 0) return ZETA2_CURSOR_MARKER;
	let relLine = cursorRelLine;
	if (relLine < 0) relLine = 0;
	if (relLine >= editLines.length) relLine = editLines.length - 1;

	const out = editLines.slice();
	const line = out[relLine] ?? "";
	let col = cursorCol;
	if (col > line.length) col = line.length;
	if (col < 0) col = 0;
	out[relLine] = line.slice(0, col) + ZETA2_CURSOR_MARKER + line.slice(col);
	return out.join("\n");
}

function formatRecentFilesPseudoFiles(chunks: FileChunk[]): string {
	let out = "";
	for (const chunk of chunks) {
		if (chunk.content.trim() === "") continue;
		out += `${FILE_MARKER}${chunk.file_path}\n${chunk.content}`;
		if (!chunk.content.endsWith("\n")) out += "\n";
		out += "\n";
	}
	return out;
}

function selectZetaRelatedChunks(
	retrievalChunks: FileChunk[],
	recentChunks: FileChunk[],
	currentFilePath: string,
	contextStartLine0: number,
	contextEndLine0: number,
	maxChunks: number,
): FileChunk[] {
	const limit = Math.max(0, Math.floor(maxChunks));
	if (limit === 0) return [];

	const isUsable = (chunk: FileChunk): boolean => {
		if (chunk.content.trim() === "") return false;
		if (chunk.file_path !== currentFilePath) return true;

		// LSP chunks use 1-indexed inclusive lines. Keep current-file
		// definitions/references only when they add code outside the local
		// 0-indexed half-open cursor context already rendered below.
		const chunkStartLine0 = Math.max(0, chunk.start_line - 1);
		const chunkEndLine0 = Math.max(chunkStartLine0, chunk.end_line);
		return (
			chunkEndLine0 <= contextStartLine0 || chunkStartLine0 >= contextEndLine0
		);
	};

	const codeRetrieval = retrievalChunks.filter(
		(chunk) => chunk.file_path !== "clipboard.txt" && isUsable(chunk),
	);
	const clipboard = retrievalChunks.find(
		(chunk) => chunk.file_path === "clipboard.txt" && isUsable(chunk),
	);
	const usableRecentChunks = recentChunks.filter(isUsable);
	const candidates = [...codeRetrieval, ...usableRecentChunks];
	const capacity = Math.max(0, limit - (clipboard ? 1 : 0));
	const selected: FileChunk[] = [];
	const deferred: FileChunk[] = [];
	const seenPaths = new Set<string>();
	const seenContent = new Set<string>();

	const add = (chunk: FileChunk): boolean => {
		const key = `${chunk.file_path}\u0000${chunk.content.trim()}`;
		if (seenContent.has(key)) return false;
		seenContent.add(key);
		selected.push(chunk);
		return true;
	};

	// First pass maximises file diversity. A second excerpt from the same
	// file is useful, but only after definitions from other files and
	// visible/recent buffers each had a chance to contribute.
	if (capacity > 0) {
		for (const chunk of candidates) {
			if (seenPaths.has(chunk.file_path)) {
				deferred.push(chunk);
				continue;
			}
			if (add(chunk)) seenPaths.add(chunk.file_path);
			if (selected.length >= capacity) break;
		}
	}
	if (selected.length < capacity) {
		for (const chunk of deferred) {
			add(chunk);
			if (selected.length >= capacity) break;
		}
	}

	if (clipboard && selected.length < limit) add(clipboard);
	return selected.slice(0, limit);
}

function formatDiagnosticsPseudoFile(
	diagnostics: EditorDiagnostic[],
	cursorLine1: number,
	diagRadius: number,
	commentPrefix: string,
	lines: string[],
	lineOffsets: number[],
	messageTransforms: MessageTransform[],
): string {
	if (diagnostics.length === 0) return "";

	const filtered =
		diagRadius > 0
			? diagnostics.filter((d) => Math.abs(d.line - cursorLine1) <= diagRadius)
			: diagnostics;
	if (filtered.length === 0) return "";

	const limited = filtered.slice(0, MAX_DIAGNOSTICS);
	const body = renderDiagnosticsAsComments(
		limited,
		commentPrefix,
		lines,
		lineOffsets,
		messageTransforms,
	);
	return `${FILE_MARKER}diagnostics\n${body}\n`;
}
