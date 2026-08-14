import { createHash } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";

import { config } from "~/core/config.ts";
import {
	DEFAULT_MAX_RECENT_CHANGES_CHARS,
	MAX_TOKENS,
	TEMPERATURE,
	ZETA_TRAINING_TEMPLATE_MAX_EDIT_EVENTS,
} from "~/core/constants.ts";
import { logger } from "~/core/logger.ts";
import type { CompletionServer } from "~/services/completion-server.ts";
import { parseNewSideRanges } from "~/telemetry/edit-merger.ts";
import { toUnixPath } from "~/utils/path.ts";
import {
	isFileTooLarge,
	utf8ByteOffsetAt,
	utf8ByteOffsetToUtf16Offset,
} from "~/utils/text.ts";
import type { CompletionResult } from "./completion-client.ts";
import {
	detectModelFormat,
	type ModelFormat,
	type ModelPrompt,
} from "./model-format.ts";
import {
	fuseAndDedupRetrievalSnippets,
	orderRetrievalChunks,
	truncateRetrievalChunk,
} from "./retrieval-chunks.ts";
import { getCommentPrefix, loadWorkspaceRules } from "./rules.ts";
import {
	type AutocompleteRequest,
	AutocompleteRequestSchema,
	type AutocompleteResponse,
	type AutocompleteResult,
	type EditorDiagnostic,
	type FileChunk,
	type RecentBuffer,
	type RecentChange,
	type UserAction,
} from "./schemas.ts";
import { buildSweepResponse } from "./sweep-completion.ts";
import { buildSweepPrompt, selectSweepBroadWindow } from "./sweep-prompt.ts";
import {
	formatSymbolOutline,
	type OutlineSymbolLike,
} from "./symbol-outline.ts";
import { buildZeta2Response } from "./zeta2-completion.ts";
import {
	buildZeta2Prompt,
	selectZetaCursorWindowFromLineProvider,
} from "./zeta2-prompt.ts";

export interface AutocompleteInput {
	document: vscode.TextDocument;
	position: vscode.Position;
	originalContent: string;
	recentChanges: RecentChange[];
	recentBuffers: RecentBuffer[];
	diagnostics: vscode.Diagnostic[];
	userActions: UserAction[];
}

const MAX_RETRIEVAL_CHUNKS = 16;
const MAX_DEFINITION_CHUNKS = 6;
const MAX_USAGE_CHUNKS = 6;
const RETRIEVAL_CONTEXT_LINES_ABOVE = 9;
const RETRIEVAL_CONTEXT_LINES_BELOW = 9;
const MAX_CLIPBOARD_LINES = 20;
const MAX_DIAGNOSTICS = 15;
const RECENT_CHANGE_TRUNCATION_MARKER = "\n...[truncated]\n";
const MIN_TRUNCATED_RECENT_CHANGE_CHARS = 120;
const OUTLINE_PROVIDER_TIMEOUT_MS = 2000;
const OUTLINE_PROVIDER_RETRY_BACKOFF_MS = 30_000;
const MAX_OUTLINE_CACHE_ENTRIES = 16;

interface DocumentSymbolsCacheEntry {
	version: number;
	symbols: readonly OutlineSymbolLike[];
	retryAfter: number;
	inFlight?: Promise<void>;
}

type DocumentSymbolLoader = (
	uri: vscode.Uri,
) => Thenable<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>;

type RetrievalFileLoader = (uri: vscode.Uri) => Thenable<Uint8Array>;

export interface ApiClientOptions {
	documentSymbolLoader?: DocumentSymbolLoader;
	outlineProviderTimeoutMs?: number;
	outlineProviderRetryBackoffMs?: number;
	retrievalFileLoader?: RetrievalFileLoader;
	openDocumentsProvider?: () => readonly vscode.TextDocument[];
}

// Per-chunk retrieval truncation is derived from the shared active-file
// budget. With the default 2,000 estimated tokens and roughly ten estimated
// tokens per source line, this preserves the former 133-line cap.
function retrievalChunkLines(): number {
	return Math.max(1, Math.floor(config.editableTokens / 15));
}

/**
 * The Sweep broad/original/current sections already carry the active edit.
 * Do not duplicate an active-file diff that touches the broad window in the
 * earlier history section: a coalesced typing hunk would otherwise become
 * the first volatile prompt text and defeat prefix caching.
 */
