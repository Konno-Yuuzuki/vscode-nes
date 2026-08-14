// Selects which prompt-format dialect we speak based on the configured
// model name. Each backend (sweep next-edit, Zed's Zeta2/2.1 SeedCoder)
// has its own prompt layout and stop tokens, but they share the same
// response shape (replace a slice of the buffer with new lines), so
// dispatch happens at prompt-builder + response-parser level only.
//
// "zeta2" and "zeta2.1" share most of their FIM scaffolding; the only
// differences are the editable-region markers and the stop tokens, so
// they're handled by the same builder/parser parameterised on the
// protocol version (see zeta2-prompt.ts).

export type ModelFormat = "zeta2" | "zeta2.1";

export interface PromptLine {
	startByte: number;
	content: string;
}

// One editable region inside the prompt. Zeta2.1 subdivides its single
// contiguous region with markerBoundaryLines; sweep / zeta2.0 use one region
// without numbered boundaries.
export interface EditRegion {
	// 0-indexed half-open line range in the document.
	startLine: number;
	endLine: number;
	// True for the region that contains the cursor — drives ghost-text
	// vs. jump-edit classification on the editor side.
	isPrimary: boolean;
}

export interface PromptContextStats {
	activeFileSuffix?: number;
	rules?: number;
	relatedFiles?: number;
	outline?: number;
	editHistory?: number;
	diagnostics?: number;
	activeFilePrefixAndEditable?: number;
}

// Common output of every prompt builder. The response parser uses
// windowStartLine / windowEndLine + lines + cursorLineByteOffsets to map
// the model's text output back to a byte-offset edit on the user's buffer.
export interface ModelPrompt {
	prompt: string;
	// Cheap observability for prompt composition. Values are UTF-16
	// character counts, not tokenizer counts, so collecting them does not
	// add model/tokenizer work to the VS Code extension host.
	contextStats?: PromptContextStats;
	// Text the model is expected to "continue" from. Sweep uses this to seed
	// the updated/{path} section; Zeta2's FIM layout has nothing to prefill,
	// so this is "" for that format.
	prefill: string;
	format: ModelFormat;
	stopTokens: string[];
	// Line range (0-indexed half-open) the response replaces. For sweep
	// this is the full original/current/updated window; for zeta2 / 2.1
	// it's the editable region around the cursor.
	windowStartLine: number;
	windowEndLine: number;
	// Always non-empty. Retained as a common representation for the legacy
	// Sweep/Zeta2 response paths; Zeta2.1 now has one contiguous region.
	regions: EditRegion[];
	// Absolute document line boundaries corresponding to <|marker_1|>,
	// <|marker_2|>, ... in a Zeta2.1 prompt. Interior boundaries divide the
	// editable excerpt into Zed V0318-style blocks. At a newline-terminated
	// EOF the last entry is the logical EOF line, before splitLines' phantom
	// trailing empty element.
	markerBoundaryLines?: number[];
	// Full file lines + byte offsets. The response parser indexes into these
	// to produce a UTF-8 byte-offset edit. These reflect the *undecorated*
	// document; if injectInlineDiagnostics added FIXME suffixes, those live
	// in the rendered prompt only and are stripped from the response via
	// injectedFixmeMessages.
	lines: PromptLine[];
	cursorLineByteOffsets: number[];
	// Diagnostic messages whose inline `<commentPrefix> <marker>` form
	// was injected into the rendered prompt. Non-empty signals the
	// response parser to run the strip; the array's contents are
	// retained for diagnostics/debug logging.
	injectedFixmeMessages?: string[];
	// Comment prefix used to wrap the injected FIXMEs ("//", "#", "--").
	// Combined with inlineDiagnosticsMarker to form the strip anchor.
	commentPrefix?: string;
	// Marker phrase between the comment prefix and the diagnostic
	// body — e.g. "BUG: LSP error here". The literal substring
	// `<commentPrefix> <marker>` is the strip anchor, so this must
	// match what the prompt builder emitted.
	inlineDiagnosticsMarker?: string;
}

export function detectModelFormat(modelName: string): ModelFormat {
	const lower = modelName.toLowerCase();
	// 2.1 must be checked first — "zeta-2.1" contains the substring
	// "zeta-2" so a 2-first ordering would mis-detect it as 2.0.
	if (
		lower.includes("zeta-2.1") ||
		lower.includes("zeta2.1") ||
		lower.includes("zeta-2-1") ||
		lower.includes("zeta_2_1")
	) {
		return "zeta2.1";
	}
	if (
		lower.includes("zeta-2") ||
		lower.includes("zeta2") ||
		lower.includes("seedcoder") ||
		lower.includes("seed-coder") ||
		lower.includes("zed-industries/zeta")
	) {
		return "zeta2";
	}
	return "zeta2";
}
