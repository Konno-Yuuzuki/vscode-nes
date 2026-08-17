/**
 * DynamicDebounceTracker — adjusts the inline-completion debounce based on
 * recent typing cadence, mirroring how Copilot NES tightens/loosens its
 * debounce window (log shows "Aggressiveness high: debounce set to 0ms"
 * and later "Debouncing for 1993 ms").
 *
 * Idea: measure the median interval between consecutive provider
 * invocations that passed the content-change check:
 *
 *   - Fast typing (median ≤ 100ms between keystrokes) → LONGER debounce
 *     (multiplier 1.7×) so a burst of edits is batched into one request.
 *   - Slow typing / paused (median ≥ 600ms) → SHORTER debounce
 *     (multiplier 0.5×) so the suggestion appears quickly after the user
 *     pauses.
 *   - Linear interpolation between the two extremes.
 *
 * The result is clamped to [100, 600] ms and rounded to a whole number.
 */

const MEDIAN_MIN_MS = 100; // typing intervals at/below this = burst
const MEDIAN_MAX_MS = 600; // typing intervals at/above this = idle
const FAST_MULTIPLIER = 1.7; // debounce multiplier for bursts
const SLOW_MULTIPLIER = 0.5; // debounce multiplier for idle
const MIN_DEBOUNCE_MS = 100;
const MAX_DEBOUNCE_MS = 600;

export function clampDebounce(value: number): number {
	return Math.max(MIN_DEBOUNCE_MS, Math.min(MAX_DEBOUNCE_MS, value));
}

export class DynamicDebounceTracker {
	/** Rolling window of inter-invocation intervals (ms) */
	private readonly intervals: number[] = [];
	/** Timestamp of the previous invocation, or null before the first */
	private lastTimestamp: number | null = null;
	/** Max number of intervals to retain (last N) */
	private readonly windowSize: number;

	constructor(windowSize = 8) {
		this.windowSize = windowSize;
	}

	/**
	 * Record an invocation at `now`. Call this once per provider entry
	 * that passes the content-change check (i.e. a real typing event).
	 * If `now` is before the previous timestamp (clock rewind), the
	 * invocation is ignored entirely so the baseline stays valid.
	 */
	recordInvocation(now: number): void {
		if (this.lastTimestamp !== null) {
			if (now < this.lastTimestamp) return; // clock rewind — ignore
			const interval = now - this.lastTimestamp;
			this.intervals.push(interval);
			if (this.intervals.length > this.windowSize) {
				this.intervals.shift();
			}
		}
		this.lastTimestamp = now;
	}

	/** Median interval of the retained window, or null when < 2 samples */
	medianInterval(): number | null {
		if (this.intervals.length === 0) return null;
		const sorted = [...this.intervals].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] ?? null;
	}

	/**
	 * Compute the debounce delay for the current cadence.
	 * Returns `baseMs` when there is not enough data yet.
	 */
	computeDebounceMs(baseMs: number): number {
		const median = this.medianInterval();
		if (median === null) return baseMs;

		let multiplier: number;
		if (median <= MEDIAN_MIN_MS) {
			multiplier = FAST_MULTIPLIER;
		} else if (median >= MEDIAN_MAX_MS) {
			multiplier = SLOW_MULTIPLIER;
		} else {
			const t = (median - MEDIAN_MIN_MS) / (MEDIAN_MAX_MS - MEDIAN_MIN_MS);
			multiplier = FAST_MULTIPLIER - t * (FAST_MULTIPLIER - SLOW_MULTIPLIER);
		}
		return clampDebounce(Math.round(baseMs * multiplier));
	}

	/** Reset all tracked history (e.g. on config change) */
	reset(): void {
		this.intervals.length = 0;
		this.lastTimestamp = null;
	}
}