export function excludeSweepBroadWindowChanges(
	changes: RecentChange[],
	activeFilePath: string,
	lines: string[],
	cursorLine: number,
	editableTokens: number,
): RecentChange[] {
	const broadWindow = selectSweepBroadWindow(lines, cursorLine, editableTokens);
	const startLine = broadWindow.start + 1;
	const endLine = broadWindow.end;
	return changes.filter((change) => {
		if (toUnixPath(change.path) !== activeFilePath) return true;
		const hunks = parseNewSideRanges(change.diff);
		// An unparseable active-file diff is still duplicate, volatile context;
		// omit it rather than allowing it to invalidate the early prefix.
		if (hunks.length === 0) return false;
		return !hunks.some(
			(hunk) => hunk.newStart <= endLine && hunk.newEnd >= startLine,
		);
	});
}

export function formatRecentChanges(
	changes: RecentChange[],
	maxChars = DEFAULT_MAX_RECENT_CHANGES_CHARS,
	options: {
		maxEntries?: number;
		oldestFirst?: boolean;
		// When a chronological history exceeds its character budget, discard
		// whole oldest records first. This retains the newest edits at the end
		// of the prompt instead of allowing an old bulk edit to crowd them out.
		evictOldestToFit?: boolean;
	} = {},
): string {
	const budget = Math.max(0, Math.floor(maxChars));
	if (budget === 0) return "";

	const maxEntries =
		options.maxEntries === undefined
			? Number.POSITIVE_INFINITY
			: Math.max(0, Math.floor(options.maxEntries));
	let selectedChanges = changes
		.filter((change) => Boolean(change.diff))
		.slice(0, maxEntries);
	if (options.oldestFirst) {
		selectedChanges = selectedChanges.reverse();
	}

	const entries = selectedChanges.flatMap((change) => {
		const cleaned = cleanRecentChangeDiff(change.diff);
		if (!cleaned) return [];
		const header = `File: ${change.path}:\n`;
		return [{ header, body: cleaned, text: `${header}${cleaned}\n` }];
	});

	if (options.evictOldestToFit) {
		let start = 0;
		let totalChars = entries.reduce(
			(total, entry) => total + entry.text.length,
			0,
		);
		// `entries` are chronological here: remove from the beginning so the
		// most recent edit records survive at the end of the prompt.
		while (start < entries.length - 1 && totalChars > budget) {
			totalChars -= entries[start]?.text.length ?? 0;
			start++;
		}
		const kept = entries.slice(start);
		if (kept.length === 0) return "";
		if (totalChars <= budget) return kept.map((entry) => entry.text).join("");

		// One newest record alone exceeds the budget. Retain its leading diff
		// context rather than dropping all history.
		if (budget < MIN_TRUNCATED_RECENT_CHANGE_CHARS) return "";
		const newest = kept[0];
		return newest
			? truncateRecentChangeEntry(newest.header, newest.body, budget)
			: "";
	}

	let result = "";
	for (const entry of entries) {
		const remaining = budget - result.length;
		if (remaining <= 0) break;

		if (entry.text.length <= remaining) {
			result += entry.text;
			continue;
		}

		if (remaining < MIN_TRUNCATED_RECENT_CHANGE_CHARS) break;
		const truncated = truncateRecentChangeEntry(
			entry.header,
			entry.body,
			remaining,
		);
		if (truncated === "") break;
		result += truncated;
		break;
	}
	return result;
}

function cleanRecentChangeDiff(diff: string): string {
	const lines = diff
		.split("\n")
		.filter(
			(line) =>
				!line.startsWith("Index:") &&
				!line.startsWith("===") &&
				!line.startsWith("---") &&
				!line.startsWith("+++"),
		);
	return lines.join("\n").trim();
}

function truncateRecentChangeEntry(
	header: string,
	body: string,
	maxChars: number,
): string {
	const bodyBudget =
		maxChars - header.length - RECENT_CHANGE_TRUNCATION_MARKER.length;
	if (bodyBudget <= 0) return "";

	let truncated = body.slice(0, bodyBudget);
	const lastNewline = truncated.lastIndexOf("\n");
	if (lastNewline > 0) {
		truncated = truncated.slice(0, lastNewline);
	}
	truncated = truncated.trimEnd();
	if (truncated === "") return "";

	return `${header}${truncated}${RECENT_CHANGE_TRUNCATION_MARKER}`;
}

