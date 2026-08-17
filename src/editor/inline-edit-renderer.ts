import * as vscode from "vscode";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { config } from "~/core/config";
import { logger } from "~/core/logger.ts";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import { SuggestionCache } from "~/editor/suggestion-cache.ts";
import {
	enableForwardStability,
	markAsProposedInlineEdit,
	INLINE_COMPLETION_DISPLAY_LOCATION_KIND,
	type ProposedInlineCompletionDisplayLocation,
} from "~/editor/proposed-inline-edit.ts";

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

interface QueuedSuggestionState {
	uri: string;
	suggestions: AutocompleteResult[];
}

export interface PendingProposedJump {
	uri: string;
	version: number;
	targetLine: number;
	/** Model cursor marker inside the completion, restored after the
	 *  native inline-edit accept applies the text (item.command is NOT
	 *  executed by VS Code for isInlineEdit=true items, so we arm the
	 *  restore on the document-change event instead). */
	cursorTargetOffset?: number;
	/** Document offset of the edit start; target = startIndex + cursorTargetOffset. */
	startIndex?: number;
	/** Completion length — used to discard the arm when the applied
	 *  text does not match the suggested replacement. */
	completionLength?: number;
	/** Document offset of the edit end (replaced range). */
	endIndex?: number;
}

// Build a SnippetString that places the final cursor ($0) at the model's
// predicted post-edit position. Snippet metacharacters in the surrounding
// text need to be escaped — `$`, `}` and `\\` would otherwise be parsed as
// snippet syntax.
function toSnippetWithCursor(
	completion: string,
	cursorOffset: number,
): vscode.SnippetString {
	const escapeSnippet = (s: string) => s.replace(/[\\\\$}]/g, "\\$&");
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

const MAX_SPLIT_DIFF_LINES = 128;

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

/** Command names for hiding the native suggest widget across VS Code versions. */
const SUGGEST_HIDE_COMMANDS = [
	"editor.action.suggestWidget.hide",
	"editor.action.closeSuggestWidget",
	"closeSuggestWidget",
	"hideSuggestWidget",
];

/** Awaitable version of hideSuggestWidget. Returns a promise that resolves
 *  when the first successful close command completes. */
async function hideSuggestWidgetAsync(): Promise<void> {
	for (const cmd of SUGGEST_HIDE_COMMANDS) {
		try {
			await vscode.commands.executeCommand(cmd);
			return;
		} catch {
			// Try next command
		}
	}
}

type NormalizeResultFn = (
	document: vscode.TextDocument,
	position: vscode.Position,
	result: AutocompleteResult,
) => AutocompleteResult | null;

export class InlineEditRenderer {
	private jumpEditManager: JumpEditManager;
	private suggestionCache: SuggestionCache;
	private normalizeResult: NormalizeResultFn;
	private lastInlineEdit: {
		uri: string;
		line: number;
		character: number;
		version: number;
		suggestion: AcceptedInlineSuggestion;
	} | null = null;
	private queuedSuggestions: QueuedSuggestionState | null = null;
	private shouldConsumeQueuedSuggestion = false;
	pendingProposedJump: PendingProposedJump | null = null;

	constructor(
		jumpEditManager: JumpEditManager,
		suggestionCache: SuggestionCache,
		normalizeResult: NormalizeResultFn,
	) {
		this.jumpEditManager = jumpEditManager;
		this.suggestionCache = suggestionCache;
		this.normalizeResult = normalizeResult;
	}

	buildCompletionItem(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
		options: CompletionItemBuildOptions = {},
	): vscode.InlineCompletionList | undefined {
		// Fire-and-forget close of the suggest widget: if it's visible it
		// would block the ghost text. Do NOT await — that delays the
		// completion and can cause the request to be cancelled by a
		// subsequent keystroke.
		if (config.useCopilotStyleNextEditPresentation) {
			void hideSuggestWidgetAsync();
		}

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

		if (result.startIndex < cursorOffset && !useProposedInlineEditPresentation) {
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
				...(result.cursorTargetOffset !== undefined
					? {
							cursorTargetOffset: result.cursorTargetOffset,
							startIndex: result.startIndex,
							endIndex: result.endIndex,
							completionLength: result.completion.length,
						}
					: {}),
			};
			logger.debug("Watching proposed jump target", {
				targetLine: startPosition.line,
				originLine: position.line,
				cursorTargetOffset: result.cursorTargetOffset,
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
			command: "zeta.acceptInlineEdit",
			arguments: [acceptedSuggestion],
		};
		if (useProposedInlineEditPresentation) {
			// VS Code's custom inline-edit build derives the ghost-text hint
			// anchor from `displayLocation`. Without it the hint is `void 0`
			// and the inline edit is silently skipped. Use a Label-style hint
			// with the extension name so it renders correctly.
			const proposedOptions: Parameters<typeof markAsProposedInlineEdit>[1] = {
				correlationId: result.id,
				showRange: editRange,
				displayLocation:
					options.displayLocation ?? {
						range: new vscode.Range(startPosition, startPosition),
						kind: INLINE_COMPLETION_DISPLAY_LOCATION_KIND.Label,
						label: "Zeta",
					},
			};
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

	clearInlineEdit(
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

	// True when the user is typing forward on the same line and the typed
	// delta is a prefix of the rendered ghost text. Lets VSCode shrink the
	// ghost text in place while the next provider call piggybacks on the
	// in-flight request and extends the suggestion.
	isPrefixTypingExtension(
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

	placeCursorAfterPlainTextAccept(
		editor: vscode.TextEditor,
		acceptedSuggestion: AcceptedInlineSuggestion,
	): void {
		if (acceptedSuggestion.cursorTargetOffset === undefined) return;
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

	setSuggestionQueue(
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

	clearSuggestionQueue(reason?: string): void {
		const hadQueuedSuggestions = this.queuedSuggestions !== null;
		this.queuedSuggestions = null;
		this.shouldConsumeQueuedSuggestion = false;
		if (reason && hadQueuedSuggestions) {
			logger.debug("Cleared queued suggestions:", reason);
		}
	}

	consumeQueuedSuggestion(
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
			const normalized = this.normalizeResult(document, position, next);
			if (!normalized) continue;
			// Temporarily disabled to diagnose "third completion not showing"
			// (mirrors the main path — isNoOpSuggestion can misjudge valid
			// suggestions as no-op and skip rendering them).
			// if (this.isNoOpSuggestion(document, normalized)) continue;

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

	adjustQueuedSuggestionsAfterAccept(
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
}