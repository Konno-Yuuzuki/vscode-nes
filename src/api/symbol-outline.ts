// Pure Document Symbols selection/formatting. The input deliberately uses a
// structural subset of VS Code's DocumentSymbol / SymbolInformation types so
// the hot-path adapter stays small and the ranking can be unit-tested without
// an Extension Host.

interface PositionLike {
	line: number;
}

interface RangeLike {
	start: PositionLike;
	end: PositionLike;
}

export interface DocumentSymbolLike {
	name: string;
	detail?: string;
	kind: number;
	range: RangeLike;
	children?: readonly DocumentSymbolLike[];
}

export interface SymbolInformationLike {
	name: string;
	containerName?: string;
	kind: number;
	location: {
		range: RangeLike;
	};
}

export type OutlineSymbolLike = DocumentSymbolLike | SymbolInformationLike;

interface CallableEntry {
	path: string;
	detail: string;
	startLine: number;
	endLine: number;
}

interface ActiveEntry {
	path: string;
	depth: number;
	span: number;
}

// Numeric values are stable parts of vscode.SymbolKind. Keeping them local
// avoids a runtime vscode import in this pure helper.
const SYMBOL_KIND = {
	module: 1,
	namespace: 2,
	package: 3,
	class: 4,
	method: 5,
	constructor: 8,
	enum: 9,
	interface: 10,
	function: 11,
	struct: 22,
	operator: 24,
} as const;

const CALLABLE_KINDS = new Set<number>([
	SYMBOL_KIND.method,
	SYMBOL_KIND.constructor,
	SYMBOL_KIND.function,
	SYMBOL_KIND.operator,
]);

const PATH_KINDS = new Set<number>([
	SYMBOL_KIND.module,
	SYMBOL_KIND.namespace,
	SYMBOL_KIND.package,
	SYMBOL_KIND.class,
	SYMBOL_KIND.method,
	SYMBOL_KIND.constructor,
	SYMBOL_KIND.enum,
	SYMBOL_KIND.interface,
	SYMBOL_KIND.function,
	SYMBOL_KIND.struct,
	SYMBOL_KIND.operator,
]);

export function formatSymbolOutline(
	symbols: readonly OutlineSymbolLike[],
	cursorLine0: number,
	maxSymbols: number,
): string {
	const limit = Math.max(0, Math.floor(maxSymbols));
	if (limit === 0 || symbols.length === 0) return "";

	const callables: CallableEntry[] = [];
	let active: ActiveEntry | null = null;

	const considerActive = (
		path: string,
		range: RangeLike,
		depth: number,
	): void => {
		if (!rangeContainsLine(range, cursorLine0)) return;
		const span = Math.max(0, range.end.line - range.start.line);
		if (
			active === null ||
			depth > active.depth ||
			(depth === active.depth && span < active.span)
		) {
			active = { path, depth, span };
		}
	};

	const visitDocumentSymbol = (
		symbol: DocumentSymbolLike,
		parents: readonly string[],
	): void => {
		const name = cleanInlineText(symbol.name, 120);
		const extendsPath = PATH_KINDS.has(symbol.kind) && name !== "";
		const pathParts = extendsPath ? [...parents, name] : [...parents];
		const path = pathParts.join("::");

		if (extendsPath) {
			considerActive(path, symbol.range, pathParts.length);
		}
		if (CALLABLE_KINDS.has(symbol.kind) && path !== "") {
			callables.push({
				path,
				detail: cleanInlineText(symbol.detail ?? "", 160),
				startLine: symbol.range.start.line,
				endLine: symbol.range.end.line,
			});
		}

		for (const child of symbol.children ?? []) {
			visitDocumentSymbol(child, pathParts);
		}
	};

	for (const symbol of symbols) {
		if (isSymbolInformation(symbol)) {
			const name = cleanInlineText(symbol.name, 120);
			const container = cleanInlineText(symbol.containerName ?? "", 120);
			const path = [container, name].filter(Boolean).join("::");
			if (PATH_KINDS.has(symbol.kind) && path !== "") {
				considerActive(path, symbol.location.range, container ? 2 : 1);
			}
			if (CALLABLE_KINDS.has(symbol.kind) && path !== "") {
				callables.push({
					path,
					detail: "",
					startLine: symbol.location.range.start.line,
					endLine: symbol.location.range.end.line,
				});
			}
		} else {
			visitDocumentSymbol(symbol, []);
		}
	}

	const selected = callables
		.sort((a, b) => {
			const distance =
				distanceFromRange(a, cursorLine0) - distanceFromRange(b, cursorLine0);
			if (distance !== 0) return distance;
			if (a.startLine !== b.startLine) return a.startLine - b.startLine;
			return a.path.localeCompare(b.path);
		})
		.slice(0, limit)
		.sort((a, b) => {
			if (a.startLine !== b.startLine) return a.startLine - b.startLine;
			return a.path.localeCompare(b.path);
		});

	// Native-preview TypeScript does not currently retain assignments made
	// through the nested traversal callbacks, so make the post-traversal
	// union explicit before narrowing it.
	const resolvedActive = active as ActiveEntry | null;
	if (selected.length === 0 && resolvedActive === null) return "";

	const lines: string[] = [];
	if (resolvedActive !== null) {
		lines.push(`active_symbol: ${resolvedActive.path}`);
	}
	if (selected.length > 0) {
		lines.push("nearby_functions:");
		for (const entry of selected) {
			const detail =
				entry.detail !== "" && !entry.path.includes(entry.detail)
					? ` — ${entry.detail}`
					: "";
			const activeMarker =
				resolvedActive !== null && resolvedActive.path === entry.path
					? " [active]"
					: "";
			lines.push(
				`- line ${entry.startLine + 1}: ${entry.path}${detail}${activeMarker}`,
			);
		}
	}
	return lines.join("\n");
}

function isSymbolInformation(
	symbol: OutlineSymbolLike,
): symbol is SymbolInformationLike {
	return "location" in symbol;
}

function rangeContainsLine(range: RangeLike, line: number): boolean {
	return range.start.line <= line && line <= range.end.line;
}

function distanceFromRange(entry: CallableEntry, line: number): number {
	if (line < entry.startLine) return entry.startLine - line;
	if (line > entry.endLine) return line - entry.endLine;
	return 0;
}

function cleanInlineText(value: string, maxChars: number): string {
	const cleaned = value.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
