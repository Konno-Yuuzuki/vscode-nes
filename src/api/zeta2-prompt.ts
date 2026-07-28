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
// files inside the prefix block are ordered for prefix-cache friendliness:
// rules first (session-stable), then volatile context, with diagnostics
// last so the model sees them adjacent to the cursor file's editable
// region.
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
// 2.1 numbered markers are boundaries inside one editable excerpt. The
// model returns one span from any marker N to a later marker M:
// "<|marker_N|>\n{replacement}\n<|marker_M|>". The response parser maps
// those two boundary numbers back to document offsets.

import type { MessageTransform } from "~/core/config.ts";
import type { EditRegion, ModelPrompt } from "./model-format.ts";
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

// Zed's cloud Zeta2 endpoint targets ±350 / ±150 token budgets for the
// editable / context regions. We approximate with line counts since we
// don't carry a tokenizer; the model is robust enough that ±15 lines
// around the cursor lands within the trained budget.
const EDITABLE_LINES_BEFORE = 15;
const EDITABLE_LINES_AFTER = 15;

const MAX_DIAGNOSTICS = 15;

// Multi-region tunables (zeta2.1 only). A "diagnostic region" is a small
// ±halo window around an LSP diagnostic that sits OUTSIDE the primary
// cursor window — included so the model can fix several issues in one
// round-trip. Cap the total region count so the prompt doesn't sprawl.
const DIAG_REGION_HALO_LINES = 2;
const MAX_REGIONS = 3; // 1 cursor + up to 2 diagnostic regions

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
}

