import * as path from "node:path";
import * as vscode from "vscode";

import {
	DEFAULT_COMPLETION_TIMEOUT_MS,
	DEFAULT_CONTEXT_EXIT_RETRIGGER_DEBOUNCE_MS,
	DEFAULT_DIAG_RADIUS,
	DEFAULT_EDITABLE_TOKENS,
	DEFAULT_MAX_CONTEXT_FILES,
	DEFAULT_MAX_EDIT_HISTORY,
	DEFAULT_MAX_RECENT_CHANGES_CHARS,
	DEFAULT_OUTLINE_SYMBOLS,
	DEFAULT_RETRIGGER_ON_CONTEXT_EXIT,
	DEFAULT_RULES_MAX_CHARS,
	DEFAULT_SERVER_URL,
	DEFAULT_ZETA_CONTEXT_TOKENS,
	MODEL_NAME,
} from "~/core/constants.ts";

const SWEEP_CONFIG_SECTION = "sweep";

export interface MessageTransform {
	pattern: string;
	replacement: string;
	flags: string;
}

export class SweepConfig {
	private get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(SWEEP_CONFIG_SECTION);
	}

	get enabled(): boolean {
		return this.config.get<boolean>("enabled", true);
	}

	get streamEnabled(): boolean {
		return this.config.get<boolean>("streamEnabled", true);
	}

	/**
	 * Include clipboard content as context in the prompt. Disabled by default
	 * because clipboard text (error messages, logs, terminal output) often
	 * confuses the model more than it helps.
	 */
	get includeClipboard(): boolean {
		return this.config.get<boolean>("includeClipboard", false);
	}

	/**
	 * Sampling temperature for the model. Lower values (0.0–0.2) are more
	 * deterministic; higher values (0.3–0.8) increase creativity.
	 */
	get temperature(): number {
		return this.config.get<number>("temperature", 0.0);
	}

	get maxContextFiles(): number {
		return this.nonNegativeInteger(
			"maxContextFiles",
			DEFAULT_MAX_CONTEXT_FILES,
		);
	}

	get outlineSymbols(): number {
		return this.nonNegativeInteger("outlineSymbols", DEFAULT_OUTLINE_SYMBOLS);
	}

	get maxEditHistory(): number {
		return this.config.get<number>("maxEditHistory", DEFAULT_MAX_EDIT_HISTORY);
	}

	get maxRecentChangesChars(): number {
		return this.config.get<number>(
			"maxRecentChangesChars",
			DEFAULT_MAX_RECENT_CHANGES_CHARS,
		);
	}

	get includeClipboardContext(): boolean {
		return this.config.get<boolean>("includeClipboardContext", true);
	}

	get stableRetrievalOrdering(): boolean {
		return this.config.get<boolean>("stableRetrievalOrdering", false);
	}

	get reuseIdenticalPromptResults(): boolean {
		return this.config.get<boolean>("reuseIdenticalPromptResults", false);
	}

	get identicalPromptCacheTtlMs(): number {
		return Math.max(
			0,
			this.config.get<number>("identicalPromptCacheTtlMs", 5000),
		);
	}

	get autocompleteExclusionPatterns(): string[] {
		return this.config.get<string[]>("autocompleteExclusionPatterns", []);
	}

	get autocompleteSnoozeUntil(): number {
		return this.config.get<number>("autocompleteSnoozeUntil", 0);
	}

	get useCopilotStyleNextEditPresentation(): boolean {
		return this.config.get<boolean>(
			"useCopilotStyleNextEditPresentation",
			false,
		);
	}

	/**
	 * Stream completions over SSE when the server supports it. Falls back to
	 * a single-shot request when the server rejects the stream flag.
	 */
	get streamEnabled(): boolean {
		return this.config.get<boolean>("streamEnabled", true);
	}

	get serverUrl(): string {
		return this.config.get<string>("serverUrl", DEFAULT_SERVER_URL);
	}

	get modelName(): string {
		return this.config.get<string>("modelName", MODEL_NAME);
	}

	get completionTimeoutMs(): number {
		return this.config.get<number>(
			"completionTimeoutMs",
			DEFAULT_COMPLETION_TIMEOUT_MS,
		);
	}

	get retriggerOnContextExit(): boolean {
		return this.config.get<boolean>(
			"retriggerOnContextExit",
			DEFAULT_RETRIGGER_ON_CONTEXT_EXIT,
		);
	}

	get contextExitRetriggerDebounceMs(): number {
		return this.nonNegativeInteger(
			"contextExitRetriggerDebounceMs",
			DEFAULT_CONTEXT_EXIT_RETRIGGER_DEBOUNCE_MS,
		);
	}

	get diagRadius(): number {
		return this.config.get<number>("diagRadius", DEFAULT_DIAG_RADIUS);
	}

	get editableTokens(): number {
		return Math.max(
			1,
			this.nonNegativeInteger("editableTokens", DEFAULT_EDITABLE_TOKENS),
		);
	}

	get zetaContextTokens(): number {
		return this.nonNegativeInteger(
			"zetaContextTokens",
			DEFAULT_ZETA_CONTEXT_TOKENS,
		);
	}

	get rulesMaxChars(): number {
		return this.config.get<number>("rulesMaxChars", DEFAULT_RULES_MAX_CHARS);
	}

	private nonNegativeInteger(key: string, fallback: number): number {
		return Math.max(0, Math.floor(this.config.get<number>(key, fallback)));
	}

	// Recommended for the small SweepAI checkpoints (0.5B and 1.5B) that
	// ignore the structured diagnostics section. 7B SweepAI default and
	// 8B Zeta2 SeedCoder don't need it. Appends a `// <marker> (code:
	// <code>) - <message>` comment next to every nearby diagnosed line
	// in the rendered prompt; the response is then run through a strip
	// that anchors on the literal `<commentPrefix> <marker>` substring.
	get injectInlineDiagnostics(): boolean {
		return this.config.get<boolean>("injectInlineDiagnostics", false);
	}

	// Marker text inserted between the language's comment prefix and the
	// diagnostic message in the inline-injection format, e.g. for
	// `// BUG: LSP error here (code: …) - <msg>` the marker is
	// `BUG: LSP error here`. The literal `<commentPrefix> <marker>`
	// substring is the strip anchor — pick something a human author
	// would never type. Per-user/per-project tuning is useful because
	// different small models seem to attend to different phrasings.
	get inlineDiagnosticsMarker(): string {
		return this.config.get<string>(
			"inlineDiagnosticsMarker",
			"BUG: LSP error here",
		);
	}

	// Additional regex transforms applied to every diagnostic message
	// (both the structured diagnostics section and the inline `BUG:`
	// injection) AFTER the built-in normalisations (strip "(fix
	// available)", rewrite "did you mean 'X'?" to "use 'X' instead",
	// etc). Configured as an object so VS Code's settings UI renders a
	// key/value table editor (the same one that powers
	// editor.unicodeHighlight.allowedLocales). Key is the regex source,
	// value is the replacement string (`$1`/`$2` for capture groups);
	// flags are hardcoded to "i" (case-insensitive).
	get diagnosticsMessageTransforms(): MessageTransform[] {
		const raw = this.config.get<unknown>("diagnosticsMessageTransforms", {});
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
		const out: MessageTransform[] = [];
		for (const [pattern, replacement] of Object.entries(raw)) {
			if (typeof replacement !== "string") continue;
			out.push({ pattern, replacement, flags: "i" });
		}
		return out;
	}

	isAutocompleteSnoozed(now = Date.now()): boolean {
		const snoozeUntil = this.autocompleteSnoozeUntil;
		return snoozeUntil > now;
	}

	getAutocompleteSnoozeRemainingMs(now = Date.now()): number | null {
		const snoozeUntil = this.autocompleteSnoozeUntil;
		if (!snoozeUntil) return null;
		return Math.max(0, snoozeUntil - now);
	}

	shouldExcludeFromAutocomplete(filePath: string): boolean {
		const patterns = this.autocompleteExclusionPatterns.filter(Boolean);
		if (patterns.length === 0) return false;
		const fileName = path.basename(filePath);
		const normalizedPath = filePath.replace(/\\/g, "/");
		return patterns.some((pattern) => {
			const trimmed = pattern.trim();
			if (!trimmed) return false;
			if (trimmed.includes("*")) {
				const regex = globToRegex(trimmed);
				return regex.test(normalizedPath);
			}
			return fileName.endsWith(trimmed) || normalizedPath.endsWith(trimmed);
		});
	}

	inspect<T>(key: string) {
		return this.config.inspect<T>(key);
	}

	setEnabled(
		value: boolean,
		target: vscode.ConfigurationTarget = this.getWorkspaceTarget(),
	): Thenable<void> {
		return this.config.update("enabled", value, target);
	}

	setAutocompleteSnoozeUntil(
		value: number,
		target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
	): Thenable<void> {
		return this.config.update("autocompleteSnoozeUntil", value, target);
	}

	private getWorkspaceTarget(): vscode.ConfigurationTarget {
		return vscode.workspace.workspaceFolders
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
	}
}

export const config = new SweepConfig();

function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const placeholder = "__DOUBLE_STAR__";
	const withPlaceholder = escaped.replace(/\*\*/g, placeholder);
	const withStar = withPlaceholder.replace(/\*/g, "[^/]*");
	const withDoubleStar = withStar.replace(new RegExp(placeholder, "g"), ".*");
	return new RegExp(`^${withDoubleStar}$`);
}
