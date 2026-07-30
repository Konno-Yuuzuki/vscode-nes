import * as vscode from "vscode";
import type { ApiClient, AutocompleteInput } from "~/api/client.ts";
import { detectModelFormat } from "~/api/model-format.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { selectSweepEditWindow } from "~/api/sweep-prompt.ts";
import { selectZetaCursorWindowFromLineProvider } from "~/api/zeta2-prompt.ts";
import { config } from "~/core/config";
import { JUMP_RETRIGGER_DELAY_MS } from "~/core/constants.ts";
import { logger } from "~/core/logger.ts";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import {
	enableForwardStability,
	markAsProposedInlineEdit,
	type ProposedInlineCompletionDisplayLocation,
} from "~/editor/proposed-inline-edit.ts";
import {
	type DocumentTracker,
	isTrackableDocument,
} from "~/telemetry/document-tracker.ts";
import { toUnixPath } from "~/utils/path.ts";
import { isFileTooLarge, utf8ByteOffsetAt } from "~/utils/text.ts";

const INLINE_REQUEST_DEBOUNCE_MS = 300;
const MAX_FILE_CHUNK_LINES = 60;
const BULK_CHANGE_LOOKBACK_MS = 1500;
const BULK_CHANGE_CHAR_THRESHOLD = 200;
const BULK_CHANGE_LINE_THRESHOLD = 8;
const SELECTION_LOOKBACK_MS = 5000;
const MAX_SPLIT_DIFF_LINES = 128;

interface QueuedSuggestionState {
	uri: string;
	suggestions: AutocompleteResult[];
}

interface RequestSnapshot {
	uri: string;
	version: number;
	position: vscode.Position;
	content: string;
	cursorOffset: number;
}

interface EditableContextWindow {
	uri: string;
	version: number;
	startLine: number;
	endLine: number;
	anchorLine: number;
	retriggered: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

interface PendingProposedJump {
	uri: string;
	version: number;
	targetLine: number;
}

export interface AcceptedInlineSuggestion {
	id: string;
	uri: string;
	startIndex: number;
	endIndex: number;
	completion: string;
	// Proposed inline edits must use plain text because VS Code's snippet
	// acceptance path can minimize the deletion range while still inserting
	// the full snippet. When present, restore the model's cursor after the
	// plain-text replacement has been accepted.
	cursorTargetOffset?: number;
}

interface CompletionItemBuildOptions {
	useProposedInlineEditPresentation?: boolean;
	displayLocation?: ProposedInlineCompletionDisplayLocation;
}

// Build a SnippetString that places the final cursor ($0) at the model's
// predicted post-edit position. Snippet metacharacters in the surrounding
// text need to be escaped — `$`, `}` and `\` would otherwise be parsed as
// snippet syntax.
function toSnippetWithCursor(
	completion: string,
	cursorOffset: number,
): vscode.SnippetString {
	const escapeSnippet = (s: string) => s.replace(/[\\$}]/g, "\\$&");
	const before = escapeSnippet(completion.slice(0, cursorOffset));
	const after = escapeSnippet(completion.slice(cursorOffset));
	return new vscode.SnippetString(`${before}$0${after}`);
}

export function inlineEditMatchesSelectedCompletion(
	document: vscode.TextDocument,
	result: AutocompleteResult,
	selectedCompletionInfo: vscode.SelectedCompletionInfo,
): boolean {
	const editRange = new vscode.Range(
		document.positionAt(result.startIndex),
		document.positionAt(result.endIndex),
	);
	return (
		rangesEqual(editRange, selectedCompletionInfo.range) &&
		result.completion.startsWith(selectedCompletionInfo.text)
	);
}

