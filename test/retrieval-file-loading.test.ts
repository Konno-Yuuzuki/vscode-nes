import { describe, expect, test } from "bun:test";
import type * as vscode from "vscode";

import { ApiClient } from "~/api/client.ts";
import type { FileChunk } from "~/api/schemas.ts";
import type { CompletionServer } from "~/services/completion-server.ts";

interface ApiClientInternals {
	buildChunkFromLocation(location: vscode.Location): Promise<FileChunk | null>;
}

function makeUri(path: string): vscode.Uri {
	return {
		scheme: "file",
		fsPath: path,
		toString: () => `file://${path}`,
	} as vscode.Uri;
}

function makeLocation(uri: vscode.Uri, line: number): vscode.Location {
	return {
		uri,
		range: {
			start: { line, character: 0 },
			end: { line, character: 1 },
		},
	} as vscode.Location;
}

describe("ApiClient retrieval file loading", () => {
	test("reads unopened targets through workspace.fs without creating a TextDocument", async () => {
		const uri = makeUri("/sdk/include/vector");
		const source = Array.from(
			{ length: 30 },
			(_, index) => `line ${index}`,
		).join("\n");
		let fileReads = 0;
		const client = new ApiClient({} as CompletionServer, {
			openDocumentsProvider: () => [],
			retrievalFileLoader: async (requestedUri) => {
				expect(requestedUri.toString()).toBe(uri.toString());
				fileReads++;
				return new TextEncoder().encode(source);
			},
		}) as unknown as ApiClientInternals;

		const chunk = await client.buildChunkFromLocation(makeLocation(uri, 12));

		expect(fileReads).toBe(1);
		expect(chunk?.file_path).toBe("/sdk/include/vector");
		expect(chunk?.start_line).toBe(4);
		expect(chunk?.end_line).toBe(22);
		expect(chunk?.content).toStartWith("line 3\n");
		expect(chunk?.content).toEndWith("\nline 21");
	});

	test("uses an already-open document so unsaved target contents stay visible", async () => {
		const uri = makeUri("/workspace/live.cpp");
		const lines = ["saved", "unsaved edit", "tail"];
		const openDocument = {
			uri,
			lineCount: lines.length,
			lineAt: (line: number) => ({
				range: {
					end: { line, character: lines[line]?.length ?? 0 },
				},
			}),
			getText: (range: vscode.Range) =>
				lines.slice(range.start.line, range.end.line + 1).join("\n"),
		} as unknown as vscode.TextDocument;
		let fileReads = 0;
		const client = new ApiClient({} as CompletionServer, {
			openDocumentsProvider: () => [openDocument],
			retrievalFileLoader: async () => {
				fileReads++;
				return new Uint8Array();
			},
		}) as unknown as ApiClientInternals;

		const chunk = await client.buildChunkFromLocation(makeLocation(uri, 1));

		expect(fileReads).toBe(0);
		expect(chunk?.content).toContain("unsaved edit");
	});
});
