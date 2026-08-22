import { describe, expect, test } from "bun:test";

import {
	type DocumentSymbolLike,
	formatSymbolOutline,
	type SymbolInformationLike,
} from "~/api/symbol-outline.ts";

function range(startLine: number, endLine: number) {
	return {
		start: { line: startLine },
		end: { line: endLine },
	};
}

describe("formatSymbolOutline", () => {
	test("emits the active class/function path and nearby callables", () => {
		const symbols: DocumentSymbolLike[] = [
			{
				name: "CTextDraw",
				kind: 4,
				range: range(10, 90),
				children: [
					{
						name: "LoadTexture",
						detail: "void LoadTexture()",
						kind: 5,
						range: range(15, 25),
					},
					{
						name: "Draw",
						detail: "void Draw()",
						kind: 5,
						range: range(30, 55),
					},
					{
						name: "Update",
						detail: "void Update(bool selectionEnabled)",
						kind: 5,
						range: range(65, 80),
					},
				],
			},
		];

		const outline = formatSymbolOutline(symbols, 42, 3);

		expect(outline).toContain("active_symbol: CTextDraw::Draw");
		expect(outline).toContain(
			"- line 16: CTextDraw::LoadTexture — void LoadTexture()",
		);
		expect(outline).toContain(
			"- line 31: CTextDraw::Draw — void Draw() [active]",
		);
	});

	test("selects only the nearest functions and restores source order", () => {
		const symbols: DocumentSymbolLike[] = Array.from(
			{ length: 10 },
			(_, index) => ({
				name: `fn${index}`,
				kind: 11,
				range: range(index * 10, index * 10 + 5),
			}),
		);

		const outline = formatSymbolOutline(symbols, 42, 4);

		expect(outline).toContain("active_symbol: fn4");
		expect(outline).toContain("fn2");
		expect(outline).toContain("fn3");
		expect(outline).toContain("fn4");
		expect(outline).toContain("fn5");
		expect(outline).not.toContain("fn1");
		const nearby = outline.slice(outline.indexOf("nearby_symbols:"));
		expect(nearby.indexOf("fn2")).toBeLessThan(nearby.indexOf("fn3"));
		expect(nearby.indexOf("fn3")).toBeLessThan(nearby.indexOf("fn4"));
		expect(nearby.indexOf("fn4")).toBeLessThan(nearby.indexOf("fn5"));
	});

	test("includes nearby non-callable symbols within the configured budget", () => {
		const symbols: DocumentSymbolLike[] = [
			{
				name: "CVehicleModelInfo",
				kind: 4,
				range: range(10, 200),
				children: [
					{
						name: "wheelCount",
						kind: 7,
						range: range(30, 30),
					},
					{
						name: "MAX_WHEELS",
						kind: 21,
						range: range(40, 40),
					},
				],
			},
		];

		const outline = formatSymbolOutline(symbols, 35, 32);
		expect(outline).toContain("nearby_symbols:");
		expect(outline).toContain("CVehicleModelInfo::wheelCount");
		expect(outline).toContain("CVehicleModelInfo::MAX_WHEELS");
	});

	test("supports flat SymbolInformation providers", () => {
		const symbols: SymbolInformationLike[] = [
			{
				name: "render",
				containerName: "Renderer",
				kind: 5,
				location: { range: range(100, 140) },
			},
		];

		const outline = formatSymbolOutline(symbols, 120, 8);

		expect(outline).toBe(
			[
				"active_symbol: Renderer::render",
				"nearby_symbols:",
				"- line 101: Renderer::render [active]",
			].join("\n"),
		);
	});
});
