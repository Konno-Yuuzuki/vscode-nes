import { Position, Range, TextDocument } from 'vscode';

export interface InlineSuggestionEdit {
	readonly range: Range;
	readonly newText: string;
}

/**
 * Determines whether an edit can be displayed as an inline suggestion (ghost text).
 * If so, returns the (possibly adjusted) range and text that touches the cursor position,
 * which is required for VS Code to render ghost text.
 * Ported from microsoft/vscode copilot extension.
 */
export function toInlineSuggestion(
	cursorPos: Position,
	doc: TextDocument,
	range: Range,
	newText: string,
	advanced: boolean = true,
): InlineSuggestionEdit | undefined {
	// Special case: a multi-line insertion that starts on the line *after* the cursor
	// can be re-expressed as a pure insertion at the cursor.
	const nextLineInsertion = tryAdjustNextLineInsertion(cursorPos, doc, range, newText);
	if (nextLineInsertion) {
		return nextLineInsertion;
	}

	// If the range spans multiple lines, try to collapse it to a single line by
	// trimming a shared prefix up to a newline boundary.
	if (advanced && range.start.line !== range.end.line) {
		({ range, newText } = stripCommonLinePrefix(doc, range, newText));
	}

	// Ghost text requires the edit to be on the cursor's line.
	if (range.start.line !== range.end.line || range.start.line !== cursorPos.line) {
		return undefined;
	}

	return validateSameLineGhostText(cursorPos, doc, range, newText);
}

function tryAdjustNextLineInsertion(
	cursorPos: Position,
	doc: TextDocument,
	range: Range,
	newText: string,
): InlineSuggestionEdit | undefined {
	if (!range.isEmpty) {
		return undefined;
	}
	if (cursorPos.line + 1 !== range.start.line || range.start.character !== 0) {
		return undefined;
	}
	if (doc.lineAt(cursorPos.line).text.length !== cursorPos.character) {
		return undefined; // cursor is not at the end of the line
	}

	const targetLineFullyConsumed =
		doc.lineAt(range.end.line).text.length === range.end.character;
	const noLeftoverAfterInsertion =
		newText.endsWith('\n') ||
		(newText.includes('\n') && targetLineFullyConsumed);
	if (!noLeftoverAfterInsertion) {
		return undefined;
	}

	const lineBreak = doc.getText(new Range(cursorPos, range.start));
	const trimmedNewText = newText.replace(/\r?\n$/, '');
	return { range: new Range(cursorPos, cursorPos), newText: lineBreak + trimmedNewText };
}

function stripCommonLinePrefix(
	doc: TextDocument,
	range: Range,
	newText: string,
): { range: Range; newText: string } {
	const replacedText = doc.getText(range);
	const maxLen = Math.min(replacedText.length, newText.length);
	let commonLen = 0;
	while (commonLen < maxLen && replacedText[commonLen] === newText[commonLen]) {
		commonLen++;
	}
	if (commonLen === 0) {
		return { range, newText };
	}
	const lastNewline = replacedText.lastIndexOf('\n', commonLen - 1);
	if (lastNewline < 0) {
		return { range, newText };
	}
	const strippedLen = lastNewline + 1;
	const newStart = doc.positionAt(doc.offsetAt(range.start) + strippedLen);
	return { range: new Range(newStart, range.end), newText: newText.substring(strippedLen) };
}

function validateSameLineGhostText(
	cursorPos: Position,
	doc: TextDocument,
	range: Range,
	newText: string,
): InlineSuggestionEdit | undefined {
	const replacedText = doc.getText(range);
	const cursorOffsetInReplacedText = cursorPos.character - range.start.character;
	if (cursorOffsetInReplacedText < 0) {
		return undefined;
	}
	if (
		replacedText.substring(0, cursorOffsetInReplacedText) !==
		newText.substring(0, cursorOffsetInReplacedText)
	) {
		return undefined;
	}
	if (!isSubword(replacedText, newText)) {
		return undefined;
	}
	return { range, newText };
}

/**
 * a is subword of b if a can be obtained by removing characters from b
 */
export function isSubword(a: string, b: string): boolean {
	for (let aIdx = 0, bIdx = 0; aIdx < a.length; bIdx++) {
		if (bIdx >= b.length) {
			return false;
		}
		if (a[aIdx] === b[bIdx]) {
			aIdx++;
		}
	}
	return true;
}