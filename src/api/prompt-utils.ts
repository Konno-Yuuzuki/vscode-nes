/**
 * Shared utility functions extracted from Sweep model files.
 * Used by both zeta2 prompt and completion builders.
 */

export function splitLines(text: string): string[] {
	return text.split("\n");
}

export function computeLineByteOffsets(lines: string[]): number[] {
	const offsets = new Array<number>(lines.length + 1);
	offsets[0] = 0;
	let off = 0;
	for (let i = 0; i < lines.length; i++) {
		const lineStr = lines[i] ?? "";
		off += Buffer.byteLength(lineStr, "utf8") + 1; // +1 for '\n'
		offsets[i + 1] = off;
	}
	return offsets;
}

export function locateCursor(
	lineOffsets: number[],
	cursorByte: number,
): { line: number; col: number } {
	if (cursorByte <= 0) return { line: 0, col: 0 };
	for (let i = 0; i < lineOffsets.length - 1; i++) {
		const start = lineOffsets[i] ?? 0;
		const next = lineOffsets[i + 1] ?? start;
		if (cursorByte < next) {
			return { line: i, col: cursorByte - start };
		}
	}
	const last = Math.max(0, lineOffsets.length - 2);
	const start = lineOffsets[last] ?? 0;
	return { line: last, col: cursorByte - start };
}

export function renderDiagnosticsAsComments(
	diagnostics: Array<{ message: string; line: number }>,
	commentPrefix: string,
	marker: string,
	offsetLine: number,
): string {
	if (!diagnostics || diagnostics.length === 0) return "";
	const lines: string[] = [];
	lines.push(commentPrefix + " " + marker);
	for (const d of diagnostics) {
		const line = d.line + offsetLine + 1;
		lines.push(commentPrefix + " [error] line " + line + ":1: " + d.message);
	}
	return lines.join("\n");
}

export function normalizeDiagnosticMessage(msg: string): string {
	return msg.replace(/\s+/g, " ").trim();
}

export function stripInjectedFixmesFromLines(
	lines: string[],
	injectedFixmeMessages: string[] | undefined,
	commentPrefix: string | undefined,
	inlineDiagnosticsMarker: string | undefined,
): void {
	if (!injectedFixmeMessages || injectedFixmeMessages.length === 0) return;
	if (!commentPrefix || !inlineDiagnosticsMarker) return;
	const marker = commentPrefix + " " + inlineDiagnosticsMarker;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const idx = line.indexOf(marker);
		if (idx < 0) continue;
		let cut = idx;
		while (cut > 0 && (line[cut - 1] === " " || line[cut - 1] === "\t")) {
			cut--;
		}
		lines[i] = line.slice(0, cut);
	}
}