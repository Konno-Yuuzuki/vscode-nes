import { afterEach, describe, expect, test } from "bun:test";
import * as vscode from "vscode";

import type { ApiClient } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import {
	type AcceptedInlineSuggestion,
	InlineEditProvider,
	inlineEditMatchesSelectedCompletion,
	splitDisjointLineEdits,
} from "~/editor/inline-edit-provider.ts";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import type { DocumentTracker } from "~/telemetry/document-tracker.ts";

function makeOneLineDocument(
	text: string,
	version = 1,
	lineCount = 1,
): vscode.TextDocument {
	return {
		uri: { toString: () => "file:///test.ts" },
		version,
		lineCount,
		lineAt: () => ({ text }),
		getText: (range?: vscode.Range) => {
			if (!range) return text;
			const start = (range.start as vscode.Position).character;
			const end = (range.end as vscode.Position).character;
			return text.slice(start, end);
		},
		offsetAt: (position: vscode.Position) => position.character,
		positionAt: (offset: number) => new vscode.Position(0, offset),
	} as unknown as vscode.TextDocument;
}

function buildItem(
	document: vscode.TextDocument,
	position: vscode.Position,
	result: AutocompleteResult,
	options?: { useProposedInlineEditPresentation?: boolean },
	jumpEditManager = {} as JumpEditManager,
) {
	const provider = new InlineEditProvider(
		{} as DocumentTracker,
		jumpEditManager,
		{} as ApiClient,
	) as unknown as {
		buildCompletionItem: (
			document: vscode.TextDocument,
			position: vscode.Position,
			result: AutocompleteResult,
			options?: { useProposedInlineEditPresentation?: boolean },
		) => vscode.InlineCompletionList | undefined;
	};

	return provider.buildCompletionItem(document, position, result, options)
		?.items[0];
}

function normalizeResult(
	document: vscode.TextDocument,
	position: vscode.Position,
	result: AutocompleteResult,
): AutocompleteResult | null {
	const provider = new InlineEditProvider(
		{} as DocumentTracker,
		{} as JumpEditManager,
		{} as ApiClient,
	) as unknown as {
		normalizeInlineResult: (
			document: vscode.TextDocument,
			position: vscode.Position,
			result: AutocompleteResult,
		) => AutocompleteResult | null;
	};
	return provider.normalizeInlineResult(document, position, result);
}

function requestIsStale(
	document: vscode.TextDocument,
	position: vscode.Position,
	snapshotOverrides: Partial<{
		uri: string;
		version: number;
		position: vscode.Position;
		content: string;
		cursorOffset: number;
	}> = {},
): boolean {
	const provider = new InlineEditProvider(
		{} as DocumentTracker,
		{} as JumpEditManager,
		{} as ApiClient,
	) as unknown as {
		isRequestStale: (
			snapshot: {
				uri: string;
				version: number;
				position: vscode.Position;
				content: string;
				cursorOffset: number;
			},
			token: vscode.CancellationToken,
		) => boolean;
	};
	const editor = {
		document,
		selection: new vscode.Selection(position, position),
	} as unknown as vscode.TextEditor;
	setActiveTextEditor(editor);
	return provider.isRequestStale(
		{
			uri: document.uri.toString(),
			version: document.version,
			position,
			content: document.getText(),
			cursorOffset: document.offsetAt(position),
			...snapshotOverrides,
		},
		{ isCancellationRequested: false } as vscode.CancellationToken,
	);
}

function applyOneLineItem(
	text: string,
	item: vscode.InlineCompletionItem | undefined,
): string | undefined {
	if (!item?.range || typeof item.insertText !== "string") return undefined;
	const start = item.range.start.character;
	const end = item.range.end.character;
	return text.slice(0, start) + item.insertText + text.slice(end);
}

function setMockConfiguration(values: Record<string, unknown>): void {
	(
		globalThis as typeof globalThis & { __vscodeMockConfiguration?: unknown }
	).__vscodeMockConfiguration = values;
}

