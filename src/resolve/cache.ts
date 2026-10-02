import { createHash } from 'node:crypto';

/*
 * Resolved references (task keys, board keys, people) per API key: what one key may see is never answered from what
 * another key resolved. Entries live 10 minutes; the map is bounded (oldest first out). Nothing here is a secret: the
 * key itself is only ever stored as a fingerprint (a truncated SHA-256).
 */

export const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 10_000;

/** A key's fingerprint: never reversible to the key, never logged. */
export const fingerprint = (apiKey: string) => createHash('sha256').update(apiKey).digest('hex').slice(0, 32);

export class TtlCache<V = unknown> {
  private readonly map = new Map<string, { v: V; until: number }>();
  constructor(
    private readonly ttlMs = TTL_MS,
    private readonly max = MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.until <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, v: V, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { v, until: this.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  delete(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/** The process-wide cache of resolved references (shared by every HTTP request; keys are per API key fingerprint). */
export const refCache = new TtlCache<unknown>();