function rangesEqual(a: vscode.Range, b: vscode.Range): boolean {
	return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function positionsEqual(a: vscode.Position, b: vscode.Position): boolean {
	return a.line === b.line && a.character === b.character;
}

interface LineEdit {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

/**
 * Split independent replacement hunks so proposed inline edits do not render
 * unchanged code between them as one large Copilot-style suggestion. A final
 * insertion can be split safely because it is anchored at the end of the
 * original range. A final shortened hunk is treated as a truncated model
 * tail, preserving unmatched old lines rather than turning the last intended
 * replacement into a large deletion.
 */
export function splitDisjointLineEdits(
	documentText: string,
	result: AutocompleteResult,
): AutocompleteResult[] {
	if (
		result.cursorTargetOffset !== undefined ||
		result.startIndex < 0 ||
		result.endIndex < result.startIndex ||
		result.endIndex > documentText.length
	) {
		return [result];
	}

	const oldText = documentText.slice(result.startIndex, result.endIndex);
	const oldLines = oldText.split("\n");
	const newLines = result.completion.split("\n");
	if (
		oldLines.length > MAX_SPLIT_DIFF_LINES ||
		newLines.length > MAX_SPLIT_DIFF_LINES
	) {
		return [result];
	}

	const edits = findLineEdits(oldLines, newLines);
	if (edits.length < 2) return [result];

	const splitEdits: LineEdit[] = [];
	for (let index = 0; index < edits.length; index++) {
		const edit = edits[index];
		if (!edit) return [result];
		const oldLength = edit.oldEnd - edit.oldStart;
		const newLength = edit.newEnd - edit.newStart;
		if (oldLength === newLength && oldLength > 0) {
			splitEdits.push(edit);
			continue;
		}
		// Sweep sometimes stops directly after the final replacement, omitting
		// the unchanged tail of the rewrite window. Preserve that tail so it
		// does not become a destructive deletion in the last small suggestion.
		if (index === edits.length - 1 && oldLength > newLength && newLength > 0) {
			splitEdits.push({
				...edit,
				oldEnd: edit.oldStart + newLength,
			});
			continue;
		}
		if (
			index === edits.length - 1 &&
			oldLength === 0 &&
			newLength > 0 &&
			edit.oldStart === oldLines.length
		) {
			splitEdits.push(edit);
			continue;
		}
		return [result];
	}

	const oldLineOffsets = lineOffsets(oldLines);
	return splitEdits.map((edit, index) => {
		const isFinalInsertion =
			edit.oldStart === edit.oldEnd && edit.oldStart === oldLines.length;
		const oldSegment = oldLines.slice(edit.oldStart, edit.oldEnd).join("\n");
		const insertionPrefix = isFinalInsertion ? "\n" : "";
		const relativeStart = isFinalInsertion
			? oldText.length
			: (oldLineOffsets[edit.oldStart] ?? 0);
		return {
			...result,
			id: `${result.id}:part${index + 1}`,
			startIndex: result.startIndex + relativeStart,
			endIndex: result.startIndex + relativeStart + oldSegment.length,
			completion:
				insertionPrefix + newLines.slice(edit.newStart, edit.newEnd).join("\n"),
		};
	});
}

function lineOffsets(lines: string[]): number[] {
	const offsets = [0];
	for (const line of lines) {
		offsets.push((offsets.at(-1) ?? 0) + line.length + 1);
	}
	return offsets;
}

function findLineEdits(oldLines: string[], newLines: string[]): LineEdit[] {
	const oldCount = oldLines.length;
	const newCount = newLines.length;
	const lcs = Array.from(
		{ length: oldCount + 1 },
		() => new Uint16Array(newCount + 1),
	);
	for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = newCount - 1; newIndex >= 0; newIndex--) {
			if (oldLines[oldIndex] === newLines[newIndex]) {
				lcs[oldIndex][newIndex] = (lcs[oldIndex + 1]?.[newIndex + 1] ?? 0) + 1;
			} else {
				lcs[oldIndex][newIndex] = Math.max(
					lcs[oldIndex + 1]?.[newIndex] ?? 0,
					lcs[oldIndex]?.[newIndex + 1] ?? 0,
				);
			}
		}
	}

	const edits: LineEdit[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	let current: LineEdit | null = null;
	const closeCurrent = () => {
		if (!current) return;
		edits.push(current);
		current = null;
	};
	const extendCurrent = () => {
		if (!current) {
			current = {
				oldStart: oldIndex,
				oldEnd: oldIndex,
				newStart: newIndex,
				newEnd: newIndex,
			};
		}
		return current;
	};

	while (oldIndex < oldCount || newIndex < newCount) {
		if (
			oldIndex < oldCount &&
			newIndex < newCount &&
			oldLines[oldIndex] === newLines[newIndex]
		) {
			closeCurrent();
			oldIndex++;
			newIndex++;
			continue;
		}
		if (
			newIndex < newCount &&
			(oldIndex === oldCount ||
				(lcs[oldIndex]?.[newIndex + 1] ?? 0) >
					(lcs[oldIndex + 1]?.[newIndex] ?? 0))
		) {
			extendCurrent().newEnd++;
			newIndex++;
		} else {
			extendCurrent().oldEnd++;
			oldIndex++;
		}
	}
	closeCurrent();
	return edits;
}

export class InlineEditProvider implements vscode.InlineCompletionItemProvider {
	private tracker: DocumentTracker;
	private jumpEditManager: JumpEditManager;
	private api: ApiClient;
	private lastInlineEdit: {
		uri: string;
		line: number;
		character: number;
		version: number;
		suggestion: AcceptedInlineSuggestion;
	} | null = null;
	private queuedSuggestions: QueuedSuggestionState | null = null;
	private shouldConsumeQueuedSuggestion = false;
	private requestCounter = 0;
	private latestRequestId = 0;
	private inFlightRequest: {
		id: number;
		controller: AbortController;
		uri: string;
		snapshot: RequestSnapshot;
		response: Promise<AutocompleteResult[] | null>;
	} | null = null;
	private lastRequestTimestamp = 0;
	private editableContextWindow: EditableContextWindow | null = null;
	private pendingProposedJump: PendingProposedJump | null = null;

	constructor(
		tracker: DocumentTracker,
		jumpEditManager: JumpEditManager,
		api: ApiClient,
	) {
		this.tracker = tracker;
		this.jumpEditManager = jumpEditManager;
		this.api = api;
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionList | undefined> {
		const requestId = ++this.requestCounter;
		this.latestRequestId = requestId;

		if (!config.enabled) return undefined;
		if (config.isAutocompleteSnoozed()) return undefined;

		const suppressionReason = await this.getSuppressionReason(document);
		if (suppressionReason) {
			logger.debug("Suppressing inline edit:", suppressionReason);
			return undefined;
		}
		logger.debug(
			`provider invoked req=${requestId} line=${position.line} char=${position.character}`,
		);

		const uri = document.uri.toString();
		const filePath = document.uri.fsPath;
		if (filePath && config.shouldExcludeFromAutocomplete(filePath)) {
			return undefined;
		}
		const currentContent = document.getText();
		const requestSnapshot: RequestSnapshot = {
			uri,
			version: document.version,
			position,
			content: currentContent,
			cursorOffset: document.offsetAt(position),
		};
		const originalContent =
			this.tracker.getOriginalContent(uri) ?? currentContent;

		if (isFileTooLarge(currentContent) || isFileTooLarge(originalContent)) {
			logger.debug("Skipping inline edit: file too large", {
				uri,
				currentLength: currentContent.length,
				originalLength: originalContent.length,
			});
			return undefined;
		}

		// Normal automatic suggestions require an edit. Context-exit retriggers
		// invoke VS Code's inline-suggest command explicitly, and their purpose
		// is precisely to ask for a next edit at a new cursor location even when
		// the document bytes are unchanged.
		if (
			currentContent === originalContent &&
			context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke
		) {
			return undefined;
		}
		if (this.shouldConsumeQueuedSuggestion) {
			const queuedItems = this.consumeQueuedSuggestion(document, position);
			if (queuedItems) {
				return queuedItems;
			}
		}

		if (token.isCancellationRequested) return undefined;

		const shouldContinue = await this.waitForDebounce(requestId, token);
		if (!shouldContinue) return undefined;
		if (!this.isLatestRequest(requestId)) return undefined;

		const setupOriginate = (): Promise<AutocompleteResult[] | null> => {
			this.cancelInFlightRequest("superseded by new request");
			this.rememberEditableContextWindow(document, requestSnapshot);
			const controller = new AbortController();
			const input = this.buildInput(document, position, originalContent);
			const promise = this.api.getAutocomplete(input, controller.signal);
			const inFlight = {
				id: requestId,
				controller,
				uri,
				snapshot: requestSnapshot,
				response: promise,
			};
			this.inFlightRequest = inFlight;
			promise.finally(() => {
				if (this.inFlightRequest === inFlight) {
					this.inFlightRequest = null;
				}
			});
			return promise;
		};

		let sourceSnapshot: RequestSnapshot;
		let responsePromise: Promise<AutocompleteResult[] | null>;
		const piggyback = this.tryPiggyback(uri, requestSnapshot);
		if (piggyback) {
			logger.debug(
				`Piggybacking req=${requestId} on in-flight req=${piggyback.id}`,
			);
			sourceSnapshot = piggyback.snapshot;
			responsePromise = piggyback.response;
		} else {
			sourceSnapshot = requestSnapshot;
			responsePromise = setupOriginate();
		}

		try {
			let responseResults = await responsePromise;

			// Piggyback fallback: if reusing the in-flight produced no usable
			// result for our snapshot, originate fresh before giving up. Only
			// do this for the latest request — older provider calls just bail.
			if (
				piggyback &&
				config.enabled &&
				!token.isCancellationRequested &&
				this.isLatestRequest(requestId)
			) {
				const piggybackUsable =
					!!responseResults?.length &&
					!!this.tryBuildGhostTextExtension(
						sourceSnapshot,
						document,
						responseResults,
					)?.length;
				if (!piggybackUsable) {
					logger.debug(
						`Piggyback unusable for req=${requestId}, originating fresh`,
					);
					sourceSnapshot = requestSnapshot;
					responsePromise = setupOriginate();
					responseResults = await responsePromise;
				}
			}

			if (
				!config.enabled ||
				token.isCancellationRequested ||
				!responseResults?.length
			) {
				return undefined;
			}

			const isOwnRequest = sourceSnapshot === requestSnapshot;
			const isLatestRequest = this.isLatestRequest(requestId);
			let results = responseResults;
			if (!isOwnRequest || !isLatestRequest) {
				const extendedResults = this.tryBuildGhostTextExtension(
					sourceSnapshot,
					document,
					responseResults,
				);
				if (!extendedResults?.length) {
					return undefined;
				}
				results = extendedResults;
			}

			if (config.useCopilotStyleNextEditPresentation) {
				results = results.flatMap((result) =>
					splitDisjointLineEdits(document.getText(), result),
				);
			}

			if (
				isOwnRequest &&
				isLatestRequest &&
				this.isRequestStale(requestSnapshot, token)
			) {
				logger.debug("Inline edit response stale; skipping render", {
					uri,
					requestVersion: requestSnapshot.version,
					currentVersion: document.version,
					requestLine: requestSnapshot.position.line,
					requestCharacter: requestSnapshot.position.character,
					contentMatches: requestSnapshot.content === document.getText(),
				});
				return undefined;
			}

			const renderSuppressionReason = await this.getSuppressionReason(document);
			if (renderSuppressionReason) {
				logger.debug(
					"Suppressing inline edit render:",
					renderSuppressionReason,
				);
				return undefined;
			}

			this.clearSuggestionQueue("superseded by fresh response");

			let renderMode: "INLINE" | "JUMP" | null = null;
			const inlineResults: AutocompleteResult[] = [];
			const copilotResults: Array<{
				result: AutocompleteResult;
				isJump: boolean;
			}> = [];
			let jumpResult: AutocompleteResult | null = null;

			for (const result of results) {
				const normalizedResult = this.normalizeInlineResult(
					document,
					position,
					result,
				);
				if (!normalizedResult) {
					continue;
				}

				if (this.isNoOpSuggestion(document, normalizedResult)) {
					continue;
				}

				const classification = this.jumpEditManager.classifyEditDisplay(
					document,
					position,
					normalizedResult,
				);
				if (classification.decision === "SUPPRESS") {
					logger.debug("Suppressing suggestion after display classification", {
						reason: classification.reason,
						id: normalizedResult.id,
					});
					continue;
				}

				if (
					context.selectedCompletionInfo &&
					!inlineEditMatchesSelectedCompletion(
						document,
						normalizedResult,
						context.selectedCompletionInfo,
					)
				) {
					logger.debug(
						"Suppressing inline edit: incompatible with selected completion",
						{
							id: normalizedResult.id,
							selectedText: context.selectedCompletionInfo.text,
						},
					);
					continue;
				}

				if (config.useCopilotStyleNextEditPresentation) {
					copilotResults.push({
						result: normalizedResult,
						isJump: classification.decision === "JUMP",
					});
					continue;
				}

				if (classification.decision === "JUMP") {
					if (!renderMode) {
						renderMode = "JUMP";
						jumpResult = normalizedResult;
					}
					continue;
				}

				if (!renderMode) {
					renderMode = "INLINE";
				}
				if (renderMode === "INLINE") {
					inlineResults.push(normalizedResult);
				}
			}

			if (config.useCopilotStyleNextEditPresentation) {
				const firstCopilotResult = copilotResults[0];
				if (!firstCopilotResult) {
					this.jumpEditManager.clearJumpEdit();
					this.clearSuggestionQueue("no renderable Copilot-style suggestions");
					return undefined;
				}
				this.setSuggestionQueue(
					uri,
					copilotResults.slice(1).map((candidate) => candidate.result),
				);
				this.jumpEditManager.clearJumpEdit();
				logger.info("Rendering Copilot-style inline edit sequence", {
					count: copilotResults.length,
					id: firstCopilotResult.result.id,
				});
				return this.buildCompletionItem(
					document,
					position,
					firstCopilotResult.result,
					firstCopilotResult.isJump
						? { useProposedInlineEditPresentation: true }
						: undefined,
				);
			}

			if (renderMode === "JUMP" && jumpResult) {
				if (config.useCopilotStyleNextEditPresentation) {
					const proposedInlineEdit = this.buildCompletionItem(
						document,
						position,
						jumpResult,
						{ useProposedInlineEditPresentation: true },
					);
					if (proposedInlineEdit) {
						this.clearSuggestionQueue(
							"jump suggestion rendered as proposed inline edit",
						);
						this.jumpEditManager.clearJumpEdit();
						logger.info("Edit classified as proposed VS Code inline edit", {
							id: jumpResult.id,
						});
						return proposedInlineEdit;
					}
				}
				this.clearSuggestionQueue("jump suggestion takes precedence");
				logger.info("Edit classified as jump edit, showing decoration", {
					id: jumpResult.id,
				});
				this.jumpEditManager.setPendingJumpEdit(document, jumpResult);
				// VSCode keeps a previously-served InlineCompletionItem visible
				// when our provider returns undefined; without this, a stale
				// ghost-text suggestion (possibly from an older buggy build that
				// embedded <|cursor|> in insertText) lingers on top of our jump
				// decoration. Force-hide it so only the JUMP preview is visible.
				void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
				return undefined;
			}

			if (inlineResults.length === 0) {
				this.jumpEditManager.clearJumpEdit();
				this.clearSuggestionQueue("no renderable inline suggestions");
				return undefined;
			}
			const firstInlineResult = inlineResults[0];
			if (!firstInlineResult) {
				this.jumpEditManager.clearJumpEdit();
				this.clearSuggestionQueue("missing first inline suggestion");
				return undefined;
			}
			this.setSuggestionQueue(uri, inlineResults.slice(1));

			// Clear any stale jump indicator
			this.jumpEditManager.clearJumpEdit();

			logger.info("Rendering inline edit suggestions", {
				count: inlineResults.length,
				cursorLine: position.line,
				firstEditStartLine: document.positionAt(firstInlineResult.startIndex)
					.line,
			});
			return this.buildCompletionItem(document, position, firstInlineResult);
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				return undefined;
			}
			logger.error("InlineEditProvider error:", error);
			return undefined;
		}
	}

	private tryPiggyback(
		uri: string,
		newSnapshot: RequestSnapshot,
	): {
		id: number;
		snapshot: RequestSnapshot;
		response: Promise<AutocompleteResult[] | null>;
	} | null {
		const inFlight = this.inFlightRequest;
		if (!inFlight) return null;
		if (inFlight.uri !== uri) return null;
		if (inFlight.controller.signal.aborted) return null;
		const inserted = this.extractInsertedTextAtCursor(
			inFlight.snapshot.content,
			newSnapshot.content,
			inFlight.snapshot.cursorOffset,
		);
		if (!inserted) return null;
		// Only piggyback for forward typing of identifier characters.
		// Punctuation / whitespace usually mark a syntactic boundary the
		// model's existing prediction won't extend through.
		if (!/^\w+$/.test(inserted)) return null;
		return {
			id: inFlight.id,
			snapshot: inFlight.snapshot,
			response: inFlight.response,
		};
	}

	private cancelInFlightRequest(reason: string): void {
		if (!this.inFlightRequest) return;
		logger.debug("Cancelling in-flight inline edit request:", reason);
		this.inFlightRequest.controller.abort();
		this.inFlightRequest = null;
	}

	private async getSuppressionReason(
		document: vscode.TextDocument,
	): Promise<string | null> {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) return "no active editor";
		if (activeEditor.document.uri.toString() !== document.uri.toString()) {
			return "inactive document";
		}
		if (!vscode.window.state.focused) return "window not focused";

		if (
			this.hasMultiLineSelection(activeEditor, document) ||
			this.tracker.wasRecentMultiLineSelection(
				document.uri.toString(),
				SELECTION_LOOKBACK_MS,
			)
		) {
			return "multi-line selection";
		}

		const editorTextFocus =
			await this.getContextKeyValue<boolean>("editorTextFocus");
		if (editorTextFocus === false) return "editor not focused";

		const isWritable = vscode.workspace.fs.isWritableFileSystem(
			document.uri.scheme,
		);
		if (isWritable === false) return "read-only document";

		const inSnippetMode =
			await this.getContextKeyValue<boolean>("inSnippetMode");
		if (inSnippetMode) return "snippet/template mode";

		const uri = document.uri.toString();
		if (
			this.tracker.wasRecentBulkChange(uri, {
				windowMs: BULK_CHANGE_LOOKBACK_MS,
				charThreshold: BULK_CHANGE_CHAR_THRESHOLD,
				lineThreshold: BULK_CHANGE_LINE_THRESHOLD,
			})
		) {
			return "recent bulk edit";
		}

		return null;
	}

	private async getContextKeyValue<T>(key: string): Promise<T | undefined> {
		try {
			return (await vscode.commands.executeCommand(
				"getContextKeyValue",
				key,
			)) as T | undefined;
		} catch {
			return undefined;
		}
	}

	private hasMultiLineSelection(
		editor: vscode.TextEditor,
		document: vscode.TextDocument,
	): boolean {
		for (const selection of editor.selections) {
			if (selection.isEmpty) continue;
			if (selection.start.line !== selection.end.line) return true;
			const selectedText = document.getText(selection);
			if (selectedText.includes("\n")) return true;
		}
		return false;
	}

	private async waitForDebounce(
		requestId: number,
		token: vscode.CancellationToken,
	): Promise<boolean> {
		const now = Date.now();
		const elapsed = now - this.lastRequestTimestamp;
		this.lastRequestTimestamp = now;

		const delay = Math.max(0, INLINE_REQUEST_DEBOUNCE_MS - elapsed);
		if (delay === 0) return !token.isCancellationRequested;

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				resolve();
			}, delay);
			const disposable = token.onCancellationRequested(() => {
				clearTimeout(timeout);
				disposable.dispose();
				resolve();
			});
		});
		if (token.isCancellationRequested) return false;
		return this.isLatestRequest(requestId);
	}

	private isLatestRequest(requestId: number): boolean {
		return requestId === this.latestRequestId;
	}

	private buildCompletionItem(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
		options: CompletionItemBuildOptions = {},
	): vscode.InlineCompletionList | undefined {
		const cursorOffset = document.offsetAt(position);
		const startPosition = document.positionAt(result.startIndex);
		const endPosition = document.positionAt(result.endIndex);
		const editRange = new vscode.Range(startPosition, endPosition);

		logger.info("Creating inline edit:", {
			id: result.id,
			startPosition: `${startPosition.line}:${startPosition.character}`,
			endPosition: `${endPosition.line}:${endPosition.character}`,
			cursorPosition: `${position.line}:${position.character}`,
			cursorOffset,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completionPreview: result.completion.slice(0, 100),
		});
		logger.trace("Creating inline edit completion:", result.completion);

		const useProposedInlineEditPresentation =
			options.useProposedInlineEditPresentation &&
			config.useCopilotStyleNextEditPresentation;

		if (
			result.startIndex < cursorOffset &&
			!useProposedInlineEditPresentation
		) {
			logger.debug(
				"Edit before cursor cannot be shown as ghost text; falling back to jump edit",
				{
					id: result.id,
				},
			);
			this.jumpEditManager.setPendingJumpEdit(document, result);
			return undefined;
		}

		if (this.lastInlineEdit?.suggestion.id !== result.id) {
			this.clearInlineEdit("replaced by new inline edit", {
				hideSuggestion: false,
			});
		}

		const acceptedSuggestion: AcceptedInlineSuggestion = {
			id: result.id,
			uri: document.uri.toString(),
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completion: result.completion,
			...(useProposedInlineEditPresentation &&
			result.cursorTargetOffset !== undefined
				? { cursorTargetOffset: result.cursorTargetOffset }
				: {}),
		};
		const insertText =
			result.cursorTargetOffset !== undefined &&
			!useProposedInlineEditPresentation
				? toSnippetWithCursor(result.completion, result.cursorTargetOffset)
				: result.completion;
		const item = new vscode.InlineCompletionItem(insertText, editRange);
		if (
			useProposedInlineEditPresentation &&
			startPosition.line !== position.line
		) {
			this.pendingProposedJump = {
				uri: document.uri.toString(),
				version: document.version,
				targetLine: startPosition.line,
			};
			logger.debug("Watching proposed jump target", {
				targetLine: startPosition.line,
				originLine: position.line,
			});
		} else {
			this.pendingProposedJump = null;
		}
		const replacedText = document.getText(editRange);
		if (replacedText && !result.completion.startsWith(replacedText)) {
			item.filterText = replacedText;
		}
		item.command = {
			title: "Accept Sweep Inline Edit",
			command: "sweep.acceptInlineEdit",
			arguments: [acceptedSuggestion],
		};
		if (useProposedInlineEditPresentation) {
			const proposedOptions: Parameters<typeof markAsProposedInlineEdit>[1] = {
				correlationId: result.id,
			};
			if (options.displayLocation) {
				proposedOptions.displayLocation = options.displayLocation;
			}
			markAsProposedInlineEdit(item, proposedOptions);
		}

		this.lastInlineEdit = {
			uri: document.uri.toString(),
			line: position.line,
			character: position.character,
			version: document.version,
			suggestion: acceptedSuggestion,
		};
		return enableForwardStability({ items: [item] });
	}

	private rememberEditableContextWindow(
		document: vscode.TextDocument,
		snapshot: Pick<RequestSnapshot, "uri" | "version" | "position">,
	): void {
		const format = detectModelFormat(config.modelName);
		let startLine: number;
		let endLine: number;
		if (format === "sweep") {
			const window = selectSweepEditWindow(
				document.lineCount,
				snapshot.position.line,
			);
			startLine = window.start;
			endLine = window.end;
		} else {
			const window = selectZetaCursorWindowFromLineProvider(
				document.lineCount,
				snapshot.position.line,
				config.editableTokens,
				config.zetaContextTokens,
				(line) => document.lineAt(line).text,
			);
			startLine = window.editableStart;
			endLine = window.editableEnd;
		}
		if (endLine <= startLine) return;

		this.clearEditableContextWindow();
		this.editableContextWindow = {
			uri: snapshot.uri,
			version: snapshot.version,
			startLine,
			endLine,
			anchorLine: snapshot.position.line,
			retriggered: false,
		};
		logger.debug("Remembered editable context window", {
			startLine,
			endLine,
			anchorLine: snapshot.position.line,
			version: snapshot.version,
		});
	}

	private maybeRetriggerAfterProposedJump(
		document: vscode.TextDocument,
		position: vscode.Position,
	): boolean {
		const jump = this.pendingProposedJump;
		if (!jump) return false;
		if (
			jump.uri !== document.uri.toString() ||
			jump.version !== document.version
		) {
			this.pendingProposedJump = null;
			return false;
		}
		// The proposed-API "Tab to jump" landing point is normally the edit
		// line, but VS Code can land one line before an insertion (the range's
		// visual anchor). Treat either line as arrival. A strict target-line
		// comparison loses the suggestion without ever requesting the next one.
		const isAtJumpTarget =
			position.line >= Math.max(0, jump.targetLine - 1) &&
			position.line <= jump.targetLine;
		if (!isAtJumpTarget) return false;
		const landingLine = position.line;

		// Native proposed inline edits use Tab/click to move to a distant edit.
		// They do not apply the edit or necessarily re-invoke our provider at
		// that target. Consume the one-shot watcher before scheduling so
		// selection events cannot enqueue duplicate requests.
		this.pendingProposedJump = null;
		logger.debug("Proposed jump reached target; scheduling next edit", {
			targetLine: jump.targetLine,
			landingLine,
			delayMs: JUMP_RETRIGGER_DELAY_MS,
		});
		setTimeout(() => {
			const editor = vscode.window.activeTextEditor;
			if (
				!editor ||
				editor.document.uri.toString() !== jump.uri ||
				editor.document.version !== jump.version ||
				editor.selection.active.line !== landingLine
			) {
				return;
			}
			logger.debug("Retriggering after proposed jump", {
				targetLine: jump.targetLine,
				landingLine,
			});
			void vscode.commands.executeCommand(
				"editor.action.inlineSuggest.trigger",
			);
		}, JUMP_RETRIGGER_DELAY_MS);
		return true;
	}

	private maybeRetriggerOnEditableContextExit(
		document: vscode.TextDocument,
		position: vscode.Position,
	): void {
		const window = this.editableContextWindow;
		const anchor = {
			uri: document.uri.toString(),
			version: document.version,
			position,
		};
		if (!window) {
			if (config.retriggerOnContextExit) {
				this.rememberEditableContextWindow(document, anchor);
			}
			return;
		}
		if (window.uri !== anchor.uri || window.version !== anchor.version) {
			this.clearEditableContextWindow();
			if (config.retriggerOnContextExit) {
				this.rememberEditableContextWindow(document, anchor);
			}
			return;
		}

		const retriggerDistance = Math.max(
			1,
			Math.ceil((window.endLine - window.startLine) / 2),
		);
		const movedLines = Math.abs(position.line - window.anchorLine);
		if (movedLines < retriggerDistance) {
			if (window.timer) {
				clearTimeout(window.timer);
				delete window.timer;
			}
			return;
		}
		if (!config.retriggerOnContextExit || window.retriggered) return;

		if (window.timer) clearTimeout(window.timer);
		logger.debug("Cursor crossed editable-context retrigger threshold", {
			startLine: window.startLine,
			endLine: window.endLine,
			anchorLine: window.anchorLine,
			currentLine: position.line,
			movedLines,
			retriggerDistance,
			debounceMs: config.contextExitRetriggerDebounceMs,
		});
		window.timer = setTimeout(() => {
			if (this.editableContextWindow !== window) return;
			delete window.timer;

			const editor = vscode.window.activeTextEditor;
			if (
				!editor ||
				editor.document.uri.toString() !== window.uri ||
				editor.document.version !== window.version
			) {
				this.clearEditableContextWindow();
				return;
			}
			const currentLine = editor.selection.active.line;
			const retriggerDistance = Math.max(
				1,
				Math.ceil((window.endLine - window.startLine) / 2),
			);
			const movedLines = Math.abs(currentLine - window.anchorLine);
			if (movedLines < retriggerDistance) return;

			window.retriggered = true;
			logger.debug(
				"Retriggering after cursor crossed editable-context threshold",
				{
					startLine: window.startLine,
					endLine: window.endLine,
					anchorLine: window.anchorLine,
					currentLine,
					movedLines,
					retriggerDistance,
					debounceMs: config.contextExitRetriggerDebounceMs,
				},
			);
			void vscode.commands.executeCommand(
				"editor.action.inlineSuggest.trigger",
			);
		}, config.contextExitRetriggerDebounceMs);
	}

	private clearEditableContextWindow(): void {
		if (this.editableContextWindow?.timer) {
			clearTimeout(this.editableContextWindow.timer);
		}
		this.editableContextWindow = null;
	}

	async handleCursorMove(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<void> {
		const arrivedAtProposedJump = this.maybeRetriggerAfterProposedJump(
			document,
			position,
		);
		this.maybeRetriggerOnEditableContextExit(document, position);

		if (
			this.queuedSuggestions &&
			this.queuedSuggestions.uri !== document.uri.toString()
		) {
			this.clearSuggestionQueue("active document changed");
		}

		if (!this.lastInlineEdit) return;
		// A distant proposed inline edit uses VS Code's first Tab/click as a
		// navigation step. Do not call inlineSuggest.hide for that movement:
		// it destroys the still-pending native suggestion before its second
		// acceptance step (and before the automatic refresh above can arrive).
		if (arrivedAtProposedJump) return;
		const currentUri = document.uri.toString();
		if (currentUri !== this.lastInlineEdit.uri) {
			logger.debug("Clearing inline edit: active document changed");
			this.clearInlineEdit("active document changed");
			return;
		}

		if (
			position.line !== this.lastInlineEdit.line ||
			position.character !== this.lastInlineEdit.character ||
			document.version !== this.lastInlineEdit.version
		) {
			if (this.isPrefixTypingExtension(document, position)) {
				return;
			}
			logger.debug("Clearing inline edit: cursor moved away", {
				originalLine: this.lastInlineEdit.line,
				currentLine: position.line,
				originalCharacter: this.lastInlineEdit.character,
				currentCharacter: position.character,
				originalVersion: this.lastInlineEdit.version,
				currentVersion: document.version,
			});
			this.clearInlineEdit("cursor moved away");
		}
	}

	// True when the user is typing forward on the same line and the typed
	// delta is a prefix of the rendered ghost text. Lets VSCode shrink the
	// ghost text in place while the next provider call piggybacks on the
	// in-flight request and extends the suggestion.
	private isPrefixTypingExtension(
		document: vscode.TextDocument,
		position: vscode.Position,
	): boolean {
		const last = this.lastInlineEdit;
		if (!last) return false;
		if (document.uri.toString() !== last.uri) return false;
		if (position.line !== last.line) return false;
		if (position.character <= last.character) return false;
		// Pure-insertion suggestions only — replacements past the cursor
		// would need us to re-derive the visible ghost text after edits.
		if (last.suggestion.startIndex !== last.suggestion.endIndex) return false;

		const anchor = new vscode.Position(last.line, last.character);
		const anchorOffset = document.offsetAt(anchor);
		if (anchorOffset !== last.suggestion.startIndex) return false;

		const newOffset = document.offsetAt(position);
		const typedLen = newOffset - anchorOffset;
		if (typedLen <= 0 || typedLen > last.suggestion.completion.length) {
			return false;
		}
		const typed = document.getText(new vscode.Range(anchor, position));
		return last.suggestion.completion.startsWith(typed);
	}

	handleInlineAccept(acceptedSuggestion?: AcceptedInlineSuggestion): void {
		if (
			acceptedSuggestion &&
			this.lastInlineEdit?.suggestion.id === acceptedSuggestion.id
		) {
			this.lastInlineEdit = null;
		}
		if (!acceptedSuggestion) return;
		this.placeCursorAfterPlainTextAccept(acceptedSuggestion);
		this.adjustQueuedSuggestionsAfterAccept(acceptedSuggestion);
		if (this.queuedSuggestions?.suggestions.length) {
			this.shouldConsumeQueuedSuggestion = true;
			void vscode.commands.executeCommand(
				"editor.action.inlineSuggest.trigger",
			);
			return;
		}
		this.clearSuggestionQueue("accepted suggestion exhausted queue");
		// VSCode does not auto-fire the inline-completion provider for the
		// text change that an accept itself applies, so without an explicit
		// trigger we get exactly one suggestion per editing session and then
		// stall until the user types more. cursortab.nvim immediately asks
		// for the next prediction after accept; mirror that here.
		void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
	}

	private placeCursorAfterPlainTextAccept(
		acceptedSuggestion: AcceptedInlineSuggestion,
	): void {
		if (acceptedSuggestion.cursorTargetOffset === undefined) return;
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== acceptedSuggestion.uri) {
			return;
		}

		// InlineCompletionItem.command runs after VS Code applies insertText.
		// The prefix before startIndex is unchanged, so the post-edit target
		// is startIndex plus the model's UTF-16 offset within the replacement.
		const targetOffset = Math.min(
			acceptedSuggestion.startIndex + acceptedSuggestion.cursorTargetOffset,
			editor.document.getText().length,
		);
		const target = editor.document.positionAt(Math.max(0, targetOffset));
		editor.selection = new vscode.Selection(target, target);
		editor.revealRange(
			new vscode.Range(target, target),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
		logger.debug("Inline edit cursor placed at predicted position", {
			line: target.line + 1,
			character: target.character,
		});
	}

	private clearInlineEdit(
		reason: string,
		options?: { hideSuggestion?: boolean },
	): void {
		if (!this.lastInlineEdit) return;
		const shouldHideSuggestion = options?.hideSuggestion ?? true;

		this.lastInlineEdit = null;
		this.clearSuggestionQueue(reason ? `inline cleared: ${reason}` : undefined);

		if (shouldHideSuggestion) {
			void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
		}

		if (reason) {
			logger.debug("Inline edit cleared:", reason);
		}
	}

	private setSuggestionQueue(
		uri: string,
		suggestions: AutocompleteResult[],
	): void {
		if (suggestions.length === 0) {
			this.queuedSuggestions = null;
			this.shouldConsumeQueuedSuggestion = false;
			return;
		}
		this.queuedSuggestions = { uri, suggestions: [...suggestions] };
		this.shouldConsumeQueuedSuggestion = false;
	}

	private clearSuggestionQueue(reason?: string): void {
		const hadQueuedSuggestions = this.queuedSuggestions !== null;
		this.queuedSuggestions = null;
		this.shouldConsumeQueuedSuggestion = false;
		if (reason && hadQueuedSuggestions) {
			logger.debug("Cleared queued suggestions:", reason);
		}
	}

	private consumeQueuedSuggestion(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.InlineCompletionList | undefined {
		const queue = this.queuedSuggestions;
		if (!queue || queue.suggestions.length === 0) return undefined;
		const uri = document.uri.toString();
		if (queue.uri !== uri) {
			this.clearSuggestionQueue("active document changed");
			return undefined;
		}

		while (queue.suggestions.length > 0) {
			const next = queue.suggestions.shift();
			if (!next) break;
			const normalized = this.normalizeInlineResult(document, position, next);
			if (!normalized) continue;
			if (this.isNoOpSuggestion(document, normalized)) continue;

			const classification = this.jumpEditManager.classifyEditDisplay(
				document,
				position,
				normalized,
			);
			if (classification.decision === "SUPPRESS") {
				continue;
			}
			if (classification.decision === "JUMP") {
				logger.debug("Rendering queued suggestion as jump edit", {
					id: normalized.id,
					remaining: queue.suggestions.length,
				});
				if (config.useCopilotStyleNextEditPresentation) {
					const proposedInlineEdit = this.buildCompletionItem(
						document,
						position,
						normalized,
						{ useProposedInlineEditPresentation: true },
					);
					if (proposedInlineEdit) {
						this.shouldConsumeQueuedSuggestion = false;
						return proposedInlineEdit;
					}
				}
				this.jumpEditManager.setPendingJumpEdit(document, normalized);
				this.shouldConsumeQueuedSuggestion = false;
				return undefined;
			}

			logger.debug("Rendering queued inline edit suggestion", {
				id: normalized.id,
				remaining: queue.suggestions.length,
			});
			this.shouldConsumeQueuedSuggestion = false;
			return this.buildCompletionItem(document, position, normalized);
		}

		this.clearSuggestionQueue("queue exhausted");
		return undefined;
	}

	private adjustQueuedSuggestionsAfterAccept(
		acceptedSuggestion: AcceptedInlineSuggestion,
	): void {
		if (!this.queuedSuggestions?.suggestions.length) return;
		const replacementLength =
			acceptedSuggestion.endIndex - acceptedSuggestion.startIndex;
		const adjustment = acceptedSuggestion.completion.length - replacementLength;
		if (adjustment === 0) return;

		this.queuedSuggestions.suggestions = this.queuedSuggestions.suggestions
			.map((suggestion) => {
				if (suggestion.startIndex < acceptedSuggestion.startIndex) {
					return suggestion;
				}
				return {
					...suggestion,
					startIndex: suggestion.startIndex + adjustment,
					endIndex: suggestion.endIndex + adjustment,
				};
			})
			.filter(
				(suggestion) =>
					suggestion.completion.length > 0 ||
					suggestion.endIndex > suggestion.startIndex,
			);
	}

	private isNoOpSuggestion(
		document: vscode.TextDocument,
		result: AutocompleteResult,
	): boolean {
		const oldContent = document.getText(
			new vscode.Range(
				document.positionAt(result.startIndex),
				document.positionAt(result.endIndex),
			),
		);
		const isNoOp =
			this.trimNewlines(oldContent) === this.trimNewlines(result.completion);
		if (isNoOp) {
			logger.debug(
				"Inline edit response is a no-op after trimming newlines; skipping render",
				{ id: result.id },
			);
		}
		return isNoOp;
	}

	private tryBuildGhostTextExtension(
		snapshot: RequestSnapshot,
		document: vscode.TextDocument,
		results: AutocompleteResult[],
	): AutocompleteResult[] | null {
		const firstResult = results[0];
		if (!firstResult) return null;

		const currentText = document.getText();
		const snapshotCursorOffset = Math.min(
			snapshot.cursorOffset,
			snapshot.content.length,
		);
		const userInsertedText = this.extractInsertedTextAtCursor(
			snapshot.content,
			currentText,
			snapshotCursorOffset,
		);
		if (!userInsertedText) return null;

		const suggestedText =
			snapshot.content.slice(0, firstResult.startIndex) +
			firstResult.completion +
			snapshot.content.slice(firstResult.endIndex);
		const suggestedInsertedText = this.extractInsertedTextAtCursor(
			snapshot.content,
			suggestedText,
			snapshotCursorOffset,
		);
		if (
			!suggestedInsertedText ||
			!suggestedInsertedText.startsWith(userInsertedText)
		) {
			return null;
		}

		const extendedCompletion = suggestedInsertedText.slice(
			userInsertedText.length,
		);
		if (!extendedCompletion) {
			return null;
		}

		const activeEditor = vscode.window.activeTextEditor;
		const currentCursorOffset =
			activeEditor?.document.uri.toString() === snapshot.uri
				? activeEditor.document.offsetAt(activeEditor.selection.active)
				: snapshotCursorOffset + userInsertedText.length;

		const adjustedFirst: AutocompleteResult = {
			...firstResult,
			startIndex: currentCursorOffset,
			endIndex: currentCursorOffset,
			completion: extendedCompletion,
		};
		// userInsertedText was sliced off the front of the completion, so the
		// cursor-target offset (if any) shifts left by the same amount. If it
		// landed inside the consumed prefix it's no longer meaningful — drop it.
		if (firstResult.cursorTargetOffset !== undefined) {
			if (firstResult.cursorTargetOffset >= userInsertedText.length) {
				adjustedFirst.cursorTargetOffset =
					firstResult.cursorTargetOffset - userInsertedText.length;
			} else {
				delete adjustedFirst.cursorTargetOffset;
			}
		}
		const adjustmentOffset = userInsertedText.length;
		const adjustedRemainder = results.slice(1).map((result) => ({
			...result,
			startIndex: result.startIndex + adjustmentOffset,
			endIndex: result.endIndex + adjustmentOffset,
		}));

		logger.debug("Rendering extension from stale inline response", {
			id: adjustedFirst.id,
			adjustmentOffset,
		});

		return [adjustedFirst, ...adjustedRemainder];
	}

	private extractInsertedTextAtCursor(
		originalText: string,
		updatedText: string,
		cursorOffset: number,
	): string | null {
		const prefix = originalText.slice(0, cursorOffset);
		const suffix = originalText.slice(cursorOffset);
		if (!updatedText.startsWith(prefix) || !updatedText.endsWith(suffix)) {
			return null;
		}
		const insertedText = updatedText.slice(
			prefix.length,
			updatedText.length - suffix.length,
		);
		return insertedText.length > 0 ? insertedText : null;
	}

	private buildInput(
		document: vscode.TextDocument,
		position: vscode.Position,
		originalContent: string,
	): AutocompleteInput {
		const maxContextFiles = config.maxContextFiles;

		const recentBuffers = this.buildRecentBuffers(document, maxContextFiles);

		const recentChanges = this.tracker.getEditDiffHistory().map((record) => ({
			path: record.filepath,
			diff: record.diff,
		}));

		const userActions = this.tracker.getUserActions(document.fileName, {
			line: position.line,
			offset: utf8ByteOffsetAt(document, position),
		});

		return {
			document,
			position,
			originalContent,
			recentChanges,
			recentBuffers,
			diagnostics: vscode.languages.getDiagnostics(document.uri),
			userActions,
		};
	}

	private buildRecentBuffers(
		document: vscode.TextDocument,
		maxFiles: number,
	): AutocompleteInput["recentBuffers"] {
		const currentUri = document.uri.toString();
		const buffers: AutocompleteInput["recentBuffers"] = [];
		const seen = new Set<string>();

		const addBuffer = (buffer: AutocompleteInput["recentBuffers"][number]) => {
			if (seen.has(buffer.path)) return;
			seen.add(buffer.path);
			buffers.push(buffer);
		};

		for (const buffer of this.buildVisibleEditorBuffers(currentUri)) {
			addBuffer(buffer);
		}

		const recentFiles = this.tracker.getRecentContextFiles(
			currentUri,
			maxFiles * 2,
		);
		for (const file of recentFiles) {
			const buffer = this.buildBufferFromSnapshot(file);
			if (!buffer) continue;
			addBuffer(buffer);
		}

		return buffers.slice(0, maxFiles);
	}

	private buildVisibleEditorBuffers(
		currentUri: string,
	): AutocompleteInput["recentBuffers"] {
		const buffers: AutocompleteInput["recentBuffers"] = [];

		for (const editor of vscode.window.visibleTextEditors) {
			const document = editor.document;
			if (document.uri.toString() === currentUri) continue;
			// Output/log, SCM, settings, and other virtual documents can
			// contain previous prompts and model marker tokens. Feeding those
			// back as recent context causes recursive prompt contamination.
			if (!isTrackableDocument(document)) continue;

			const range = this.getPrimaryVisibleRange(editor);
			const focusLine = editor.selection.active.line;
			const chunk = this.buildChunkFromDocument(document, {
				visibleRange: range,
				focusLine,
			});
			if (!chunk) continue;

			buffers.push({
				path: this.getRelativePathForUri(document.uri),
				content: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
			});
		}

		return buffers;
	}

	private getPrimaryVisibleRange(
		editor: vscode.TextEditor,
	): vscode.Range | null {
		const ranges = editor.visibleRanges;
		if (ranges.length === 0) return null;

		const activeLine = editor.selection.active.line;
		const containingRange = ranges.find(
			(range) => activeLine >= range.start.line && activeLine <= range.end.line,
		);
		return containingRange ?? ranges[0] ?? null;
	}

	private buildBufferFromSnapshot(file: {
		filepath: string;
		content: string;
		mtime?: number;
		cursorLine?: number;
	}): AutocompleteInput["recentBuffers"][number] | null {
		if (isFileTooLarge(file.content)) return null;
		const lines = file.content.split("\n");
		const totalLines = lines.length;
		if (totalLines === 0) return null;

		const focusLine = file.cursorLine ?? 0;
		const { startLine, endLine } = this.buildLineWindow(
			0,
			totalLines,
			focusLine,
		);
		const content = lines.slice(startLine, endLine).join("\n");

		return {
			path: file.filepath,
			content,
			startLine,
			endLine,
			...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
		};
	}

	private buildChunkFromDocument(
		document: vscode.TextDocument,
		options: {
			visibleRange: vscode.Range | null;
			focusLine: number;
		},
	): { content: string; startLine: number; endLine: number } | null {
		const totalLines = document.lineCount;
		if (totalLines === 0) return null;

		if (options.visibleRange) {
			const rangeStart = options.visibleRange.start.line;
			const rangeEnd = Math.min(totalLines, options.visibleRange.end.line + 1);
			if (rangeEnd - rangeStart <= MAX_FILE_CHUNK_LINES) {
				return this.buildChunkFromRange(document, rangeStart, rangeEnd);
			}
			const { startLine, endLine } = this.buildLineWindow(
				rangeStart,
				rangeEnd,
				options.focusLine,
			);
			return this.buildChunkFromRange(document, startLine, endLine);
		}

		const { startLine, endLine } = this.buildLineWindow(
			0,
			totalLines,
			options.focusLine,
		);
		return this.buildChunkFromRange(document, startLine, endLine);
	}

	private buildChunkFromRange(
		document: vscode.TextDocument,
		startLine: number,
		endLine: number,
	): { content: string; startLine: number; endLine: number } {
		const clampedStart = Math.max(0, Math.min(startLine, document.lineCount));
		const clampedEnd = Math.max(
			clampedStart,
			Math.min(endLine, document.lineCount),
		);
		const range = new vscode.Range(
			new vscode.Position(clampedStart, 0),
			new vscode.Position(clampedEnd, 0),
		);
		const content = document.getText(range);
		return { content, startLine: clampedStart, endLine: clampedEnd };
	}

	private buildLineWindow(
		minLine: number,
		maxLine: number,
		focusLine: number,
	): { startLine: number; endLine: number } {
		const span = Math.min(MAX_FILE_CHUNK_LINES, maxLine - minLine);
		if (span <= 0) return { startLine: minLine, endLine: minLine };

		const clampedFocus = Math.min(
			Math.max(focusLine, minLine),
			Math.max(minLine, maxLine - 1),
		);
		let startLine = clampedFocus - Math.floor(span / 2);
		startLine = Math.max(minLine, Math.min(startLine, maxLine - span));
		const endLine = startLine + span;
		return { startLine, endLine };
	}

	private getRelativePathForUri(uri: vscode.Uri): string {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (workspaceFolder) {
			const relativePath = uri.fsPath.slice(
				workspaceFolder.uri.fsPath.length + 1,
			);
			return toUnixPath(relativePath);
		}
		return toUnixPath(uri.fsPath);
	}

	private normalizeInlineResult(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): AutocompleteResult | null {
		const cursorOffset = document.offsetAt(position);

		if (result.startIndex >= cursorOffset)
			return this.trimSuffixOverlap(document, position, result);

		const prefixBeforeCursor = document.getText(
			new vscode.Range(document.positionAt(result.startIndex), position),
		);

		if (!result.completion.startsWith(prefixBeforeCursor)) return result;

		const trimmedCompletion = result.completion.slice(
			prefixBeforeCursor.length,
		);
		const trimmedEndIndex = Math.max(cursorOffset, result.endIndex);
		if (trimmedCompletion.length === 0 && trimmedEndIndex === cursorOffset) {
			return null;
		}

		const trimmedResult: AutocompleteResult = {
			...result,
			startIndex: cursorOffset,
			// Trimming the unchanged prefix moves only the start of the
			// edit. Preserve any original range after the cursor so accepting
			// the suggestion still removes the old suffix.
			endIndex: trimmedEndIndex,
			completion: trimmedCompletion,
		};
		if (result.cursorTargetOffset !== undefined) {
			if (result.cursorTargetOffset >= prefixBeforeCursor.length) {
				trimmedResult.cursorTargetOffset =
					result.cursorTargetOffset - prefixBeforeCursor.length;
			} else {
				delete trimmedResult.cursorTargetOffset;
			}
		}
		return this.trimSuffixOverlap(document, position, trimmedResult);
	}

	private trimSuffixOverlap(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): AutocompleteResult | null {
		if (result.completion.length === 0) {
			return result.endIndex > result.startIndex ? result : null;
		}

		const cursorOffset = document.offsetAt(position);
		const documentLength = document.getText().length;
		// Only text after the replacement range survives acceptance. Looking
		// from the cursor can mistake the old text being replaced for a
		// suffix overlap and truncate the new completion.
		const lookaheadOffset = Math.max(cursorOffset, result.endIndex);
		const maxLookahead = Math.min(
			documentLength - lookaheadOffset,
			result.completion.length,
		);
		if (maxLookahead <= 0) return result;

		const followingText = document.getText(
			new vscode.Range(
				document.positionAt(lookaheadOffset),
				document.positionAt(lookaheadOffset + maxLookahead),
			),
		);

		let overlap = 0;
		for (let i = maxLookahead; i > 0; i--) {
			if (result.completion.endsWith(followingText.slice(0, i))) {
				overlap = i;
				break;
			}
		}

		if (overlap === 0) return result;

		const trimmedCompletion = result.completion.slice(
			0,
			result.completion.length - overlap,
		);
		if (trimmedCompletion.length === 0) return null;

		const out: AutocompleteResult = {
			...result,
			completion: trimmedCompletion,
		};
		// Drop the cursor target if it landed inside the trimmed suffix.
		if (
			out.cursorTargetOffset !== undefined &&
			out.cursorTargetOffset > trimmedCompletion.length
		) {
			delete out.cursorTargetOffset;
		}
		return out;
	}

	private isRequestStale(
		snapshot: RequestSnapshot,
		token: vscode.CancellationToken,
	): boolean {
		if (token.isCancellationRequested) return true;
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) return true;
		if (!vscode.window.state.focused) return true;
		if (activeEditor.document.uri.toString() !== snapshot.uri) return true;
		if (activeEditor.document.version !== snapshot.version) return true;
		if (activeEditor.document.getText() !== snapshot.content) return true;
		const activePosition = activeEditor.selection.active;
		return (
			activePosition.line !== snapshot.position.line ||
			activePosition.character !== snapshot.position.character
		);
	}

	private trimNewlines(text: string): string {
		return text.replace(/^\n+|\n+$/g, "");
	}
}
