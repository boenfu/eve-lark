import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DedupMap } from "../src/dedup.js";

describe("DedupMap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for an unseen key", () => {
    const m = new DedupMap(60_000, 100);
    expect(m.has("a")).toBe(false);
  });

  it("records and detects a key within the TTL window", () => {
    const m = new DedupMap(60_000, 100);
    m.set("a");
    expect(m.has("a")).toBe(true);
  });

  it("re-Setting an already-seen key refreshes its timestamp", () => {
    const m = new DedupMap(1_000, 100);
    m.set("a");
    vi.advanceTimersByTime(900);
    m.set("a"); // refresh
    vi.advanceTimersByTime(900);
    expect(m.has("a")).toBe(true); // would have expired at 1000ms without refresh
  });

  it("expires a key after the TTL window", () => {
    const m = new DedupMap(1_000, 100);
    m.set("a");
    vi.advanceTimersByTime(1001);
    expect(m.has("a")).toBe(false);
  });

  it("evicts the oldest entry when cap is reached (FIFO)", () => {
    const m = new DedupMap(60_000, 3);
    m.set("a");
    m.set("b");
    m.set("c");
    m.set("d"); // cap reached, evict oldest
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
    expect(m.has("c")).toBe(true);
    expect(m.has("d")).toBe(true);
  });

  it("lazy-sweeps expired entries on subsequent inserts", () => {
    const m = new DedupMap(1_000, 100);
    m.set("a");
    m.set("b");
    vi.advanceTimersByTime(1001);
    // Both should be expired. Triggering a sweep via .has() shouldn't be
    // required; the next .set() should sweep them.
    m.set("c");
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(false);
    expect(m.has("c")).toBe(true);
  });

  it("re-Setting an expired key re-inserts it as fresh", () => {
    const m = new DedupMap(1_000, 100);
    m.set("a");
    vi.advanceTimersByTime(1001);
    expect(m.has("a")).toBe(false);
    m.set("a");
    expect(m.has("a")).toBe(true);
  });

  it("cap eviction removes expired entries first when they exist", () => {
    const m = new DedupMap(1_000, 3);
    m.set("a");
    vi.advanceTimersByTime(500);
    m.set("b");
    vi.advanceTimersByTime(501); // a expired, b fresh
    m.set("c");
    m.set("d"); // would normally evict "a" by FIFO; sweep removes expired first
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
    expect(m.has("c")).toBe(true);
    expect(m.has("d")).toBe(true);
  });
});
