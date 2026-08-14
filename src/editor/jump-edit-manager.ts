import * as vscode from "vscode";

import type { AutocompleteResult } from "~/api/schemas.ts";
import { JUMP_RETRIGGER_DELAY_MS } from "~/core/constants.ts";
import { logger } from "~/core/logger.ts";
import {
	classifyEditDisplay,
	EDIT_RANGE_PADDING_ROWS,
	type EditDisplayClassification,
} from "~/editor/edit-display-classifier.ts";
import {
	createHighlightedBoxDecoration,
	createHighlightedBoxDecorationMultiline,
	type HighlightRange,
} from "~/editor/syntax-highlight-renderer.ts";

const HINT_DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
	after: {
		color: new vscode.ThemeColor("editorGhostText.foreground"),
		margin: "0 0 0 1em",
	},
	isWholeLine: true,
});

const REMOVAL_DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
	backgroundColor: "rgba(255, 90, 90, 0.22)",
});

interface PendingJumpEdit {
	result: AutocompleteResult;
	uri: string;
	targetLine: number;
	originalLines: string[];
	newLines: string[];
	editStartPos: vscode.Position;
	editEndPos: vscode.Position;
	originCursorLine: number;
	/**
	 * Index of the next line to accept when accepting a multi-line edit
	 * step-by-step. -1 means "accept everything at once".
	 */
	nextAcceptLine: number;
}