function setActiveTextEditor(editor: vscode.TextEditor | undefined): void {
	(
		vscode.window as unknown as {
			activeTextEditor: vscode.TextEditor | undefined;
		}
	).activeTextEditor = editor;
}

function setVisibleTextEditors(editors: readonly vscode.TextEditor[]): void {
	(
		vscode.window as unknown as {
			visibleTextEditors: readonly vscode.TextEditor[];
		}
	).visibleTextEditors = editors;
}

afterEach(() => {
	setMockConfiguration({});
	setActiveTextEditor(undefined);
	setVisibleTextEditors([]);
});

describe("InlineEditProvider cursor context retrigger", () => {
	test("triggers once after a debounced exit from the editable window", async () => {
		setMockConfiguration({
			retriggerOnContextExit: true,
			contextExitRetriggerDebounceMs: 0,
		});
		const document = makeOneLineDocument("const value = 1;", 1, 10);
		const nearPosition = new vscode.Position(4, 0);
		const exitPosition = new vscode.Position(5, 0);
		const editor = {
			document,
			selection: new vscode.Selection(nearPosition, nearPosition),
		} as vscode.TextEditor;
		setActiveTextEditor(editor);

		const commands = vscode.commands as unknown as {
			executeCommand: (...args: unknown[]) => Promise<unknown>;
		};
		const originalExecuteCommand = commands.executeCommand;
		const triggered: string[] = [];
		commands.executeCommand = async (command: unknown) => {
			if (typeof command === "string") triggered.push(command);
		};

		try {
			const provider = new InlineEditProvider(
				{} as DocumentTracker,
				{} as JumpEditManager,
				{} as ApiClient,
			);
			// The first movement establishes a baseline context; no model result
			// is required. A 10-line window uses a 5-line trigger threshold.
			await provider.handleCursorMove(document, new vscode.Position(0, 0));
			await provider.handleCursorMove(document, nearPosition);
			await Bun.sleep(5);
			expect(triggered).toEqual([]);

			editor.selection = new vscode.Selection(exitPosition, exitPosition);
			await provider.handleCursorMove(document, exitPosition);
			await Bun.sleep(5);
			expect(triggered).toEqual(["editor.action.inlineSuggest.trigger"]);
		} finally {
			commands.executeCommand = originalExecuteCommand;
		}
	});
});