export class ApiClient {
	private server: CompletionServer;
	private readonly documentSymbolLoader: DocumentSymbolLoader;
	private readonly outlineProviderTimeoutMs: number;
	private readonly outlineProviderRetryBackoffMs: number;
	private readonly retrievalFileLoader: RetrievalFileLoader;
	private readonly openDocumentsProvider: () => readonly vscode.TextDocument[];
	private idCounter = 0;
	private readonly documentSymbolsCache = new Map<
		string,
		DocumentSymbolsCacheEntry
	>();
	private readonly identicalPromptResults = new Map<
		string,
		{ completion: CompletionResult; expiresAt: number }
	>();
	private inFlight = 0;
	private readonly processingEmitter = new vscode.EventEmitter<boolean>();
	readonly onDidChangeProcessing = this.processingEmitter.event;

	constructor(server: CompletionServer, options: ApiClientOptions = {}) {
		this.server = server;
		this.documentSymbolLoader =
			options.documentSymbolLoader ??
			((uri) =>
				vscode.commands.executeCommand<
					vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
				>("vscode.executeDocumentSymbolProvider", uri));
		this.outlineProviderTimeoutMs = Math.max(
			0,
			options.outlineProviderTimeoutMs ?? OUTLINE_PROVIDER_TIMEOUT_MS,
		);
		this.outlineProviderRetryBackoffMs = Math.max(
			0,
			options.outlineProviderRetryBackoffMs ??
				OUTLINE_PROVIDER_RETRY_BACKOFF_MS,
		);
		this.retrievalFileLoader =
			options.retrievalFileLoader ??
			((uri) => vscode.workspace.fs.readFile(uri));
		this.openDocumentsProvider =
			options.openDocumentsProvider ?? (() => vscode.workspace.textDocuments);
	}

	get isProcessing(): boolean {
		return this.inFlight > 0;
	}