export class JumpEditManager implements vscode.Disposable {
	private pendingJumpEdit: PendingJumpEdit | null = null;
	private disposables: vscode.Disposable[] = [];
	private svgBoxDecorationType = vscode.window.createTextEditorDecorationType(
		{},
	);
	private refreshNonce = 0;

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (
					this.pendingJumpEdit &&
					event.document.uri.toString() === this.pendingJumpEdit.uri &&
					event.contentChanges.length > 0
				) {
					logger.debug("Jump edit cleared: source document changed");
					this.clearJumpEdit();
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(() => {
				if (this.pendingJumpEdit) {
					logger.debug("Jump edit cleared: active editor changed");
					this.clearJumpEdit();
				}
			}),
		);
	}

	classifyEditDisplay(
		document: vscode.TextDocument,
		cursorPosition: vscode.Position,
		result: AutocompleteResult,
	): EditDisplayClassification {
		const editStartLine = document.positionAt(result.startIndex).line;
		const editEndLine = document.positionAt(result.endIndex).line;
		const cursorLine = cursorPosition.line;
		const cursorOffset = document.offsetAt(cursorPosition);
		const editRange = new vscode.Range(
			document.positionAt(result.startIndex),
			document.positionAt(result.endIndex),
		);
		const replacedText = document.getText(editRange);
		const documentText = document.getText();
		const documentLength = documentText.length;
		const atEndOfDocument = cursorOffset >= documentLength;
		const isOnSingleNewlineBoundary =
			cursorOffset > 0 &&
			!atEndOfDocument &&
			documentText[cursorOffset - 1] === "\n" &&
			documentText[cursorOffset] !== "\n";

		const paddedStart = Math.max(0, editStartLine - EDIT_RANGE_PADDING_ROWS);
		const paddedEnd = Math.min(
			document.lineCount - 1,
			editEndLine + EDIT_RANGE_PADDING_ROWS,
		);
		const classification = classifyEditDisplay({
			cursorLine,
			editStartLine,
			editEndLine,
			cursorOffset,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completion: result.completion,
			replacedText,
			isOnSingleNewlineBoundary,
		});

		logger.debug("Edit display classification:", {
			cursorLine,
			editStartLine,
			editEndLine,
			cursorOffset,
			isOnSingleNewlineBoundary,
			paddedStart,
			paddedEnd,
			classification,
		});

		return classification;
	}

	setPendingJumpEdit(
		document: vscode.TextDocument,
		result: AutocompleteResult,
	): void {
		this.clearJumpEdit();

		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
			return;
		}

		const editStartPos = document.positionAt(result.startIndex);
		const editEndPos = document.positionAt(result.endIndex);
		const startLine = editStartPos.line;
		const endLine = editEndPos.line;

		const originalLines: string[] = [];
		for (let i = startLine; i <= endLine; i++) {
			originalLines.push(document.lineAt(i).text);
		}

		const prefixOnStartLine = document
			.lineAt(startLine)
			.text.slice(0, editStartPos.character);
		const suffixOnEndLine = document
			.lineAt(endLine)
			.text.slice(editEndPos.character);
		const fullNewContent =
			prefixOnStartLine + result.completion + suffixOnEndLine;
		const newLines = fullNewContent.split("\n");

		logger.debug("Setting up inline diff preview:", {
			startLine: startLine + 1,
			endLine: endLine + 1,
			originalLines: originalLines.map((l) => l.slice(0, 40)),
			newLines: newLines.map((l) => l.slice(0, 40)),
		});
		if (
			result.completion.includes("<|cursor|>") ||
			result.completion.includes("<|user_cursor|>")
		) {
			logger.warn(
				"Jump edit completion still contains a cursor marker after stripping",
				{ id: result.id, preview: result.completion.slice(0, 200) },
			);
		}

		this.pendingJumpEdit = {
			result,
			uri: document.uri.toString(),
			targetLine: startLine,
			originalLines,
			newLines,
			editStartPos,
			editEndPos,
			originCursorLine: editor.selection.active.line,
			nextAcceptLine: -1, // -1 = accept all at once
		};

		this.applyDecorations(editor, document);
		vscode.commands.executeCommand("setContext", "zeta.hasJumpEdit", true);
	}

	handleCursorMove(position: vscode.Position): void {
		if (!this.pendingJumpEdit) return;
		if (position.line !== this.pendingJumpEdit.originCursorLine) {
			logger.debug("Jump edit cleared: cursor moved off origin line", {
				originLine: this.pendingJumpEdit.originCursorLine,
				currentLine: position.line,
			});
			this.clearJumpEdit();
		}
	}

	private applyDecorations(
		editor: vscode.TextEditor,
		document: vscode.TextDocument,
	): void {
		if (!this.pendingJumpEdit) return;

		const {
			editStartPos,
			editEndPos,
			targetLine,
			originalLines,
			newLines,
			result,
		} = this.pendingJumpEdit;
		const startLine = editStartPos.line;
		const removalRanges: vscode.Range[] = [];
		const floatingBoxOptions: vscode.DecorationOptions[] = [];
		const isMultilineInsertion =
			result.startIndex === result.endIndex && result.completion.includes("\n");

		const maxLines = Math.max(originalLines.length, newLines.length);
		const diffs = Array.from({ length: maxLines }, (_, i) => {
			const oldLine = originalLines[i] ?? "";
			const newLine = newLines[i] ?? "";
			return {
				oldLine,
				newLine,
				diff: this.getLineDiff(oldLine, newLine),
			};
		});

		const hasAdditions = diffs.some((entry) => entry.diff?.newChanged.length);
		const showPreview = hasAdditions;
		const additionLineIndices = diffs
			.map((entry, index) => (entry.diff?.newChanged.length ? index : null))
			.filter((index): index is number => index !== null);
		const additionGroups: number[][] = [];
		for (const index of additionLineIndices) {
			const lastGroup = additionGroups[additionGroups.length - 1];
			if (!lastGroup) {
				additionGroups.push([index]);
				continue;
			}
			const lastIndex = lastGroup[lastGroup.length - 1];
			if (lastIndex === undefined || index !== lastIndex + 1) {
				additionGroups.push([index]);
			} else {
				lastGroup.push(index);
			}
		}
		const combinedGroupIndices = new Set<number>();
		for (const group of additionGroups) {
			if (group.length <= 1) continue;
			for (const index of group) combinedGroupIndices.add(index);
		}
		const renderedLineIndices = new Set<number>();

		for (let i = 0; i < originalLines.length; i++) {
			const { oldLine, newLine, diff } = diffs[i] ?? {};
			if (!diff || oldLine === undefined || newLine === undefined) continue;

			const docLine = startLine + i;
			if (docLine >= document.lineCount) break;

			if (diff.oldChanged.length > 0) {
				const removeStart = new vscode.Position(docLine, diff.prefixLen);
				const removeEnd = new vscode.Position(
					docLine,
					oldLine.length - diff.suffixLen,
				);
				removalRanges.push(new vscode.Range(removeStart, removeEnd));
			}

			if (
				showPreview &&
				diff.newChanged.length > 0 &&
				!isMultilineInsertion &&
				!combinedGroupIndices.has(i)
			) {
				const lineEnd = document.lineAt(docLine).range.end;
				const highlightRanges: HighlightRange[] = [];

				if (diff.newChanged.length > 0) {
					highlightRanges.push({
						start: diff.prefixLen,
						end: diff.prefixLen + diff.newChanged.length,
						color: "rgba(90, 210, 140, 0.22)",
					});
				} else if (diff.oldChanged.length > 0) {
					highlightRanges.push({
						start: 0,
						end: "(delete)".length,
						color: "rgba(255, 90, 90, 0.22)",
					});
				}

				const previewText = newLine.length > 0 ? newLine : "(delete)";
				const decoration = createHighlightedBoxDecoration(
					previewText,
					document.languageId,
					new vscode.Range(lineEnd, lineEnd),
					highlightRanges,
				);
				floatingBoxOptions.push(decoration);
				renderedLineIndices.add(i);
			}
		}

		if (isMultilineInsertion) {
			const addedText = result.completion.endsWith("\n")
				? result.completion.slice(0, -1)
				: result.completion;
			const addedLines = addedText.length > 0 ? addedText.split("\n") : [""];
			const highlightRangesByLine = addedLines.map((line) =>
				line.length > 0
					? [
							{
								start: 0,
								end: line.length,
								color: "rgba(90, 210, 140, 0.22)",
							},
						]
					: [],
			);
			const lineEnd = document.lineAt(startLine).range.end;
			floatingBoxOptions.push(
				createHighlightedBoxDecorationMultiline(
					addedLines,
					document.languageId,
					new vscode.Range(lineEnd, lineEnd),
					highlightRangesByLine,
				),
			);
			for (let index = 0; index < addedLines.length; index++) {
				renderedLineIndices.add(index);
			}
		}

		if (!isMultilineInsertion) {
			for (const group of additionGroups) {
				if (group.length <= 1) continue;
				const startIndex = group[0];
				const endIndex = group[group.length - 1];
				if (startIndex === undefined || endIndex === undefined) {
					continue;
				}
				const combinedLines = newLines.slice(startIndex, endIndex + 1);
				const highlightRangesByLine = combinedLines.map((line, offset) => {
					const diff = diffs[startIndex + offset]?.diff;
					if (!diff || diff.newChanged.length === 0 || line.length === 0) {
						return [];
					}
					return [
						{
							start: diff.prefixLen,
							end: diff.prefixLen + diff.newChanged.length,
							color: "rgba(90, 210, 140, 0.22)",
						},
					];
				});
				const docLine = startLine + startIndex;
				if (docLine >= document.lineCount) continue;
				const lineEnd = document.lineAt(docLine).range.end;
				floatingBoxOptions.push(
					createHighlightedBoxDecorationMultiline(
						combinedLines,
						document.languageId,
						new vscode.Range(lineEnd, lineEnd),
						highlightRangesByLine,
					),
				);
				for (const index of group) {
					renderedLineIndices.add(index);
				}
			}
		}

		if (!isMultilineInsertion && newLines.length > originalLines.length) {
			const hasRenderedExtraLines = Array.from(renderedLineIndices).some(
				(index) => index >= originalLines.length,
			);
			if (!hasRenderedExtraLines) {
				const lastOriginalLine = startLine + originalLines.length - 1;
				const extraCount = newLines.length - originalLines.length;
				const suffix = `(+${extraCount} line${extraCount > 1 ? "s" : ""})`;
				const lineEnd = document.lineAt(lastOriginalLine).range.end;
				floatingBoxOptions.push(
					createHighlightedBoxDecoration(
						suffix,
						document.languageId,
						new vscode.Range(lineEnd, lineEnd),
					),
				);
			}
		}

		editor.setDecorations(REMOVAL_DECORATION_TYPE, removalRanges);
		editor.setDecorations(this.svgBoxDecorationType, floatingBoxOptions);

		const cursorLine = editor.selection.active.line;
		const editEndLine = editEndPos.line;
		const isOnAffectedLine =
			cursorLine >= startLine && cursorLine <= editEndLine;

		// Build a compact preview of the edit content for the hint text.
		let preview = "";
		const changedLines = newLines.filter((line, i) => {
			const oldLine = originalLines[i];
			return oldLine !== undefined ? oldLine !== line : true;
		});
		if (changedLines.length === 0) {
			preview = newLines.join("\\n").slice(0, 60);
		} else if (changedLines.length === 1) {
			const first = changedLines[0] ?? "";
			preview = first.length > 50 ? first.slice(0, 47) + "..." : first;
		} else {
			const added = changedLines.length;
			const total = newLines.length;
			preview = `${added} of ${total} line${total > 1 ? "s" : ""} altered`;
		}
		const hintText = isOnAffectedLine
			? `← Edit here: ${preview} (Alt+Tab accept all, Ctrl+Enter line, Esc)`
			: `→ Edit at line ${targetLine + 1}: ${preview} (Alt+Tab all, Ctrl+Enter line)`;

		const hintDecoration: vscode.DecorationOptions = {
			range: new vscode.Range(cursorLine, 0, cursorLine, 0),
			renderOptions: {
				after: {
					contentText: hintText,
				},
			},
		};
		editor.setDecorations(HINT_DECORATION_TYPE, [hintDecoration]);
	}

	private getLineDiff(
		oldLine: string,
		newLine: string,
	): {
		oldChanged: string;
		newChanged: string;
		prefixLen: number;
		suffixLen: number;
	} | null {
		if (oldLine === newLine) return null;

		let prefixLen = 0;
		const minLen = Math.min(oldLine.length, newLine.length);
		while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) {
			prefixLen++;
		}

		let suffixLen = 0;
		while (
			suffixLen < minLen - prefixLen &&
			oldLine[oldLine.length - 1 - suffixLen] ===
				newLine[newLine.length - 1 - suffixLen]
		) {
			suffixLen++;
		}

		const oldChanged = oldLine.slice(prefixLen, oldLine.length - suffixLen);
		const newChanged = newLine.slice(prefixLen, newLine.length - suffixLen);

		return { oldChanged, newChanged, prefixLen, suffixLen };
	}

	async acceptJumpEdit(): Promise<void> {
		if (!this.pendingJumpEdit) {
			logger.warn("acceptJumpEdit called but no pending jump edit");
			return;
		}
		// Accept all remaining lines at once
		this.pendingJumpEdit.nextAcceptLine = -1;
		await this.applyAccept();
	}

	/**
	 * Accept the next changed line of a multi-line jump edit, step by step.
	 */
	async acceptJumpEditLine(): Promise<void> {
		if (!this.pendingJumpEdit) {
			logger.warn("acceptJumpEditLine called but no pending jump edit");
			return;
		}
		if (this.pendingJumpEdit.nextAcceptLine < 0) {
			this.pendingJumpEdit.nextAcceptLine = 0;
		}
		await this.applyAccept();
	}

	private async applyAccept(): Promise<void> {
		if (!this.pendingJumpEdit) return;
		const pendingJumpEdit = this.pendingJumpEdit;
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== pendingJumpEdit.uri) {
			logger.debug("applyAccept: editor mismatch, clearing jump edit");
			this.clearJumpEdit();
			return;
		}

		const { result, originalLines, newLines, nextAcceptLine } = pendingJumpEdit;
		const start = editor.document.positionAt(result.startIndex);
		const end = editor.document.positionAt(result.endIndex);

		// Accept all lines at once when nextAcceptLine is -1 or single-line edit
		if (nextAcceptLine < 0 || newLines.length <= 1) {
			logger.info("Accepting jump edit (all lines)", {
				targetLine: start.line + 1,
			});
			const editRange = new vscode.Range(start, end);
			const success = await editor.edit(
				(editBuilder) => {
					editBuilder.replace(editRange, result.completion);
				},
				{ undoStopBefore: true, undoStopAfter: true },
			);
			if (success) {
				this.handlePostAccept(pendingJumpEdit, start, result);
			}
			this.clearJumpEdit();
			return;
		}

		// Step-by-step: apply only the current line
		const lineIdx = Math.min(nextAcceptLine, newLines.length - 1);
		const oldLine = originalLines[lineIdx] ?? "";
		const newLine = newLines[lineIdx] ?? "";
		if (oldLine === newLine) {
			pendingJumpEdit.nextAcceptLine = lineIdx + 1;
			if (pendingJumpEdit.nextAcceptLine >= newLines.length) {
				this.clearJumpEdit();
				return;
			}
			this.refreshJumpEditDecorations();
			return;
		}

		const docLine = start.line + lineIdx;
		if (docLine >= editor.document.lineCount) {
			this.clearJumpEdit();
			return;
		}

		const lineRange = editor.document.lineAt(docLine).range;
		logger.info("Accepting jump edit line", {
			line: docLine + 1,
			oldLine,
			newLine,
		});

		const success = await editor.edit(
			(editBuilder) => {
				editBuilder.replace(lineRange, newLine);
			},
			{ undoStopBefore: true, undoStopAfter: true },
		);

		if (success) {
			pendingJumpEdit.nextAcceptLine = lineIdx + 1;
			if (pendingJumpEdit.nextAcceptLine >= newLines.length) {
				this.handlePostAccept(pendingJumpEdit, start, result);
				this.clearJumpEdit();
			} else {
				pendingJumpEdit.targetLine =
					start.line + pendingJumpEdit.nextAcceptLine;
				this.refreshJumpEditDecorations();
			}
		}
	}

	private handlePostAccept(
		pendingJumpEdit: PendingJumpEdit,
		start: vscode.Position,
		result: AutocompleteResult,
	): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		let newPos: vscode.Position;
		if (result.cursorTargetOffset !== undefined) {
			const before = result.completion.slice(0, result.cursorTargetOffset);
			const newlinesBefore = (before.match(/\n/g) ?? []).length;
			const targetLine = start.line + newlinesBefore;
			const lastNl = before.lastIndexOf("\n");
			const targetChar =
				lastNl === -1
					? start.character + before.length
					: before.length - lastNl - 1;
			const safeLine = Math.min(targetLine, editor.document.lineCount - 1);
			newPos = new vscode.Position(safeLine, targetChar);
		} else {
			const endsWithNewline = result.completion.endsWith("\n");
			const insertedLines = result.completion.split("\n");
			const contentLineCount = endsWithNewline
				? insertedLines.length - 1
				: insertedLines.length;
			const newCursorLine = start.line + Math.max(0, contentLineCount - 1);
			const safeLine = Math.min(newCursorLine, editor.document.lineCount - 1);
			newPos = new vscode.Position(
				safeLine,
				editor.document.lineAt(safeLine).text.length,
			);
		}
		editor.selection = new vscode.Selection(newPos, newPos);
		editor.revealRange(
			new vscode.Range(newPos, newPos),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
		logger.info("Jump edit applied successfully");

		setTimeout(() => {
			const activeEditor = vscode.window.activeTextEditor;
			if (
				!activeEditor ||
				activeEditor.document.uri.toString() !== pendingJumpEdit.uri
			)
				return;
			logger.debug("Retriggering after accepted jump edit");
			void vscode.commands.executeCommand(
				"editor.action.inlineSuggest.trigger",
			);
		}, JUMP_RETRIGGER_DELAY_MS);
	}

	dismissJumpEdit(): void {
		logger.info("Jump edit dismissed by user");
		this.clearJumpEdit();
	}

	refreshJumpEditDecorations(): void {
		if (!this.pendingJumpEdit) return;
		this.clearDecorations();
		this.resetSvgDecorationType();
		const pendingUri = this.pendingJumpEdit.uri;
		this.refreshNonce += 1;
		const refreshToken = this.refreshNonce;
		const scheduleRefresh = (delay: number) => {
			setTimeout(() => {
				if (this.refreshNonce !== refreshToken) return;
				if (!this.pendingJumpEdit || this.pendingJumpEdit.uri !== pendingUri) {
					return;
				}
				const editor = vscode.window.activeTextEditor;
				if (!editor || editor.document.uri.toString() !== pendingUri) {
					return;
				}
				this.applyDecorations(editor, editor.document);
			}, delay);
		};
		scheduleRefresh(0);
		scheduleRefresh(50);
		scheduleRefresh(150);
	}

	private resetSvgDecorationType(): void {
		this.svgBoxDecorationType.dispose();
		this.svgBoxDecorationType = vscode.window.createTextEditorDecorationType(
			{},
		);
	}

	clearJumpEdit(): void {
		const hadPending = this.pendingJumpEdit !== null;
		this.pendingJumpEdit = null;
		this.clearDecorations();
		vscode.commands.executeCommand("setContext", "zeta.hasJumpEdit", false);
		if (hadPending) {
			logger.debug("Jump edit state cleared");
		}
	}

	private clearDecorations(): void {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			editor.setDecorations(HINT_DECORATION_TYPE, []);
			editor.setDecorations(REMOVAL_DECORATION_TYPE, []);
			editor.setDecorations(this.svgBoxDecorationType, []);
		}
	}

	dispose(): void {
		this.clearJumpEdit();
		this.svgBoxDecorationType.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}