describe("InlineEditProvider buildCompletionItem", () => {
	test("sets filterText when replacing text that is not a prefix of the completion", () => {
		const text = "const value = oldCall();";
		const cursorOffset = "const value = ".length;
		const document = makeOneLineDocument(text);

		const item = buildItem(document, new vscode.Position(0, cursorOffset), {
			id: "non-prefix-replacement",
			startIndex: cursorOffset,
			endIndex: text.length,
			completion: "newCall()",
			confidence: 0.8,
		});

		expect(item?.filterText).toBe("oldCall();");
	});

	test("leaves filterText unset when replaced text is already a prefix", () => {
		const text = "const value = high";
		const cursorOffset = "const value = ".length;
		const document = makeOneLineDocument(text);

		const item = buildItem(document, new vscode.Position(0, cursorOffset), {
			id: "prefix-replacement",
			startIndex: cursorOffset,
			endIndex: text.length,
			completion: "highWatermark",
			confidence: 0.8,
		});

		expect(item?.filterText).toBeUndefined();
	});

	test("can render edits before the cursor as proposed inline edits when enabled", () => {
		setMockConfiguration({
			useCopilotStyleNextEditPresentation: true,
		});
		const text = "const value = oldValue;";
		const startIndex = "const value = ".length;
		const endIndex = "const value = oldValue".length;
		const document = makeOneLineDocument(text);

		const item = buildItem(
			document,
			new vscode.Position(0, text.length),
			{
				id: "before-cursor-proposed-inline-edit",
				startIndex,
				endIndex,
				completion: "newValue",
				confidence: 0.8,
			},
			{ useProposedInlineEditPresentation: true },
		) as vscode.InlineCompletionItem & {
			isInlineEdit?: boolean;
			showInlineEditMenu?: boolean;
			showRange?: vscode.Range;
			displayLocation?: unknown;
		};

		expect(item?.isInlineEdit).toBe(true);
		expect(item?.showInlineEditMenu).toBe(true);
		expect(item?.showRange).toBeUndefined();
		expect(item?.displayLocation).toBeUndefined();
		expect(applyOneLineItem(text, item)).toBe("const value = newValue;");
	});

	test("uses plain text for proposed replacements with a cursor target", () => {
		setMockConfiguration({
			useCopilotStyleNextEditPresentation: true,
		});
		const prefix = 'LogDebug("CTextDraw::Draw: ';
		const text = `${prefix}"))`;
		const completion = '");';
		const document = makeOneLineDocument(text);

		const item = buildItem(
			document,
			new vscode.Position(0, prefix.length),
			{
				id: "proposed-replacement-with-cursor",
				startIndex: prefix.length,
				endIndex: text.length,
				completion,
				confidence: 0.8,
				cursorTargetOffset: 0,
			},
			{ useProposedInlineEditPresentation: true },
		) as vscode.InlineCompletionItem & { isInlineEdit?: boolean };

		expect(item?.isInlineEdit).toBe(true);
		expect(typeof item?.insertText).toBe("string");
		expect(applyOneLineItem(text, item)).toBe(`${prefix}");`);
		const accepted = item?.command?.arguments?.[0] as
			| AcceptedInlineSuggestion
			| undefined;
		expect(accepted?.cursorTargetOffset).toBe(0);
		expect(accepted?.uri).toBe(document.uri.toString());
	});

	test("uses the custom jump fallback by default", () => {
		const text = "const value = oldValue;";
		const startIndex = "const value = ".length;
		const endIndex = "const value = oldValue".length;
		const document = makeOneLineDocument(text);
		let fallbackResult: AutocompleteResult | undefined;

		const item = buildItem(
			document,
			new vscode.Position(0, text.length),
			{
				id: "before-cursor-custom-jump",
				startIndex,
				endIndex,
				completion: "newValue",
				confidence: 0.8,
			},
			{ useProposedInlineEditPresentation: true },
			{
				setPendingJumpEdit: (
					_document: vscode.TextDocument,
					result: AutocompleteResult,
				) => {
					fallbackResult = result;
				},
			} as JumpEditManager,
		);

		expect(item).toBeUndefined();
		expect(fallbackResult?.id).toBe("before-cursor-custom-jump");
	});
});

describe("InlineEditProvider handleInlineAccept", () => {
	test("restores the predicted cursor after a proposed plain-text edit", () => {
		const prefix = 'LogDebug("CTextDraw::Draw: ';
		const document = makeOneLineDocument(`${prefix}");`);
		const editor = {
			document,
			selection: new vscode.Selection(
				new vscode.Position(0, document.getText().length),
				new vscode.Position(0, document.getText().length),
			),
			revealRange: () => {},
		} as unknown as vscode.TextEditor;
		setActiveTextEditor(editor);

		const provider = new InlineEditProvider(
			{} as DocumentTracker,
			{} as JumpEditManager,
			{} as ApiClient,
		);
		provider.handleInlineAccept({
			id: "accepted-proposed-edit",
			uri: document.uri.toString(),
			startIndex: prefix.length,
			endIndex: prefix.length + 3,
			completion: '");',
			cursorTargetOffset: 0,
		});

		expect(editor.selection.active.character).toBe(prefix.length);
	});
});

