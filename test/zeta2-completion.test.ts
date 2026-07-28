import { describe, expect, test } from "bun:test";

import type { CompletionResult } from "~/api/completion-client.ts";
import type {
	EditRegion,
	ModelFormat,
	ModelPrompt,
	PromptLine,
} from "~/api/model-format.ts";
import { computeLineByteOffsets, splitLines } from "~/api/sweep-prompt.ts";
import { buildZeta2Response } from "~/api/zeta2-completion.ts";
import { ZETA2_1_EOS_MARKER } from "~/api/zeta2-prompt.ts";

function makePrompt(
	fileContents: string,
	windowStartLine: number,
	windowEndLine: number,
	format: ModelFormat,
	extraRegions: EditRegion[] = [],
): ModelPrompt {
	const lines = splitLines(fileContents);
	const lineOffsets = computeLineByteOffsets(lines);
	const promptLines: PromptLine[] = lines.map((content, i) => ({
		startByte: lineOffsets[i] ?? 0,
		content,
	}));
	const primary: EditRegion = {
		startLine: windowStartLine,
		endLine: windowEndLine,
		isPrimary: true,
	};
	const regions: EditRegion[] = [primary, ...extraRegions].sort(
		(a, b) => a.startLine - b.startLine,
	);
	return {
		prompt: "",
		prefill: "",
		format,
		stopTokens:
			format === "zeta2.1" ? [ZETA2_1_EOS_MARKER] : [">>>>>>> UPDATED"],
		windowStartLine,
		windowEndLine,
		regions,
		lines: promptLines,
		cursorLineByteOffsets: lineOffsets,
	};
}

function completion(text: string): CompletionResult {
	return { text, finishReason: "stop" };
}