	async getAutocomplete(
		input: AutocompleteInput,
		signal?: AbortSignal,
	): Promise<AutocompleteResult[] | null> {
		const documentText = input.document.getText();
		if (isFileTooLarge(documentText) || isFileTooLarge(input.originalContent)) {
			logger.debug("Skipping autocomplete request: file too large", {
				documentLength: documentText.length,
				originalLength: input.originalContent.length,
			});
			return null;
		}

		const format = detectModelFormat(config.modelName);
		const requestData = await this.buildRequest(input, format);
		const parsedRequest = AutocompleteRequestSchema.safeParse(requestData);
		if (!parsedRequest.success) {
			logger.error("Invalid request data:", parsedRequest.error.message);
			return null;
		}

		const rules = loadWorkspaceRules(input.document);
		const commentPrefix = getCommentPrefix(input.document.languageId);
		const inlineDiagnosticsMarker = config.inlineDiagnosticsMarker;
		const messageTransforms = config.diagnosticsMessageTransforms;
		const prompt: ModelPrompt =
			format === "zeta2" || format === "zeta2.1"
				? buildZeta2Prompt(parsedRequest.data, {
						diagRadius: config.diagRadius,
						rules,
						commentPrefix,
						injectInlineDiagnostics: config.injectInlineDiagnostics,
						inlineDiagnosticsMarker,
						messageTransforms,
						protocolVersion: format === "zeta2.1" ? "2.1" : "2",
						editableTokens: config.editableTokens,
						contextTokens: config.zetaContextTokens,
						maxRelatedChunks: config.maxContextFiles,
					})
				: buildSweepPrompt(parsedRequest.data, {
						editableTokens: config.editableTokens,
						diagRadius: config.diagRadius,
						rules,
						commentPrefix,
						injectInlineDiagnostics: config.injectInlineDiagnostics,
						inlineDiagnosticsMarker,
						messageTransforms,
					});

		const reqStarted = Date.now();
		const promptCacheKey = this.getPromptCacheKey(prompt);
		logger.info(
			`→ /v1/completions format=${format} model=${config.modelName} max_tokens=${MAX_TOKENS} prompt_chars=${prompt.prompt.length}`,
		);
		if (prompt.contextStats) {
			logger.debug("Prompt context chars:", prompt.contextStats);
		}
		logger.trace("→ /v1/completions raw prompt:", prompt.prompt);
		this.inFlight++;
		if (this.inFlight === 1) this.processingEmitter.fire(true);
		try {
			if (signal?.aborted) return null;
			let completion = config.reuseIdenticalPromptResults
				? this.getIdenticalPromptResult(promptCacheKey)
				: null;
			if (completion) {
				logger.info("↻ reused identical /v1/completions prompt result");
			} else {
				completion = await this.server.getClient().complete(
					{
						model: config.modelName,
						prompt: prompt.prompt,
						temperature: config.temperature,
						maxTokens: MAX_TOKENS,
						stop: prompt.stopTokens,
						timeoutMs: config.completionTimeoutMs,
					},
					signal,
				);
				this.server.reportSuccess();
				if (config.reuseIdenticalPromptResults) {
					this.rememberIdenticalPromptResult(promptCacheKey, completion);
				}
			}
			const elapsed = ((Date.now() - reqStarted) / 1000).toFixed(2);
			logger.info(
				`← /v1/completions ${elapsed}s prompt_eval=${completion.promptEvalCount ?? "?"} eval=${completion.evalCount ?? "?"} finish=${completion.finishReason} response_chars=${completion.text.length}`,
			);
			logger.trace("← /v1/completions raw response:", completion.text);

			const id = `nesweep-${Date.now()}-${++this.idCounter}`;
			let responses: AutocompleteResponse[] | null;
			if (format === "zeta2" || format === "zeta2.1") {
				responses = buildZeta2Response(completion, prompt, id);
			} else {
				const single = buildSweepResponse(completion, prompt, id);
				responses = single ? [single] : null;
			}
			if (!responses) return null;

			const decode = (i: number) =>
				utf8ByteOffsetToUtf16Offset(documentText, i);
			const cursorOffset = input.document.offsetAt(input.position);
			const results: AutocompleteResult[] = [];
			for (const response of responses) {
				const result: AutocompleteResult = {
					id: response.autocomplete_id,
					startIndex: decode(response.start_index),
					endIndex: decode(response.end_index),
					completion: response.completion,
					confidence: response.confidence,
					...(response.cursor_target_offset !== undefined
						? { cursorTargetOffset: response.cursor_target_offset }
						: {}),
				};
				// If the replacement starts before the cursor on the same
				// line that contains it, anchor the start at the cursor and
				// strip the matching prefix from the completion. The
				// InlineEditProvider.normalizeInlineResult path otherwise
				// collapses endIndex onto the cursor when it auto-trims the
				// pre-cursor prefix, leaving the line's original tail
				// (e.g. a stray `)`) in place. Only the primary (cursor)
				// region can ever satisfy the position guard; secondary
				// regions in multi-region 2.1 sit elsewhere in the file.
				if (
					result.startIndex < cursorOffset &&
					cursorOffset <= result.endIndex
				) {
					const prefix = documentText.slice(result.startIndex, cursorOffset);
					if (result.completion.startsWith(prefix)) {
						result.startIndex = cursorOffset;
						result.completion = result.completion.slice(prefix.length);
						if (result.cursorTargetOffset !== undefined) {
							if (result.cursorTargetOffset >= prefix.length) {
								result.cursorTargetOffset -= prefix.length;
							} else {
								delete result.cursorTargetOffset;
							}
						}
					}
				}
				// Empty replacement text is a meaningful deletion whenever
				// the response covers a non-empty document range.
				if (
					result.completion.length === 0 &&
					result.endIndex === result.startIndex
				) {
					continue;
				}
				results.push(result);
			}
			if (results.length === 0) return null;
			return results;
		} catch (error) {
			const elapsed = ((Date.now() - reqStarted) / 1000).toFixed(2);
			if ((error as Error).name === "AbortError") {
				logger.debug(`← /v1/completions aborted after ${elapsed}s`);
				return null;
			}
			logger.error(
				`← /v1/completions failed after ${elapsed}s:`,
				(error as Error).message,
			);
			this.server.reportFailure();
			return null;
		} finally {
			this.inFlight--;
			if (this.inFlight === 0) this.processingEmitter.fire(false);
		}
	}