describe("InlineEditProvider recent context", () => {
	test("excludes Output-channel logs from visible editor buffers", () => {
		const logDocument = {
			uri: {
				scheme: "output",
				toString: () => "output:SR-team.nesweep.NESweep.log",
			},
		} as vscode.TextDocument;
		setVisibleTextEditors([{ document: logDocument } as vscode.TextEditor]);

		const provider = new InlineEditProvider(
			{} as DocumentTracker,
			{} as JumpEditManager,
			{} as ApiClient,
		) as unknown as {
			buildVisibleEditorBuffers: (currentUri: string) => AutocompleteResult[];
		};

		expect(
			provider.buildVisibleEditorBuffers("file:///project/test.cpp"),
		).toEqual([]);
	});
});

describe("splitDisjointLineEdits", () => {
	test("splits separated replacement hunks without including unchanged lines", () => {
		const original = "before\nfirst\nunchanged\nsecond\nafter";
		const result: AutocompleteResult = {
			id: "suggestion",
			startIndex: 0,
			endIndex: original.length,
			completion: "before\nFIRST\nunchanged\nSECOND\nafter",
			confidence: 0.8,
			finishReason: "stop",
		};

		expect(splitDisjointLineEdits(original, result)).toEqual([
			{
				...result,
				id: "suggestion:part1",
				startIndex: 7,
				endIndex: 12,
				completion: "FIRST",
			},
			{
				...result,
				id: "suggestion:part2",
				startIndex: 23,
				endIndex: 29,
				completion: "SECOND",
			},
		]);
	});

	test("splits a final insertion after a separate replacement", () => {
		const original = "first\nunchanged\nlast";
		const result: AutocompleteResult = {
			id: "suggestion",
			startIndex: 0,
			endIndex: original.length,
			completion: "FIRST\nunchanged\nlast\nSECOND",
			confidence: 0.8,
			finishReason: "stop",
		};

		expect(splitDisjointLineEdits(original, result)).toEqual([
			{
				...result,
				id: "suggestion:part1",
				startIndex: 0,
				endIndex: 5,
				completion: "FIRST",
			},
			{
				...result,
				id: "suggestion:part2",
				startIndex: original.length,
				endIndex: original.length,
				completion: "\nSECOND",
			},
		]);
	});

	test("preserves an omitted tail after the final replacement hunk", () => {
		const original = "first\nunchanged\nsecond\nunchanged tail\nlast tail";
		const result: AutocompleteResult = {
			id: "suggestion",
			startIndex: 0,
			endIndex: original.length,
			completion: "FIRST\nunchanged\nSECOND",
			confidence: 0.8,
			finishReason: "stop",
		};

		expect(splitDisjointLineEdits(original, result)).toEqual([
			{
				...result,
				id: "suggestion:part1",
				startIndex: 0,
				endIndex: 5,
				completion: "FIRST",
			},
			{
				...result,
				id: "suggestion:part2",
				startIndex: 16,
				endIndex: 22,
				completion: "SECOND",
			},
		]);
	});

	test("keeps insertion and deletion hunks together for safe newline handling", () => {
		const result: AutocompleteResult = {
			id: "suggestion",
			startIndex: 0,
			endIndex: "one\ntwo\nthree".length,
			completion: "ONE\ninserted\ntwo\nTHREE",
			confidence: 0.8,
			finishReason: "stop",
		};
		expect(splitDisjointLineEdits("one\ntwo\nthree", result)).toEqual([result]);
	});
});