const DEFAULT_OPTIONS: Zeta2PromptOptions = {
	diagRadius: 12,
	rules: "",
	commentPrefix: "//",
	injectInlineDiagnostics: false,
	inlineDiagnosticsMarker: "BUG: LSP error here",
	messageTransforms: [],
	protocolVersion: "2",
};

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

	const editableStart = Math.max(0, cursorLine - EDITABLE_LINES_BEFORE);
	const editableEnd = Math.min(
		lines.length,
		cursorLine + EDITABLE_LINES_AFTER + 1,
	);

	// `lines` reflects the actual document and is preserved on prompt.lines
	// for response mapping. `promptLines` is the rendered view that may
	// carry inline FIXME suffixes; the response builder strips those via
	// injectedFixmeMessages before line-diffing.
	const { promptLines, injectedFixmeMessages } = decorateLinesWithFixmes(
		lines,
		req.editor_diagnostics,
		cursorLine,
		opts,
	);

	// Compute editable regions. zeta2.1 supports multi-region edits; we
	// always include the primary cursor region, plus up to MAX_REGIONS-1
	// non-overlapping windows around nearby diagnostics so the model can
	// fix several issues in one response. zeta2.0 / sweep ignore the
	// extras (multi-region isn't part of those formats).
	const regions = computeEditRegions(
		cursorLine,
		lines.length,
		editableStart,
		editableEnd,
		req.editor_diagnostics,
		opts,
	);
	const primary = regions.find((r) => r.isPrimary) ?? regions[0];
	if (!primary) {
		throw new Error("zeta2 prompt: no primary editable region computed");
	}

	let body = "";

	// Suffix section: <[fim-suffix]>{code after the LAST editable region}\n
	// In single-region prompts this is just the code after the cursor
	// window; in multi-region prompts it's the code after the highest
	// region. Code BETWEEN regions stays in the cursor file body so each
	// region's surrounding context is preserved.
	const lastRegion = regions[regions.length - 1];
	if (!lastRegion) {
		throw new Error("zeta2 prompt: regions must be non-empty");
	}
	const suffixLines = promptLines.slice(lastRegion.endLine);
	body += FIM_SUFFIX;
	const suffixText = suffixLines.join("\n");
	body += suffixText;
	body += suffixText.endsWith("\n") || suffixText === "" ? "" : "\n";
	if (suffixText === "") body += "\n";

	// Prefix section: <[fim-prefix]>{rules}{recent files}{edit_history}{diagnostics}{cursor file}
	body += FIM_PREFIX;

	// Workspace rules pseudo-file first inside the prefix block. Rules
	// are session-stable (only change when the user edits
	// .vscode/nes-{lang}.md) while every later pseudo-file is volatile,
	// so this maximises prefix-cache reuse across requests. NESweep
	// extension — cursortab's zeta2 has no equivalent slot.
	if (opts.rules !== "") {
		body += `${FILE_MARKER}context/rules\n${opts.rules}`;
		if (!opts.rules.endsWith("\n")) body += "\n";
		body += "\n";
	}

	// Recent buffers as pseudo-files. Cursortab fills this slot with
	// LSP-related files; we use file_chunks (visible editors + recent
	// buffers) as the closest proxy.
	body += formatRecentFilesPseudoFiles(req.file_chunks);

	// Edit history pseudo-file. The upstream emits a git-style unified
	// diff per event; our recent_changes string is already pre-formatted
	// per file with `File: {path}:` headers (see formatRecentChanges in
	// client.ts), so we emit it verbatim — the model is tolerant enough
	// to read it.
	const editHistory = req.recent_changes.trim();
	if (editHistory !== "") {
		body += `${FILE_MARKER}edit_history\n${editHistory}\n\n`;
	}

	// Diagnostics last among context pseudo-files — sits immediately
	// before the cursor file with its CURRENT/UPDATED markers, so the
	// model attends to the latest LSP errors when generating the edit.
	// Skipped when inline injection is on: the per-line `BUG:` comments
	// in the cursor file already surface the same diagnostics, so the
	// structured pseudo-file would just duplicate the data.
	if (!opts.injectInlineDiagnostics) {
		body += formatDiagnosticsPseudoFile(
			req.editor_diagnostics,
			cursorLine + 1,
			opts.diagRadius,
			opts.commentPrefix,
			lines,
			lineOffsets,
			opts.messageTransforms,
		);
	}

	// Cursor file section
	body += `${FILE_MARKER}${req.file_path}\n`;

	// Render leading context + every editable region in order. For 2.1,
	// each marker is a boundary in one continuous excerpt: region starts
	// and ends contribute consecutive numbered boundaries, while code
	// between focused regions remains editable context between those
	// boundaries. 2.0 keeps its single CURRENT/======= scaffold.
	const stopTokens = appendCursorFileBodyAndMarkers(
		(s) => {
			body += s;
		},
		promptLines,
		regions,
		cursorLine,
		cursorCol,
		opts.protocolVersion,
	);
	body += FIM_MIDDLE;

	return {
		prompt: body,
		// FIM has no prefill — the model continues directly after <[fim-middle]>.
		prefill: "",
		format: opts.protocolVersion === "2.1" ? "zeta2.1" : "zeta2",
		stopTokens,
		windowStartLine: primary.startLine,
		windowEndLine: primary.endLine,
		regions,
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

// Emit every region with numbered boundaries and unchanged context between
// them. In 2.1 the markers are not independent open/close pairs: a model
// response may start at any marker and end at any later marker. Returns the
// model's EOS token for 2.1 and the fixed `>>>>>>> UPDATED` token for 2.0.
function appendCursorFileBodyAndMarkers(
	push: (s: string) => void,
	promptLines: string[],
	regions: EditRegion[],
	cursorLine: number,
	cursorCol: number,
	protocolVersion: Zeta2Protocol,
): string[] {
	if (protocolVersion === "2") {
		// 2.0 has no multi-region support — the model only knows about
		// a single CURRENT/=======​ pair. Use the primary region only.
		const primary = regions.find((r) => r.isPrimary) ?? regions[0];
		if (!primary) {
			throw new Error("zeta2 prompt: regions must be non-empty");
		}
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
		return markers.stopTokens;
	}

	// 2.1: emit monotonically numbered boundaries throughout one editable
	// excerpt. A focused region contributes two boundaries; the unchanged
	// lines between focused regions sit between the previous end boundary
	// and the next start boundary.
	let prevEnd = 0;
	for (let i = 0; i < regions.length; i++) {
		const r = regions[i];
		if (!r) continue;
		const openNum = i * 2 + 1;
		const closeNum = i * 2 + 2;
		// Lines between the previous region's end and this region's start.
		if (r.startLine > prevEnd) {
			push(`${promptLines.slice(prevEnd, r.startLine).join("\n")}\n`);
		}
		push(`<|marker_${openNum}|>\n`);
		const regionLines = promptLines.slice(r.startLine, r.endLine);
		const text = r.isPrimary
			? formatEditableWithCursor(
					regionLines,
					cursorLine - r.startLine,
					cursorCol,
				)
			: regionLines.join("\n");
		push(text);
		if (!text.endsWith("\n")) push("\n");
		push(`<|marker_${closeNum}|>\n`);
		prevEnd = r.endLine;
	}
	// Never use a numbered boundary as a server stop token: a valid output
	// can begin with marker_2 (or any later boundary), and stopping on a
	// marker would either erase the closing boundary or terminate before
	// the replacement is generated. The model's native EOS is unambiguous.
	return ZETA2_1_STOP_TOKENS;
}

// Compute the editable regions for a request. Always includes the
// primary cursor region (±EDITABLE_LINES_BEFORE/AFTER lines around
// cursor). For zeta2.1, additionally folds in up to MAX_REGIONS-1
// non-overlapping windows centred on diagnostics that fall outside the
// cursor region — closest-to-cursor first. zeta2.0 returns just the
// primary (multi-region isn't part of that format).
function computeEditRegions(
	cursorLine: number,
	lineCount: number,
	editableStart: number,
	editableEnd: number,
	diagnostics: EditorDiagnostic[],
	opts: Zeta2PromptOptions,
): EditRegion[] {
	const primary: EditRegion = {
		startLine: editableStart,
		endLine: editableEnd,
		isPrimary: true,
	};
	if (opts.protocolVersion !== "2.1") return [primary];

	const cursorLine1 = cursorLine + 1;
	// Order diagnostics by distance from cursor — closest get a region
	// first, capacity-permitting.
	const candidates = diagnostics
		.filter(
			(d) =>
				opts.diagRadius === 0 ||
				Math.abs(d.line - cursorLine1) <= opts.diagRadius,
		)
		.filter((d) => d.line - 1 < editableStart || d.line - 1 >= editableEnd)
		.sort(
			(a, b) => Math.abs(a.line - cursorLine1) - Math.abs(b.line - cursorLine1),
		);

	const regions: EditRegion[] = [primary];
	for (const d of candidates) {
		if (regions.length >= MAX_REGIONS) break;
		const dLine = d.line - 1;
		const start = Math.max(0, dLine - DIAG_REGION_HALO_LINES);
		const end = Math.min(lineCount, dLine + DIAG_REGION_HALO_LINES + 1);
		// Skip if it would overlap any region we've already accepted;
		// overlapping focus windows would produce non-monotonic boundaries.
		const overlaps = regions.some(
			(r) => start < r.endLine && end > r.startLine,
		);
		if (overlaps) continue;
		regions.push({ startLine: start, endLine: end, isPrimary: false });
	}

	// Emit order is by start line (open markers must be ascending).
	regions.sort((a, b) => a.startLine - b.startLine);
	return regions;
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
