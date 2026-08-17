import type { AutocompleteResult } from "~/api/schemas.ts";

/**
 * SuggestionCache — caches the last inline-completion suggestion per URI
 * so that it can be re-shown when the cursor moves back within a threshold
 * of the original request line, without triggering a new model request.
 *
 * This mirrors Copilot NES's behaviour: move cursor away → hide suggestion;
 * move cursor back (same content, same area) → re-show instantly.
 *
 * Two cursor-move-back policies (P3):
 *  - Fixed threshold: cursor within ±`cursorThreshold` lines of the request
 *    line. (Copilot NES style.)
 *  - Edit-range aware: cursor within the edit's start..end line range
 *    expanded by `editRangeMargin`. (Zed invalidation_range style.)
 *
 * The cache is invalidated on:
 *  - Document content change (content differs)
 *  - Suggestion accepted
 *  - Manual trigger (forceTrigger)
 *  - Cache age exceeded (CACHE_TTL_MS)
 */

export interface CachedSuggestion {
	/** The suggestion result(s) to re-show */
	suggestions: AutocompleteResult[];
	/** The line the original request was made at */
	requestLine: number;
	/** Full document content at the time of caching (for comparison) */
	content: string;
	/** Document version at the time of caching */
	documentVersion: number;
	/** Timestamp when the entry was created */
	timestamp: number;
	/** First line of the edit range (P3 C) */
	editStartLine?: number;
	/** One past the last line of the edit range (P3 C) */
	editEndLine?: number;
}

export interface SuggestionCacheOptions {
	/** Max lines the cursor may move away and still be eligible for re-show */
	cursorThreshold: number;
	/** Max age (ms) before a cached entry is considered expired */
	cacheTtlMs: number;
	/** Max entries in the cache (LRU-like, oldest evicted) */
	maxEntries: number;
	/** Lines to add around the edit range when using edit-range matching */
	editRangeMargin: number;
	/** Use edit-range matching instead of the fixed cursor threshold */
	useEditRange: boolean;
}

const DEFAULT_OPTIONS: SuggestionCacheOptions = {
	cursorThreshold: 3,
	cacheTtlMs: 15_000,
	maxEntries: 5,
	editRangeMargin: 3,
	useEditRange: true,
};

export class SuggestionCache {
	private readonly cache = new Map<string, CachedSuggestion>();
	private readonly options: SuggestionCacheOptions;

	constructor(options: Partial<SuggestionCacheOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Store a suggestion in the cache, keyed by URI.
	 * Evicts the oldest entry if the cache exceeds maxEntries.
	 */
	store(
		uri: string,
		suggestions: AutocompleteResult[],
		requestLine: number,
		content: string,
		documentVersion: number,
		editRange: { startLine: number; endLine: number } | undefined = undefined,
	): void {
		// Evict oldest if at capacity
		if (this.cache.size >= this.options.maxEntries) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(uri, {
			suggestions,
			requestLine,
			content,
			documentVersion,
			timestamp: Date.now(),
			...(editRange
				? { editStartLine: editRange.startLine, editEndLine: editRange.endLine }
				: {}),
		});
	}

	/**
	 * Retrieve a cached suggestion if one exists and is valid for the
	 * given cursor position and content. Returns null if:
	 *  - No entry for the URI
	 *  - Cursor moved beyond the threshold (fixed or edit-range)
	 *  - Content changed (document different)
	 *  - Cache entry expired
	 */
	get(
		uri: string,
		currentCursorLine: number,
		content: string,
		documentVersion: number,
	): AutocompleteResult[] | null {
		const entry = this.cache.get(uri);
		if (!entry) return null;

		// Expired?
		if (Date.now() - entry.timestamp > this.options.cacheTtlMs) {
			this.cache.delete(uri);
			return null;
		}

		// Content changed?
		if (entry.content !== content) {
			this.cache.delete(uri);
			return null;
		}

		// Document version rewound? (shouldn't happen, but be safe)
		if (entry.documentVersion !== documentVersion) {
			this.cache.delete(uri);
			return null;
		}

		const inRange = this.cursorInRange(entry, currentCursorLine);
		if (!inRange) return null;

		return entry.suggestions;
	}

	/**
	 * Decide whether the cursor is within the acceptable re-show range.
	 * With edit-range matching (P3 C) the range is the edit's
	 * start..end lines plus a margin; otherwise (P3 A) it's the request
	 * line ± cursorThreshold.
	 */
	private cursorInRange(
		entry: CachedSuggestion,
		currentCursorLine: number,
	): boolean {
		if (this.options.useEditRange && entry.editStartLine !== undefined) {
			const margin = this.options.editRangeMargin;
			const minLine = Math.max(0, entry.editStartLine - margin);
			const maxLine = (entry.editEndLine ?? entry.editStartLine) + margin;
			return currentCursorLine >= minLine && currentCursorLine <= maxLine;
		}

		// Fixed-threshold policy (P3 A default behaviour)
		const lineDiff = Math.abs(currentCursorLine - entry.requestLine);
		return lineDiff <= this.options.cursorThreshold;
	}

	/**
	 * Check whether a cached suggestion exists for the URI without
	 * returning it. Useful for cursor-move-back detection.
	 */
	has(uri: string): boolean {
		return this.cache.has(uri);
	}

	/**
	 * Invalidate the cached entry for a specific URI.
	 */
	invalidate(uri: string): void {
		this.cache.delete(uri);
	}

	/**
	 * Clear all cached entries.
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * Number of entries currently in the cache.
	 */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Get the options (for testing).
	 */
	getOptions(): SuggestionCacheOptions {
		return { ...this.options };
	}
}