describe("InlineEditProvider normalizeInlineResult", () => {
	test("trimming an unchanged prefix preserves the replacement tail", () => {
		const text = "foo(oldCode);";
		const document = makeOneLineDocument(text);
		const cursorOffset = "foo(old".length;
		const normalized = normalizeResult(
			document,
			new vscode.Position(0, cursorOffset),
			{
				id: "replacement-crosses-cursor",
				startIndex: "foo(".length,
				endIndex: "foo(oldCode".length,
				completion: "oldNewCode",
				confidence: 0.8,
			},
		);

		expect(normalized).not.toBeNull();
		if (!normalized) return;
		expect(normalized.startIndex).toBe(cursorOffset);
		expect(normalized.endIndex).toBe("foo(oldCode".length);
		expect(normalized.completion).toBe("NewCode");
		const accepted =
			text.slice(0, normalized.startIndex) +
			normalized.completion +
			text.slice(normalized.endIndex);
		expect(accepted).toBe("foo(oldNewCode);");
		expect(accepted).not.toContain("NewCodeCode");
	});

	test("preserves an empty completion when it deletes a non-empty range", () => {
		setMockConfiguration({
			useCopilotStyleNextEditPresentation: true,
		});
		const text = "keep obsolete";
		const document = makeOneLineDocument(text);
		const startIndex = "keep ".length;
		const normalized = normalizeResult(
			document,
			new vscode.Position(0, startIndex),
			{
				id: "pure-deletion",
				startIndex,
				endIndex: text.length,
				completion: "",
				confidence: 0.8,
			},
		);

		expect(normalized).not.toBeNull();
		if (!normalized) return;
		expect(normalized.completion).toBe("");
		expect(normalized.endIndex).toBe(text.length);
		const accepted =
			text.slice(0, normalized.startIndex) +
			normalized.completion +
			text.slice(normalized.endIndex);
		expect(accepted).toBe("keep ");

		const item = buildItem(
			document,
			new vscode.Position(0, startIndex),
			normalized,
			{ useProposedInlineEditPresentation: true },
		) as vscode.InlineCompletionItem & { isInlineEdit?: boolean };
		expect(item?.isInlineEdit).toBe(true);
		expect(applyOneLineItem(text, item)).toBe("keep ");
	});
});

describe("InlineEditProvider strict stale-response rejection", () => {
	test("accepts only an unchanged document version, content, and cursor", () => {
		const position = new vscode.Position(0, 3);
		const document = makeOneLineDocument("abc", 7);

		expect(requestIsStale(document, position)).toBe(false);
		expect(requestIsStale(document, position, { version: 6 })).toBe(true);
		expect(requestIsStale(document, position, { content: "ab" })).toBe(true);
		expect(
			requestIsStale(document, position, {
				position: new vscode.Position(0, 2),
			}),
		).toBe(true);
	});
});

describe("inlineEditMatchesSelectedCompletion", () => {
	test("allows inline edits that use the selected completion range and extend its text", () => {
		const text = "console.";
		const document = makeOneLineDocument(text);
		const range = new vscode.Range(
			new vscode.Position(0, "console".length),
			new vscode.Position(0, text.length),
		);

		const matches = inlineEditMatchesSelectedCompletion(
			document,
			{
				id: "extends-selected",
				startIndex: "console".length,
				endIndex: text.length,
				completion: ".log()",
				confidence: 0.8,
			},
			{ range, text: ".log" },
		);

		expect(matches).toBe(true);
	});

	test("rejects inline edits that use a different range than the selected completion", () => {
		const text = "console.";
		const document = makeOneLineDocument(text);
		const selectedRange = new vscode.Range(
			new vscode.Position(0, "console".length),
			new vscode.Position(0, text.length),
		);

		const matches = inlineEditMatchesSelectedCompletion(
			document,
			{
				id: "different-range",
				startIndex: 0,
				endIndex: text.length,
				completion: "console.log()",
				confidence: 0.8,
			},
			{ range: selectedRange, text: ".log" },
		);

		expect(matches).toBe(false);
	});

	test("rejects inline edits that do not extend the selected completion text", () => {
		const text = "import ";
		const document = makeOneLineDocument(text);
		const range = new vscode.Range(
			new vscode.Position(0, text.length),
			new vscode.Position(0, text.length),
		);

		const matches = inlineEditMatchesSelectedCompletion(
			document,
			{
				id: "does-not-extend",
				startIndex: text.length,
				endIndex: text.length,
				completion: '"./thing";',
				confidence: 0.8,
			},
			{ range, text: "Button" },
		);

		expect(matches).toBe(false);
	});
});
