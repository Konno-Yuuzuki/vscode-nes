/**
 * Syntax-window inference — a zero-dependency heuristic that finds the
 * enclosing syntax block (function/class/braced block) around the cursor,
 * mirroring Zed's `expand_context_syntactically_then_linewise` (which uses
 * tree-sitter). VS Code's extension host has no parser, so we approximate
 * with bracket-depth tracking per line (skipping string/comment contents).
 *
 * The heuristic:
 *   1. Compute each line's depth *at the start of the line* (bracket depth,
 *      ignoring brackets inside strings and comments).
 *   2. The cursor line's start-depth D defines its "level".
 *   3. The enclosing block is the maximal contiguous run of lines whose
 *      start-depth >= D that contains the cursor line — bounded above/below
 *      by the first line with start-depth < D.
 *
 * This is intentionally conservative: when it can't find a block (e.g. the
 * cursor sits at top level), it returns null and the caller falls back to
 * plain line-wise expansion.
 */

/**
 * Bracket-depth change contributed by `line`, ignoring brackets inside
 * `"..."`, `'...'`, `` `...` ``, `//` and `/* ... *​/` comments.
 */
export function netBracketChange(line: string): number {
	let delta = 0;
	let i = 0;
	let inString: string | null = null;
	let inLineComment = false;
	let inBlockComment = false;

	while (i < line.length) {
		const ch = line[i]!;
		const next = line[i + 1];

		if (inLineComment) break;

		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		if (inString) {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === inString) inString = null;
			i++;
			continue;
		}

		if (ch === "/" && next === "/") {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i += 2;
			continue;
		}

		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			i++;
			continue;
		}

		if (ch === "{" || ch === "[" || ch === "(") delta++;
		else if (ch === "}" || ch === "]" || ch === ")") delta--;

		i++;
	}

	return delta;
}

/**
 * Depth of every line *at the start of that line* (before its own brackets
 * are applied). The first line has depth 0.
 */
export function computeLineDepths(lines: string[]): number[] {
	const depths: number[] = new Array(lines.length);
	let depth = 0;
	for (let i = 0; i < lines.length; i++) {
		depths[i] = depth;
		depth += netBracketChange(lines[i] ?? "");
	}
	return depths;
}

export interface SyntaxBlock {
	/** First line of the block (inclusive) */
	start: number;
	/** One past the last line of the block (exclusive) */
	end: number;
}

/**
 * Find the enclosing syntax block around `cursorLine`, or null when the
 * cursor is at top level / no block can be inferred.
 */
export function inferSyntaxBlock(
	lines: string[],
	cursorLine: number,
): SyntaxBlock | null {
	if (lines.length === 0) return null;

	const boundedCursor = Math.min(Math.max(0, cursorLine), lines.length - 1);
	const depths = computeLineDepths(lines);
	const cursorDepth = depths[boundedCursor] ?? 0;

	// Top level (depth 0) or negative depth (unbalanced file) → no block.
	if (cursorDepth <= 0) return null;

	let start = boundedCursor;
	// Expand upward: keep lines whose start-depth is >= the cursor's, and
	// also include block-opening lines (e.g. `function foo() {`) whose
	// start-depth dipped below the cursor but which open the enclosing
	// block — otherwise the function signature line gets excluded.
	while (start > 0) {
		const prevDepth = depths[start - 1] ?? 0;
		if (prevDepth >= cursorDepth) {
			start--;
		} else if (netBracketChange(lines[start - 1] ?? "") > 0) {
			// Include the nearest block-opening line (e.g. `if (x) {`)
			// then stop — do not keep climbing past outer blocks.
			start--;
			break;
		} else {
			break;
		}
	}

	let end = boundedCursor + 1;
	while (end < lines.length && (depths[end] ?? 0) >= cursorDepth) end++;

	// A block must contain at least the cursor line plus something else;
	// a single isolated line is not a meaningful block to expand to.
	if (end <= start + 1) return null;

	return { start, end };
}

/**
 * Byte size of the given line range (with trailing-newline accounting that
 * matches the prompt builder's `linePromptByteLength`).
 */
export function syntaxBlockByteLength(
	lines: string[],
	block: SyntaxBlock,
): number {
	let bytes = 0;
	for (let i = block.start; i < block.end && i < lines.length; i++) {
		const line = lines[i] ?? "";
		bytes += Buffer.byteLength(line, "utf8") + (i < lines.length - 1 ? 1 : 0);
	}
	return bytes;
}