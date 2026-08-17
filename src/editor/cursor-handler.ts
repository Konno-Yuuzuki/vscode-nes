import * as vscode from "vscode";
import { config } from "~/core/config";
import { JUMP_RETRIGGER_DELAY_MS } from "~/core/constants.ts";
import { logger } from "~/core/logger.ts";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import { selectZetaCursorWindowFromLineProvider } from "~/api/zeta2-prompt.ts";
import type { PendingProposedJump } from "~/editor/inline-edit-renderer.ts";

export interface EditableContextWindow {
	uri: string;
	version: number;
	startLine: number;
	endLine: number;
	anchorLine: number;
	retriggered: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export interface RequestSnapshot {
	uri: string;
	version: number;
	position: vscode.Position;
	content: string;
	cursorOffset: number;
}

/**
 * Manages the editable context window (the range of lines the model is
 * allowed to edit) and cursor-movement retrigger logic.
 */
export class CursorHandler {
	private jumpEditManager: JumpEditManager;
	private _editableContextWindow: EditableContextWindow | null = null;

	constructor(jumpEditManager: JumpEditManager) {
		this.jumpEditManager = jumpEditManager;
	}

	get editableContextWindow(): EditableContextWindow | null {
		return this._editableContextWindow;
	}

	rememberEditableContextWindow(
		document: vscode.TextDocument,
		snapshot: Pick<RequestSnapshot, "uri" | "version" | "position">,
	): void {
		const format = detectModelFormat(config.modelName);
		let startLine: number;
		let endLine: number;
		if (format === "zeta2" || format === "zeta2.1") {
			const window = selectZetaCursorWindowFromLineProvider(
				document.lineCount,
				snapshot.position.line,
				config.editableTokens,
				config.zetaContextTokens,
				(line) => document.lineAt(line).text,
				config.syntaxAwareExpansion,
			);
			startLine = window.editableStart;
			endLine = window.editableEnd;
		} else {
			const window = selectZetaCursorWindowFromLineProvider(
				document.lineCount,
				snapshot.position.line,
				config.editableTokens,
				config.zetaContextTokens,
				(line) => document.lineAt(line).text,
				config.syntaxAwareExpansion,
			);
			startLine = window.editableStart;
			endLine = window.editableEnd;
		}
		this._editableContextWindow = {
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

	/**
	 * After a proposed inline edit has been accepted (detected via
	 * document-change event), check if the cursor should be repositioned
	 * to the model's predicted location. If the cursor target is on a
	 * different line, arm a pending proposed jump so the next selection
	 * change can move the cursor there.
	 */
	maybeRetriggerAfterProposedJump(
		document: vscode.TextDocument,
		editor: vscode.TextEditor,
		pendingProposedJump: PendingProposedJump | null,
	): void {
		if (!pendingProposedJump) return;
		if (document.uri.toString() !== pendingProposedJump.uri) return;
		if (document.version !== pendingProposedJump.version) return;

		const cursorLine = editor.selection.active.line;
		const targetLine = pendingProposedJump.targetLine;
		if (cursorLine === targetLine) return;

		// If the cursor is on the same line as the target, we're done
		if (cursorLine === targetLine) return;

		// Jump to the target line after a short delay to let the accept
		// settle. Use a debounced timer so rapid changes don't spam jumps.
		if (this._editableContextWindow?.timer) {
			clearTimeout(this._editableContextWindow.timer);
		}
		const timer = setTimeout(() => {
			if (editor.document.uri.toString() !== pendingProposedJump.uri) return;
			if (editor.document.version !== pendingProposedJump.version) return;
			editor.selection = new vscode.Selection(
				new vscode.Position(targetLine, 0),
				new vscode.Position(targetLine, 0),
			);
			editor.revealRange(
				new vscode.Range(targetLine, 0, targetLine, 0),
				vscode.TextEditorRevealType.Default,
			);
		}, JUMP_RETRIGGER_DELAY_MS);
		if (this._editableContextWindow) {
			this._editableContextWindow.timer = timer;
		}
	}

	/**
	 * Check if the cursor has moved outside the editable context window
	 * and, if so, schedule a retrigger of the inline completion provider.
	 * Returns the debounce timer if one was created, null otherwise.
	 */
	maybeRetriggerOnEditableContextExit(
		document: vscode.TextDocument,
		editors: readonly vscode.TextEditor[],
		retriggeredWindows: Set<string>,
	): void {
		const window = this._editableContextWindow;
		if (!window) return;

		if (config.retriggerOnContextExit === false) return;

		// Only retrigger for the active editor
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== window.uri) {
			this.clearEditableContextWindow();
			return;
		}

		const position = editor.selection.active;
		// If the cursor is still inside the window, do nothing
		if (position.line >= window.startLine && position.line <= window.endLine) {
			if (window.timer) {
				clearTimeout(window.timer);
				delete window.timer;
			}
			return;
		}

		// Check if we've already retriggered for this window
		const windowKey = `${window.uri}:${window.version}`;
		if (retriggeredWindows.has(windowKey)) {
			return;
		}

		// Calculate retrigger distance: half the window size (minimum 2)
		const windowSize = window.endLine - window.startLine + 1;
		const retriggerDistance = Math.max(
			2,
			Math.ceil(windowSize / 2),
		);
		const movedLines = Math.abs(position.line - window.anchorLine);
		if (movedLines < retriggerDistance) {
			if (window.timer) {
				clearTimeout(window.timer);
				delete window.timer;
			}
			return;
		}

		if (!config.retriggerOnContextExit) return;

		logger.debug("Cursor crossed editable-context retrigger threshold", {
			startLine: window.startLine,
			endLine: window.endLine,
			anchorLine: window.anchorLine,
			currentLine: position.line,
			movedLines,
			retriggerDistance,
			debounceMs: config.retriggerDebounceMs,
		});

		// Debounce the retrigger so rapid cursor movements don't flood
		if (window.timer) {
			clearTimeout(window.timer);
		}
		window.timer = setTimeout(() => {
			if (!this._editableContextWindow) return;
			delete this._editableContextWindow.timer;
			logger.debug("Retriggering after cursor crossed editable-context threshold", {
				startLine: window.startLine,
				endLine: window.endLine,
				anchorLine: window.anchorLine,
				currentLine: position.line,
				movedLines,
				retriggerDistance,
				debounceMs: config.retriggerDebounceMs,
			});
			if (editors.length > 0) {
				vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
			}
		}, config.retriggerDebounceMs);
	}

	clearEditableContextWindow(): void {
		this._editableContextWindow = null;
	}
}

/**
 * Detect the model format from the model name string.
 */
function detectModelFormat(modelName: string): string {
	if (modelName.includes("zeta2") || modelName.includes("zeta")) {
		return "zeta2";
	}
	return "code";
}