describe("buildZeta2Response — protocol 2.1 marker handling", () => {
	test("strips leading <|marker_1|> and trailing <|marker_2|>", () => {
		// File has a typo on the cursor line; the 2.1 model echoes the
		// open marker, emits the corrected region, then closes.
		const fileContents = ["line0", "psdlog::info();", "line2", ""].join("\n");
		const lineCount = splitLines(fileContents).length;
		const prompt = makePrompt(fileContents, 0, lineCount, "zeta2.1");

		const modelOutput =
			"<|marker_1|>\nline0\nspdlog::info();\nline2\n<|marker_2|>";
		const responses = buildZeta2Response(
			completion(modelOutput),
			prompt,
			"id-21",
		);
		expect(responses).not.toBeNull();
		if (!responses) return;
		expect(responses.length).toBe(1);
		const r = responses[0];
		expect(r).toBeDefined();
		if (!r) return;
		// Should isolate the single changed line.
		const cursorLineStart = "line0\n".length;
		expect(r.start_index).toBe(cursorLineStart);
		expect(r.end_index).toBe(cursorLineStart + "psdlog::info();".length);
		expect(r.completion).toBe("spdlog::info();");
	});

	test("close marker without trailing newline still strips", () => {
		const fileContents = ["a", "b", "c", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
		);
		const modelOutput = "<|marker_1|>\na\nb edited\nc<|marker_2|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses || !responses[0]) return;
		expect(responses[0].completion).toBe("b edited");
	});

	test("rejects malformed output with more than two boundary markers", () => {
		const fileContents = ["line0", "line1", "line2", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
		);
		const modelOutput =
			"<|marker_1|>\nline0\n<|marker_2|>\n<|marker_1|>\nline1 edited\nline2\n<|marker_2|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).toBeNull();
	});

	test("empty markerless output is a no-op, not a whole-window deletion", () => {
		const fileContents = ["keep", "everything", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
		);
		expect(buildZeta2Response(completion(""), prompt, "id")).toBeNull();
		expect(
			buildZeta2Response(completion(ZETA2_1_EOS_MARKER), prompt, "id"),
		).toBeNull();
	});

	test("2.0 still strips >>>>>>> UPDATED and respects NO_EDITS", () => {
		const fileContents = ["a", "b", "c", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2",
		);
		const modelOutput = "a\nb edited\nc\n>>>>>>> UPDATED";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses || !responses[0]) return;
		expect(responses[0].completion).toBe("b edited");

		const noOp = buildZeta2Response(completion("NO_EDITS"), prompt, "id");
		expect(noOp).toBeNull();
	});

	test("multi-region 2.1 maps a later boundary span to its document range", () => {
		// File with two areas to fix: cursor area on lines 1-3, distant
		// diagnostic area on lines 6-7.
		const fileContents = [
			"line0", // 0
			"psdlog::info();", // 1 (primary region: 0-3)
			"line2", // 2
			"line3", // 3
			"line4", // 4
			"line5", // 5 (gap)
			"int x = 28;", // 6 (secondary region: 6-8)
			"line7", // 7
			"line8", // 8
			"",
		].join("\n");
		const prompt = makePrompt(fileContents, 0, 4, "zeta2.1", [
			{ startLine: 6, endLine: 8, isPrimary: false },
		]);

		// marker_3 and marker_4 are the boundaries of the second focused
		// region. The response is one contiguous edit, not "pair 2" in an
		// array of independent edits.
		const modelOutput =
			"<|marker_3|>\nint x = NAMED_CONSTANT;\nline7\n<|marker_4|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses) return;
		expect(responses.length).toBe(1);
		expect(responses[0]?.completion).toBe("int x = NAMED_CONSTANT;");
		expect(responses[0]?.start_index).toBe(fileContents.indexOf("int x = 28;"));
		expect(responses[0]?.end_index).toBe(
			fileContents.indexOf("int x = 28;") + "int x = 28;".length,
		);
		expect(responses[0]?.autocomplete_id).toBe("id");
	});

	test("marker_2 to marker_3 replaces the gap between focused regions", () => {
		const fileContents = [
			"primary0",
			"primary1",
			"gap old",
			"gap keep",
			"secondary0",
			"secondary1",
			"",
		].join("\n");
		const prompt = makePrompt(fileContents, 0, 2, "zeta2.1", [
			{ startLine: 4, endLine: 6, isPrimary: false },
		]);

		const responses = buildZeta2Response(
			completion(
				`<|marker_2|>\ngap new\ngap keep\n<|marker_3|>${ZETA2_1_EOS_MARKER}`,
			),
			prompt,
			"id",
		);
		expect(responses).not.toBeNull();
		if (!responses?.[0]) return;
		expect(responses[0].start_index).toBe(fileContents.indexOf("gap old"));
		expect(responses[0].end_index).toBe(
			fileContents.indexOf("gap old") + "gap old".length,
		);
		expect(responses[0].completion).toBe("gap new");
	});

	test("one boundary marker infers the adjacent closing boundary", () => {
		const fileContents = ["a", "b", "c", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
		);
		// Retain compatibility with legacy OpenAI-compatible server configs
		// that strip a numbered closing boundary as a stop sequence.
		const modelOutput = "<|marker_1|>\na\nb fixed\nc\n";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses || !responses[0]) return;
		expect(responses[0].completion).toBe("b fixed");
	});

	test("a primary marker span remains valid when later boundaries exist", () => {
		const fileContents = [
			"line0",
			"psdlog::info();",
			"line2",
			"line3",
			"line4",
			"line5",
			"int x = 28;",
			"",
		].join("\n");
		const prompt = makePrompt(fileContents, 0, 4, "zeta2.1", [
			{ startLine: 6, endLine: 7, isPrimary: false },
		]);

		// Model only emits a replacement for the primary region.
		const modelOutput =
			"<|marker_1|>\nline0\nspdlog::info();\nline2\nline3\n<|marker_2|>";
		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses) return;
		expect(responses.length).toBe(1);
		expect(responses[0]?.completion).toBe("spdlog::info();");
	});

	test("accepting a cross-boundary rewrite removes all replaced old code", () => {
		const fileContents = [
			"before",
			"oldPrimary();",
			"gap",
			"oldSecondary();",
			"after",
			"",
		].join("\n");
		const prompt = makePrompt(fileContents, 0, 2, "zeta2.1", [
			{ startLine: 3, endLine: 5, isPrimary: false },
		]);
		const modelOutput = [
			"<|marker_1|>",
			"before",
			"newPrimary();",
			"gap",
			"newSecondary();",
			"after",
			"<|marker_4|>",
		].join("\n");

		const responses = buildZeta2Response(completion(modelOutput), prompt, "id");
		expect(responses).not.toBeNull();
		if (!responses?.[0]) return;
		const response = responses[0];
		const accepted =
			fileContents.slice(0, response.start_index) +
			response.completion +
			fileContents.slice(response.end_index);
		expect(accepted).toBe(
			["before", "newPrimary();", "gap", "newSecondary();", "after", ""].join(
				"\n",
			),
		);
		expect(accepted).not.toContain("oldPrimary");
		expect(accepted).not.toContain("oldSecondary");
	});

	test("preserves a marker-span pure deletion as an empty replacement", () => {
		const fileContents = ["before", "obsolete();", "after", ""].join("\n");
		const prompt = makePrompt(
			fileContents,
			0,
			splitLines(fileContents).length,
			"zeta2.1",
		);
		const responses = buildZeta2Response(
			completion("<|marker_1|>\nbefore\nafter\n<|marker_2|>"),
			prompt,
			"id",
		);
		expect(responses).not.toBeNull();
		if (!responses?.[0]) return;
		const response = responses[0];
		expect(response.completion).toBe("");
		expect(response.end_index).toBeGreaterThan(response.start_index);
		const accepted =
			fileContents.slice(0, response.start_index) +
			response.completion +
			fileContents.slice(response.end_index);
		expect(accepted).toBe(["before", "after", ""].join("\n"));
	});
});
