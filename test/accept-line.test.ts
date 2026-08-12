import { afterEach, describe, expect, mock, test } from "bun:test";
import * as vscode from "vscode";
import { logger } from "~/core/logger.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";

// Capture logger calls
const capturedLogs: string[] = [];
mock.restore(logger, "info");
mock(logger, "info", (...args: unknown[]) => {
	capturedLogs.push(args.join(" "));
});

afterEach(() => {
	capturedLogs.length = 0;
	(
		vscode.window as unknown as { activeTextEditor?: unknown }
	).activeTextEditor = undefined;
});

describe("JumpEditManager line-accept", () => {
	test("acceptJumpEditLine accepts only the first changed line", async () => {
		const document = {
			uri: { toString: () => "file:///test.ts" },
			version: 1,
			lineCount: 4,
			languageId: "typescript",
			getText: () => "line0\nline1\nline2\nline3\n",
			offsetAt: (pos: vscode.Position) => {
				let offset = 0;
				for (let i = 0; i < pos.line; i++) offset += 6;
				return offset + pos.character;
			},
			positionAt: (offset: number) => {
				const line = Math.floor(offset / 6);
				return new vscode.Position(line, offset % 6);
			},
			lineAt: (line: number) => {
				const lines = ["line0", "line1", "line2", "line3"];
				return {
					text: lines[line] ?? "",
					range: new vscode.Range(
						new vscode.Position(line, 0),
						new vscode.Position(line, (lines[line] ?? "").length),
					),
				};
			},
		};

		let appliedEdit: { range: vscode.Range; text: string } | null = null;
		const editor = {
			document,
			options: { tabSize: 4 },
			selection: { active: new vscode.Position(3, 0) },
			setDecorations: mock(() => {}),
			edit: mock(
				(
					callback: (editBuilder: {
						replace: (range: vscode.Range, text: string) => void;
					}) => void,
					_options?: unknown,
				) => {
					const editBuilder = {
						replace: (range: vscode.Range, text: string) => {
							appliedEdit = { range, text };
						},
					};
					callback(editBuilder);
					return Promise.resolve(true);
				},
			),
			revealRange: mock(() => {}),
		};
		(
			vscode.window as unknown as { activeTextEditor?: unknown }
		).activeTextEditor = editor;

		const manager = new JumpEditManager();
		manager.setPendingJumpEdit(document, {
			id: "multi-line",
			startIndex: 0,
			endIndex: "line0\nline1\n".length,
			completion: "new0\nnew1\n",
			confidence: 0.8,
		});

		// Accept first line
		await manager.acceptJumpEditLine();
		expect(appliedEdit).not.toBeNull();
		expect(appliedEdit?.text).toBe("new0");

		manager.dispose();
	});

	test("acceptJumpEdit (all) applies entire completion", async () => {
		const document = {
			uri: { toString: () => "file:///test.ts" },
			version: 1,
			lineCount: 4,
			languageId: "typescript",
			getText: () => "line0\nline1\nline2\nline3\n",
			offsetAt: (pos: vscode.Position) => {
				let offset = 0;
				for (let i = 0; i < pos.line; i++) offset += 6;
				return offset + pos.character;
			},
			positionAt: (offset: number) => {
				const line = Math.floor(offset / 6);
				return new vscode.Position(line, offset % 6);
			},
			lineAt: (line: number) => {
				const lines = ["line0", "line1", "line2", "line3"];
				return {
					text: lines[line] ?? "",
					range: new vscode.Range(
						new vscode.Position(line, 0),
						new vscode.Position(line, (lines[line] ?? "").length),
					),
				};
			},
		};

		let appliedEdit: { range: vscode.Range; text: string } | null = null;
		const editor = {
			document,
			options: { tabSize: 4 },
			selection: { active: new vscode.Position(3, 0) },
			setDecorations: mock(() => {}),
			edit: mock(
				(
					callback: (editBuilder: {
						replace: (range: vscode.Range, text: string) => void;
					}) => void,
				) => {
					const editBuilder = {
						replace: (range: vscode.Range, text: string) => {
							appliedEdit = { range, text };
						},
					};
					callback(editBuilder);
					return Promise.resolve(true);
				},
			),
			revealRange: mock(() => {}),
		};
		(
			vscode.window as unknown as { activeTextEditor?: unknown }
		).activeTextEditor = editor;

		const manager = new JumpEditManager();
		manager.setPendingJumpEdit(document, {
			id: "multi-line",
			startIndex: 0,
			endIndex: "line0\nline1\n".length,
			completion: "new0\nnew1\n",
			confidence: 0.8,
		});

		await manager.acceptJumpEdit(); // accept all
		expect(appliedEdit).not.toBeNull();
		expect(appliedEdit?.text).toBe("new0\nnew1\n");

		manager.dispose();
	});
});
