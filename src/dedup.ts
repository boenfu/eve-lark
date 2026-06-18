/**
 * In-process deduplication for Feishu webhook events.
 *
 * Feishu retries delivery on non-2xx responses and during brief outage windows,
 * so consumers must idempotently ack events they've already seen. We key by
 * `header.event_id` (or `message.message_id` as a fallback) and remember each
 * key for the TTL window.
 *
 * Backed by an insertion-ordered Map so FIFO eviction is O(1) at the front.
 * Lazy sweep on every insert prevents unbounded growth of expired entries;
 * no `setInterval` so this is safe in serverless.
 */
export class DedupMap {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private insertsSinceSweep = 0;

  constructor(ttlMs: number, maxEntries: number) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  has(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: string): void {
    this.maybeSweep();
    // Refresh timestamp by re-inserting at the tail of insertion order.
    this.entries.delete(key);
    this.entries.set(key, Date.now());

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  /**
   * Walk the insertion-ordered map from the front and drop expired entries.
   * Stops at the first non-expired entry since events arrive roughly in time
   * order. Called on every set, so cost is amortized.
   */
  private maybeSweep(): void {
    this.insertsSinceSweep += 1;
    if (this.insertsSinceSweep < 64 && this.entries.size < this.maxEntries) {
      return;
    }
    this.insertsSinceSweep = 0;
    const now = Date.now();
    for (const [key, at] of this.entries) {
      if (now - at <= this.ttlMs) break;
      this.entries.delete(key);
    }
  }
}
