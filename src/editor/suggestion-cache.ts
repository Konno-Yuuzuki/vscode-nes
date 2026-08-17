import type { AutocompleteResult } from "~/api/schemas.ts";

/**
 * SuggestionCache — caches the last inline-completion suggestion per URI
 * so that it can be re-shown when the cursor moves back within a threshold
 * of the original request line, without triggering a new model request.
 *
 * This mirrors Copilot NES's behaviour: move cursor away → hide suggestion;
 * move cursor back (same content, same area) → re-show instantly.
 *
 * The cache is invalidated on:
 *  - Document content change (contentHash differs)
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
}

export interface SuggestionCacheOptions {
	/** Max lines the cursor may move away and still be eligible for re-show */
	cursorThreshold: number;
	/** Max age (ms) before a cached entry is considered expired */
	cacheTtlMs: number;
	/** Max entries in the cache (LRU-like, oldest evicted) */
	maxEntries: number;
}

const DEFAULT_OPTIONS: SuggestionCacheOptions = {
	cursorThreshold: 3,
	cacheTtlMs: 15_000,
	maxEntries: 5,
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
		});
	}

	/**
	 * Retrieve a cached suggestion if one exists and is valid for the
	 * given cursor position and content. Returns null if:
	 *  - No entry for the URI
	 *  - Cursor moved beyond ±cursorThreshold lines from the request line
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

		// Cursor moved beyond threshold?
		const lineDiff = Math.abs(currentCursorLine - entry.requestLine);
		if (lineDiff > this.options.cursorThreshold) {
			return null;
		}

		return entry.suggestions;
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