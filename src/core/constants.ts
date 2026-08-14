// Default configuration
export const DEFAULT_MAX_CONTEXT_FILES = 5;
// Document Symbols can require an LSP round-trip on every document version.
// Keep this optional by default; users can opt in when their language server
// is responsive and the extra structural context is worth the work.
export const DEFAULT_OUTLINE_SYMBOLS = 0;
// Overall cap on the recent-edit diffs surfaced in the prompt. Budget is
// partitioned at read time: a 20% floor for the active file, ~40% spread
// across other recent files (capped by DEFAULT_MAX_CONTEXT_FILES), the
// remainder fills from the active file's recent activity.
export const DEFAULT_MAX_EDIT_HISTORY = 15;
// Character budget for the rendered recent_changes prompt section. The edit
// history count cap limits records, not record size; bulk edits can otherwise
// contribute tens of thousands of chars each.
export const DEFAULT_MAX_RECENT_CHANGES_CHARS = 12000;
export const DEFAULT_SERVER_URL = "http://localhost:8080";
export const DEFAULT_COMPLETION_TIMEOUT_MS = 10_000;
// Moving outside a model's prior editable window is a meaningful context
// change even without a document edit. Keep the retrigger opt-in separately
// configurable from VS Code's normal typing-trigger debounce.
export const DEFAULT_RETRIGGER_ON_CONTEXT_EXIT = false;
export const DEFAULT_CONTEXT_EXIT_RETRIGGER_DEBOUNCE_MS = 1_500;
// Give VS Code a moment to finish its native "Tab to jump" cursor move
// before asking the inline provider for the next edit at that target.
export const JUMP_RETRIGGER_DELAY_MS = 100;
// Drop diagnostics whose line is more than this many lines from the cursor.
// VSCode hands us the entire file's diagnostic set per request; keeping all
// of them dominates the prompt for files with a chatty linter.
export const DEFAULT_DIAG_RADIUS = 12;
// Shared current-file budget for Sweep's broad context and Zeta's editable
// excerpt. Zeta deliberately avoids loading a tokenizer into the extension
// host: prompt builders estimate one token per three UTF-8 bytes and retain
// whole lines around the cursor.
export const DEFAULT_EDITABLE_TOKENS = 2_000;
export const DEFAULT_ZETA_CONTEXT_TOKENS = 150;
export const ESTIMATED_BYTES_PER_TOKEN = 3;
// Zed's V0318 provider sends at most six edit events. The client selects
// the newest six and renders them chronologically so the previous prompt
// remains a prefix while the history is still filling.
export const ZETA_TRAINING_TEMPLATE_MAX_EDIT_EVENTS = 6;

// Model parameters
export const MODEL_NAME = "sweepai/sweep-next-edit";
// Stay generous: the sweep model rewrites the whole edit window even when
// only one line changed, so a too-low cap truncates mid-window. Without
// cursortab's anchor-based truncation handling, a truncated response yields
// a corrupt line-diff (window tail no longer matches), so we just reject
// finish_reason=length completions in sweep-completion. Keep num_predict
// high enough that healthy responses never hit this cap.
export const MAX_TOKENS = 2048;
export const TEMPERATURE = 0.0;

// File size guards (match JetBrains defaults)
export const AUTOCOMPLETE_MAX_FILE_SIZE = 10_000_000;
export const AUTOCOMPLETE_MAX_LINES = 50_000;
export const AUTOCOMPLETE_AVG_LINE_LENGTH_THRESHOLD = 240;

// Soft cap on per-language rules files. The body is wrapped as comments
// and spliced into the prefix of every completion prompt — cache-friendly
// on a server with prefix caching (llama.cpp -cpent, vLLM/sglang), so
// the steady-state cost is mainly the context budget consumed, plus a
// prompt-eval spike on each save (cache invalidation). ~3000 chars is
// roughly 1000 tokens on the Sweep tokenizer.
export const DEFAULT_RULES_MAX_CHARS = 3000;