	private getPromptCacheKey(prompt: ModelPrompt): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					model: config.modelName,
					prompt: prompt.prompt,
					temperature: config.temperature,
					maxTokens: MAX_TOKENS,
					stop: prompt.stopTokens,
				}),
			)
			.digest("hex");
	}

	private getIdenticalPromptResult(key: string): CompletionResult | null {
		const entry = this.identicalPromptResults.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.identicalPromptResults.delete(key);
			return null;
		}
		return entry.completion;
	}

	private rememberIdenticalPromptResult(
		key: string,
		completion: CompletionResult,
	): void {
		if (this.identicalPromptResults.size >= 32) {
			const oldestKey = this.identicalPromptResults.keys().next().value;
			if (oldestKey) this.identicalPromptResults.delete(oldestKey);
		}
		this.identicalPromptResults.set(key, {
			completion,
			expiresAt: Date.now() + config.identicalPromptCacheTtlMs,
		});
	}

	private async buildRequest(
		input: AutocompleteInput,
		format: ModelFormat,
	): Promise<AutocompleteRequest> {
		const {
			document,
			position,
			originalContent,
			recentChanges,
			recentBuffers,
			diagnostics,
			userActions,
		} = input;

		const filePath = toUnixPath(document.uri.fsPath) || "untitled";
		const isZeta = format === "zeta2" || format === "zeta2.1";
		const sweepRecentChanges = isZeta
			? recentChanges
			: excludeSweepBroadWindowChanges(
					recentChanges,
					filePath,
					Array.from(
						{ length: document.lineCount },
						(_, line) => document.lineAt(line).text,
					),
					position.line,
					config.editableTokens,
				);
		const recentChangesText = formatRecentChanges(
			sweepRecentChanges,
			config.maxRecentChangesChars,
			isZeta
				? {
						maxEntries: ZETA_TRAINING_TEMPLATE_MAX_EDIT_EVENTS,
						oldestFirst: true,
					}
				: {
						// Sweep's active edit is already represented by broad context
						// and original/current/updated. Chronological history keeps a
						// stable prefix; evicting its oldest records preserves the newest
						// useful edits at the volatile tail instead of pinning the cache
						// to the just-typed hunk.
						oldestFirst: true,
						evictOldestToFit: true,
					},
		);
		const fileChunks = this.buildFileChunks(recentBuffers);
		const zetaWindow =
			format === "zeta2.1"
				? selectZetaCursorWindowFromLineProvider(
						document.lineCount,
						position.line,
						config.editableTokens,
						config.zetaContextTokens,
						(line) => document.lineAt(line).text,
					)
				: null;
		const zetaContextRange = zetaWindow
			? {
					startLine: zetaWindow.contextStart,
					endLine: zetaWindow.contextEnd,
				}
			: null;
		const [retrievalChunks, symbolOutline] = await Promise.all([
			config.maxContextFiles > 0
				? this.buildRetrievalChunks(
						document,
						position,
						filePath,
						zetaContextRange,
					)
				: Promise.resolve([]),
			config.outlineSymbols > 0
				? this.buildSymbolOutline(document, position.line)
				: Promise.resolve(""),
		]);
		const editorDiagnostics = this.buildEditorDiagnostics(
			document,
			diagnostics,
			position.line,
		);

		return {
			debug_info: this.getDebugInfo(),
			repo_name: this.getRepoName(document),
			file_path: filePath,
			file_contents: document.getText(),
			original_file_contents: originalContent,
			cursor_position: utf8ByteOffsetAt(document, position),
			recent_changes: recentChangesText,
			changes_above_cursor: true,
			multiple_suggestions: false,
			file_chunks: fileChunks,
			retrieval_chunks: retrievalChunks,
			symbol_outline: symbolOutline,
			editor_diagnostics: editorDiagnostics,
			recent_user_actions: userActions,
			use_bytes: true,
		};
	}

	private buildFileChunks(buffers: RecentBuffer[]): FileChunk[] {
		return buffers
			.filter((buffer) => !isFileTooLarge(buffer.content))
			.map((buffer) => {
				if (buffer.startLine !== undefined && buffer.endLine !== undefined) {
					return {
						file_path: toUnixPath(buffer.path),
						start_line: buffer.startLine,
						end_line: buffer.endLine,
						content: buffer.content,
						...(buffer.mtime !== undefined ? { timestamp: buffer.mtime } : {}),
					};
				}
				const lines = buffer.content.split("\n");
				const endLine = Math.min(30, lines.length);
				return {
					file_path: toUnixPath(buffer.path),
					start_line: 0,
					end_line: endLine,
					content: lines.slice(0, endLine).join("\n"),
					timestamp: buffer.mtime,
				};
			});
	}

	private async buildRetrievalChunks(
		document: vscode.TextDocument,
		position: vscode.Position,
		currentFilePath: string,
		currentFileContextRange: {
			startLine: number;
			endLine: number;
		} | null,
	): Promise<FileChunk[]> {
		const [definitionChunks, usageChunks, clipboardChunks] = await Promise.all([
			this.buildDefinitionChunks(document, position, currentFileContextRange),
			this.buildUsageChunks(document, position, currentFileContextRange),
			config.includeClipboardContext
				? this.buildClipboardChunks()
				: Promise.resolve([]),
		]);

		// Diagnostics are emitted as a structured, distance-filtered section
		// by the prompt builders (sweep-prompt's formatDiagnosticsSection,
		// zeta2-prompt's formatDiagnosticsPseudoFile) using
		// editor_diagnostics. We deliberately don't include them as a
		// retrieval chunk too — that path was unfiltered (file-wide) and
		// duplicated the same data in a less useful position in the prompt.
		const chunks = [...usageChunks, ...definitionChunks, ...clipboardChunks]
			.filter(
				(chunk) =>
					currentFileContextRange !== null ||
					chunk.file_path !== currentFilePath,
			)
			.map((chunk) => truncateRetrievalChunk(chunk, retrievalChunkLines()))
			.filter((chunk) => chunk.content.trim().length > 0);

		const fused = fuseAndDedupRetrievalSnippets(chunks);
		return orderRetrievalChunks(
			fused,
			config.stableRetrievalOrdering,
			MAX_RETRIEVAL_CHUNKS,
		);
	}

	handleDocumentSaved(document: vscode.TextDocument): void {
		if (config.outlineSymbols <= 0) return;
		const entry = this.getOrCreateDocumentSymbolsEntry(document);
		if (entry) this.refreshDocumentSymbols(document, entry);
	}

	private buildSymbolOutline(
		document: vscode.TextDocument,
		cursorLine0: number,
	): string {
		const symbols = this.getDocumentSymbols(document);
		return formatSymbolOutline(symbols, cursorLine0, config.outlineSymbols);
	}

	private getDocumentSymbols(
		document: vscode.TextDocument,
	): readonly OutlineSymbolLike[] {
		const entry = this.getOrCreateDocumentSymbolsEntry(document);
		if (!entry) return [];

		// Document Symbols are optional context and must never delay a
		// completion. A provider can resolve symbols for a dirty document, so
		// refresh on every document version rather than freezing the last saved
		// outline. The request remains asynchronous and a response is accepted
		// only if the document is still at the requested version.
		if (entry.version !== document.version) {
			this.refreshDocumentSymbols(document, entry);
		}
		return entry.symbols;
	}

	private getOrCreateDocumentSymbolsEntry(
		document: vscode.TextDocument,
	): DocumentSymbolsCacheEntry | undefined {
		const key = document.uri.toString();
		const cached = this.documentSymbolsCache.get(key);
		if (cached) {
			// Touch the entry so Map insertion order acts as a small LRU.
			this.documentSymbolsCache.delete(key);
			this.documentSymbolsCache.set(key, cached);
			return cached;
		}

		if (this.documentSymbolsCache.size >= MAX_OUTLINE_CACHE_ENTRIES) {
			const evictable = [...this.documentSymbolsCache].find(
				([, entry]) => !entry.inFlight,
			);
			if (!evictable) {
				// Every slot is waiting on a provider. Do not create another
				// request and risk an unbounded pile-up behind a stuck LSP.
				return undefined;
			}
			this.documentSymbolsCache.delete(evictable[0]);
		}

		const entry: DocumentSymbolsCacheEntry = {
			version: -1,
			symbols: [],
			retryAfter: 0,
		};
		this.documentSymbolsCache.set(key, entry);
		return entry;
	}

	private refreshDocumentSymbols(
		document: vscode.TextDocument,
		entry: DocumentSymbolsCacheEntry,
	): void {
		if (entry.inFlight || Date.now() < entry.retryAfter) {
			return;
		}

		const requestedVersion = document.version;
		let timedOut = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const inFlight = (async (): Promise<void> => {
			if (this.outlineProviderTimeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					entry.retryAfter = Date.now() + this.outlineProviderRetryBackoffMs;
					logger.debug(
						"Document Symbols provider timed out; keeping cached outline",
						{
							uri: document.uri.toString(),
							timeoutMs: this.outlineProviderTimeoutMs,
						},
					);
				}, this.outlineProviderTimeoutMs);
			}

			try {
				const symbols = (await this.documentSymbolLoader(document.uri)) ?? [];
				if (timedOut || document.version !== requestedVersion) {
					return;
				}
				entry.symbols = symbols;
				entry.version = requestedVersion;
				entry.retryAfter = 0;
			} catch {
				entry.retryAfter = Date.now() + this.outlineProviderRetryBackoffMs;
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		})();
		entry.inFlight = inFlight;
		void inFlight.finally(() => {
			if (entry.inFlight === inFlight) delete entry.inFlight;
		});
	}

	private buildEditorDiagnostics(
		document: vscode.TextDocument,
		diagnostics: vscode.Diagnostic[],
		cursorLine0: number,
	): EditorDiagnostic[] {
		const mapped = diagnostics.map((diagnostic) => {
			const code = extractDiagnosticCode(diagnostic.code);
			return {
				line: diagnostic.range.start.line + 1,
				start_offset: document.offsetAt(diagnostic.range.start),
				end_offset: document.offsetAt(diagnostic.range.end),
				severity: this.formatSeverity(diagnostic.severity),
				message: diagnostic.message,
				timestamp: Date.now(),
				...(code !== undefined ? { code } : {}),
			};
		});

		// If the cursor line itself has an error-severity diagnostic, drop
		// every diagnostic below the cursor. clangd / tsserver routinely
		// emit a swarm of cascading errors ("expected ;", "undeclared
		// identifier 'camera'") downstream of a single root-cause typo;
		// they distract small models from the real fix and waste prompt
		// budget. Above-cursor diagnostics are kept untouched (they may
		// be unrelated real issues).
		const cursorLine1 = cursorLine0 + 1;
		const hasErrorOnCursorLine = mapped.some(
			(d) => d.line === cursorLine1 && d.severity === "error",
		);
		const filtered = hasErrorOnCursorLine
			? mapped.filter((d) => d.line <= cursorLine1)
			: mapped;
		return filtered.slice(0, MAX_DIAGNOSTICS);
	}

	private async buildClipboardChunks(): Promise<FileChunk[]> {
		if (!config.includeClipboard) return [];
		try {
			const clipboard = (await vscode.env.clipboard.readText()).trim();
			if (!clipboard) return [];

			const lines = clipboard.split(/\r?\n/).slice(0, MAX_CLIPBOARD_LINES);
			const content = lines.join("\n").trim();
			if (!content) return [];

			return [
				{
					file_path: "clipboard.txt",
					start_line: 1,
					end_line: lines.length,
					content,
					timestamp: Date.now(),
				},
			];
		} catch {
			return [];
		}
	}

	private async buildDefinitionChunks(
		document: vscode.TextDocument,
		position: vscode.Position,
		currentFileContextRange: {
			startLine: number;
			endLine: number;
		} | null,
	): Promise<FileChunk[]> {
		try {
			const results =
				(await vscode.commands.executeCommand<
					Array<vscode.Location | vscode.LocationLink> | undefined
				>("vscode.executeDefinitionProvider", document.uri, position)) ?? [];
			const locations = results
				.map((result) => this.normalizeLocation(result))
				.filter((location): location is vscode.Location => location !== null)
				.filter((location) =>
					this.isUsefulRetrievalLocation(
						location,
						document.uri,
						currentFileContextRange,
					),
				);
			return this.buildLocationChunks(locations, MAX_DEFINITION_CHUNKS);
		} catch {
			return [];
		}
	}

	private async buildUsageChunks(
		document: vscode.TextDocument,
		position: vscode.Position,
		currentFileContextRange: {
			startLine: number;
			endLine: number;
		} | null,
	): Promise<FileChunk[]> {
		try {
			const results =
				(await vscode.commands.executeCommand<vscode.Location[] | undefined>(
					"vscode.executeReferenceProvider",
					document.uri,
					position,
				)) ?? [];
			return this.buildLocationChunks(
				results.filter((location) =>
					this.isUsefulRetrievalLocation(
						location,
						document.uri,
						currentFileContextRange,
					),
				),
				MAX_USAGE_CHUNKS,
			);
		} catch {
			return [];
		}
	}

	private normalizeLocation(
		location: vscode.Location | vscode.LocationLink,
	): vscode.Location | null {
		if ("uri" in location && "range" in location) {
			return new vscode.Location(location.uri, location.range);
		}
		if ("targetUri" in location && "targetRange" in location) {
			return new vscode.Location(location.targetUri, location.targetRange);
		}
		return null;
	}

	private isUsefulRetrievalLocation(
		location: vscode.Location,
		currentDocumentUri: vscode.Uri,
		currentFileContextRange: {
			startLine: number;
			endLine: number;
		} | null,
	): boolean {
		if (location.uri.toString() !== currentDocumentUri.toString()) return true;
		if (currentFileContextRange === null) return false;

		const locationStart = location.range.start.line;
		const locationEnd = location.range.end.line + 1;
		return (
			locationEnd <= currentFileContextRange.startLine ||
			locationStart >= currentFileContextRange.endLine
		);
	}

	private async buildLocationChunks(
		locations: readonly vscode.Location[],
		maxChunks: number,
	): Promise<FileChunk[]> {
		const seen = new Set<string>();
		const chunks: FileChunk[] = [];

		for (const location of locations) {
			if (chunks.length >= maxChunks) break;
			const key = `${location.uri.toString()}:${location.range.start.line}:${location.range.end.line}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const chunk = await this.buildChunkFromLocation(location);
			if (!chunk) continue;
			chunks.push(chunk);
		}

		return chunks;
	}

	private async buildChunkFromLocation(
		location: vscode.Location,
	): Promise<FileChunk | null> {
		const targetDocument = this.openDocumentsProvider().find(
			(document) => document.uri.toString() === location.uri.toString(),
		);
		if (targetDocument) {
			return this.buildChunkFromOpenDocument(targetDocument, location);
		}

		let text: string;
		try {
			const bytes = await this.retrievalFileLoader(location.uri);
			text = new TextDecoder().decode(bytes);
		} catch {
			return null;
		}

		const lines = text.split(/\r?\n/);
		const totalLines = lines.length;
		if (totalLines === 0) return null;

		const startLine = Math.max(
			0,
			location.range.start.line - RETRIEVAL_CONTEXT_LINES_ABOVE,
		);
		const endLine = Math.min(
			totalLines - 1,
			location.range.end.line + RETRIEVAL_CONTEXT_LINES_BELOW,
		);
		const content = lines
			.slice(startLine, endLine + 1)
			.join("\n")
			.trim();
		if (!content) return null;

		return this.makeLocationChunk(location.uri, startLine, endLine, content);
	}

	private buildChunkFromOpenDocument(
		targetDocument: vscode.TextDocument,
		location: vscode.Location,
	): FileChunk | null {
		const totalLines = targetDocument.lineCount;
		if (totalLines === 0) return null;

		const startLine = Math.max(
			0,
			location.range.start.line - RETRIEVAL_CONTEXT_LINES_ABOVE,
		);
		const endLine = Math.min(
			totalLines - 1,
			location.range.end.line + RETRIEVAL_CONTEXT_LINES_BELOW,
		);
		const endPosition =
			endLine + 1 < totalLines
				? new vscode.Position(endLine + 1, 0)
				: targetDocument.lineAt(endLine).range.end;
		const range = new vscode.Range(
			new vscode.Position(startLine, 0),
			endPosition,
		);
		const content = targetDocument.getText(range).trim();
		if (!content) return null;

		return this.makeLocationChunk(
			targetDocument.uri,
			startLine,
			endLine,
			content,
		);
	}

	private makeLocationChunk(
		uri: vscode.Uri,
		startLine: number,
		endLine: number,
		content: string,
	): FileChunk {
		return {
			file_path: toUnixPath(uri.fsPath) || uri.toString(),
			start_line: startLine + 1,
			end_line: endLine + 1,
			content,
			timestamp: Date.now(),
		};
	}

	private formatSeverity(
		severity: vscode.DiagnosticSeverity | undefined,
	): string {
		switch (severity) {
			case vscode.DiagnosticSeverity.Error:
				return "error";
			case vscode.DiagnosticSeverity.Warning:
				return "warning";
			case vscode.DiagnosticSeverity.Information:
				return "info";
			case vscode.DiagnosticSeverity.Hint:
				return "hint";
			default:
				return "info";
		}
	}

	getDebugInfo(): string {
		const extensionVersion =
			vscode.extensions.getExtension("sr-tream.nesweep")?.packageJSON
				?.version ?? "unknown";
		return `VSCode (${vscode.version}) - OS: ${os.platform()} ${os.arch()} - NESweep v${extensionVersion}`;
	}

	private getRepoName(document: vscode.TextDocument): string {
		return (
			vscode.workspace.getWorkspaceFolder(document.uri)?.name || "untitled"
		);
	}
}

function extractDiagnosticCode(
	code: vscode.Diagnostic["code"],
): string | undefined {
	if (code === undefined || code === null) return undefined;
	if (typeof code === "string") return code || undefined;
	if (typeof code === "number") return String(code);
	if (typeof code === "object" && "value" in code) {
		const v = code.value;
		if (typeof v === "string") return v || undefined;
		if (typeof v === "number") return String(v);
	}
	return undefined;
}
