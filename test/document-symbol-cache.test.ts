import { afterEach, describe, expect, test } from "bun:test";
import type * as vscode from "vscode";

import { ApiClient, type ApiClientOptions } from "~/api/client.ts";
import type { OutlineSymbolLike } from "~/api/symbol-outline.ts";
import type { CompletionServer } from "~/services/completion-server.ts";

interface MutableDocument {
	uri: vscode.Uri;
	version: number;
	isDirty: boolean;
}

interface ApiClientInternals {
	getDocumentSymbols(
		document: vscode.TextDocument,
	): readonly OutlineSymbolLike[];
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makeDocument(
	version = 1,
	isDirty = false,
	path = "file:///workspace/demo.cpp",
): MutableDocument {
	return {
		uri: {
			scheme: "file",
			fsPath: path.slice("file://".length),
			toString: () => path,
		} as vscode.Uri,
		version,
		isDirty,
	};
}

function symbol(name: string): vscode.DocumentSymbol {
	return {
		name,
		detail: `void ${name}()`,
		kind: 11,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 2, character: 0 },
		},
		selectionRange: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: name.length },
		},
		children: [],
	} as unknown as vscode.DocumentSymbol;
}

function makeClient(options: ApiClientOptions): {
	client: ApiClient;
	internals: ApiClientInternals;
} {
	const client = new ApiClient({} as CompletionServer, options);
	return {
		client,
		internals: client as unknown as ApiClientInternals,
	};
}

function setOutlineSymbols(value: number): void {
	(
		globalThis as typeof globalThis & {
			__vscodeMockConfiguration?: Record<string, unknown>;
		}
	).__vscodeMockConfiguration = { outlineSymbols: value };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	setOutlineSymbols(0);
});

describe("ApiClient Document Symbols cache", () => {
	test("cold cache never waits for the Document Symbol provider", async () => {
		const pending = deferred<
			vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
		>();
		let calls = 0;
		const { internals } = makeClient({
			documentSymbolLoader: () => {
				calls++;
				return pending.promise;
			},
		});
		const document = makeDocument();

		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument),
		).toEqual([]);
		expect(calls).toBe(1);

		// Repeated completions share the one in-flight request, even if the
		// provider never resolves.
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument),
		).toEqual([]);
		expect(calls).toBe(1);

		pending.resolve([symbol("run")]);
		await flushPromises();
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument),
		).toHaveLength(1);
		expect(calls).toBe(1);
	});

	test("seeds an outline for a document that is already dirty", async () => {
		const { internals } = makeClient({
			documentSymbolLoader: () => Promise.resolve([symbol("dirty")]),
		});
		const document = makeDocument(1, true);

		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument),
		).toEqual([]);
		await flushPromises();
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument)[0]?.name,
		).toBe("dirty");
	});

	test("refreshes the outline for a resolved dirty document version", async () => {
		setOutlineSymbols(8);
		const loads = [[symbol("before")], [symbol("after")]];
		let calls = 0;
		const { internals } = makeClient({
			documentSymbolLoader: () => Promise.resolve(loads[calls++]),
		});
		const document = makeDocument();

		internals.getDocumentSymbols(document as vscode.TextDocument);
		await flushPromises();
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument)[0]?.name,
		).toBe("before");

		document.version = 2;
		document.isDirty = true;
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument)[0]?.name,
		).toBe("before");
		expect(calls).toBe(2);
		await flushPromises();
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument)[0]?.name,
		).toBe("after");
	});

	test("ignores a provider result for an obsolete document version", async () => {
		const first = deferred<
			vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
		>();
		let calls = 0;
		const { internals } = makeClient({
			documentSymbolLoader: () => {
				calls++;
				return calls === 1
					? first.promise
					: Promise.resolve([symbol("current")]);
			},
		});
		const document = makeDocument();

		internals.getDocumentSymbols(document as vscode.TextDocument);
		document.version = 2;
		document.isDirty = true;
		first.resolve([symbol("stale")]);
		await flushPromises();

		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument),
		).toEqual([]);
		expect(calls).toBe(2);
		await flushPromises();
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument)[0]?.name,
		).toBe("current");
	});

	test("a timed-out provider remains single-flight and cannot block callers", async () => {
		let calls = 0;
		const { internals } = makeClient({
			documentSymbolLoader: () => {
				calls++;
				return new Promise(() => {});
			},
			outlineProviderTimeoutMs: 1,
			outlineProviderRetryBackoffMs: 10,
		});
		const document = makeDocument();

		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument),
		).toEqual([]);
		await Bun.sleep(5);
		expect(
			internals.getDocumentSymbols(document as vscode.TextDocument),
		).toEqual([]);
		expect(calls).toBe(1);
	});
});
