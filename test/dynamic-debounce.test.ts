import { describe, expect, test } from "bun:test";

import {
	DynamicDebounceTracker,
	clampDebounce,
} from "~/editor/dynamic-debounce.ts";

describe("clampDebounce", () => {
	test("clamps to [100, 600]", () => {
		expect(clampDebounce(0)).toBe(100);
		expect(clampDebounce(-5)).toBe(100);
		expect(clampDebounce(50)).toBe(100);
		expect(clampDebounce(100)).toBe(100);
		expect(clampDebounce(300)).toBe(300);
		expect(clampDebounce(600)).toBe(600);
		expect(clampDebounce(900)).toBe(600);
	});
});

describe("DynamicDebounceTracker", () => {
	test("returns base debounce before enough data", () => {
		const tracker = new DynamicDebounceTracker();
		tracker.recordInvocation(0);
		// Only one sample — no intervals yet
		expect(tracker.computeDebounceMs(300)).toBe(300);
		expect(tracker.medianInterval()).toBeNull();
	});

	test("fast typing (median ≤ 100ms) uses longer debounce", () => {
		const tracker = new DynamicDebounceTracker();
		tracker.recordInvocation(0);
		tracker.recordInvocation(80); // 80ms interval
		tracker.recordInvocation(180); // 100ms interval
		tracker.recordInvocation(260); // 80ms interval

		// Median of [80, 100, 80] = 80 ≤ 100 → multiplier 1.7
		const debounce = tracker.computeDebounceMs(300);
		expect(debounce).toBe(Math.round(300 * 1.7)); // 510
		expect(debounce).toBeGreaterThan(300);
	});

	test("slow typing (median ≥ 600ms) uses shorter debounce", () => {
		const tracker = new DynamicDebounceTracker();
		tracker.recordInvocation(0);
		tracker.recordInvocation(700); // 700ms
		tracker.recordInvocation(1400); // 700ms
		tracker.recordInvocation(2200); // 800ms

		// Median of [700, 700, 800] = 700 ≥ 600 → multiplier 0.5
		const debounce = tracker.computeDebounceMs(300);
		expect(debounce).toBe(Math.round(300 * 0.5)); // 150
		expect(debounce).toBeLessThan(300);
	});

	test("medium typing interpolates between extremes", () => {
		const tracker = new DynamicDebounceTracker();
		// Intervals of 350ms → median 350
		tracker.recordInvocation(0);
		tracker.recordInvocation(350);
		tracker.recordInvocation(700);
		tracker.recordInvocation(1050);

		expect(tracker.medianInterval()).toBe(350);
		// t = (350-100)/(600-100) = 0.5 → multiplier 1.7 - 0.5*1.2 = 1.1
		const debounce = tracker.computeDebounceMs(300);
		expect(debounce).toBe(Math.round(300 * 1.1)); // 330
	});

	test("multiplier never exceeds clamps", () => {
		const tracker = new DynamicDebounceTracker();
		// Extreme burst: 1ms intervals
		tracker.recordInvocation(0);
		tracker.recordInvocation(1);
		tracker.recordInvocation(2);
		tracker.recordInvocation(3);
		tracker.recordInvocation(4);

		const debounce = tracker.computeDebounceMs(1000); // even huge base
		expect(debounce).toBeLessThanOrEqual(600);
		expect(debounce).toBeGreaterThanOrEqual(100);
	});

	test("ignores non-positive intervals (clock rewinds)", () => {
		const tracker = new DynamicDebounceTracker();
		tracker.recordInvocation(1000);
		tracker.recordInvocation(500); // rewind → ignored, lastTimestamp stays 1000
		tracker.recordInvocation(1500); // interval = 1500-1000 = 500

		expect(tracker.medianInterval()).toBe(500);
	});

	test("window size caps retained intervals", () => {
		const tracker = new DynamicDebounceTracker(3); // keep last 3
		tracker.recordInvocation(0);
		tracker.recordInvocation(100);
		tracker.recordInvocation(200);
		tracker.recordInvocation(300);
		tracker.recordInvocation(400);

		// Intervals: 100,100,100,100 — window keeps last 3 → [100,100,100]
		expect(tracker.medianInterval()).toBe(100);
	});

	test("reset clears history", () => {
		const tracker = new DynamicDebounceTracker();
		tracker.recordInvocation(0);
		tracker.recordInvocation(100);
		tracker.recordInvocation(200);
		expect(tracker.medianInterval()).toBe(100);

		tracker.reset();
		expect(tracker.medianInterval()).toBeNull();
		expect(tracker.computeDebounceMs(300)).toBe(300);
	});

	test("big base with idle typing stays within clamps", () => {
		const tracker = new DynamicDebounceTracker();
		tracker.recordInvocation(0);
		tracker.recordInvocation(5000);
		tracker.recordInvocation(10000);

		const debounce = tracker.computeDebounceMs(300);
		expect(debounce).toBe(150); // 300 * 0.5
	});
});