import { ApiError, TransportError } from './errors.js';
import { OPS, type OpId } from './operations.js';

/*
 * The REST API client (README.md → How it works). One instance per API key and tool call context:
 *
 * - `Authorization: Bearer <key>`, `User-Agent: sol2flow-mcp/<version>`, JSON in and out;
 * - 15 s per call (CALL_TIMEOUT_MS), within the tool's own deadline (the `signal`);
 * - retries for GET only: 429 `rate_limited` with Retry-After ≤ 10 s (twice), 5xx and network errors (once). Never
 *   the daily plan cap (`plan_limit`, also a 429), never a write: the API has no idempotency keys, so a write that
 *   gets no answer is reported as "may or may not have been applied";
 * - the instance's API version from the `Sol2flow-Api-Version` header (API 1.8.0+); without it, 1.7.0 is assumed.
 */

export const CALL_TIMEOUT_MS = 15_000;
const MAX_RATE_RETRIES = 2;
const MAX_RATE_WAIT_SEC = 10;
const MAX_OTHER_RETRIES = 1;
const OTHER_RETRY_DELAY_MS = 500;

export type Query = Record<string, string | number | boolean | readonly string[] | null | undefined>;
export type CallOptions = {
  params?: Record<string, string>;
  query?: Query;
  body?: unknown;
};

export type CallRecord = { op: OpId; method: string; status: number | 'error'; ms: number; attempt: number };

export type ClientOptions = {
  apiBase: string;
  apiKey: string;
  userAgent: string;
  /** sent as X-Forwarded-For (FORWARD_CLIENT_IP), so the app's per-IP limits see the person, not this server */
  clientIp?: string;
  /** the tool's deadline: aborts every call still running */
  signal?: AbortSignal;
  callTimeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** each HTTP exchange (logging) */
  onCall?: (r: CallRecord) => void;
  /** the API refused the key (401): the HTTP transport stops sending it for a while */
  onRefused?: () => void;
};

export const VERSION_HEADER = 'sol2flow-api-version';

export class ApiClient {
  /** the instance's API version, from the last response that carried the header */
  apiVersion: string | null = null;
  /** HTTP requests made (each retry counts: it counts against the rate limits too) */
  requests = 0;
  private readonly o: Required<Pick<ClientOptions, 'callTimeoutMs' | 'fetch' | 'sleep'>> & ClientOptions;

  constructor(o: ClientOptions) {
    this.o = {
      ...o,
      callTimeoutMs: o.callTimeoutMs ?? CALL_TIMEOUT_MS,
      fetch: o.fetch ?? globalThis.fetch.bind(globalThis),
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  url(op: OpId, o: CallOptions = {}) {
    const path = OPS[op].path.replace(/\{(\w+)\}/g, (_, n: string) => {
      const v = o.params?.[n];
      if (v === undefined) throw new Error(`${op}: missing path parameter ${n}`);
      return encodeURIComponent(v);
    });
    const u = new URL(this.o.apiBase + path);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async call<T = unknown>(op: OpId, o: CallOptions = {}): Promise<T> {
    const { method } = OPS[op];
    const read = method === 'GET';
    const url = this.url(op, o);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.o.apiKey}`,
      'User-Agent': this.o.userAgent,
      Accept: 'application/json',
    };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.o.clientIp) headers['X-Forwarded-For'] = this.o.clientIp;

    let rateRetries = 0,
      otherRetries = 0;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const signals = [AbortSignal.timeout(this.o.callTimeoutMs)];
      if (this.o.signal) signals.push(this.o.signal);
      let res: Response;
      try {
        this.requests++;
        res = await this.o.fetch(url, {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          signal: AbortSignal.any(signals),
          redirect: 'error',
        });
      } catch (err) {
        this.o.onCall?.({ op, method, status: 'error', ms: Date.now() - started, attempt });
        const deadline = this.o.signal?.aborted ?? false;
        const timeout = deadline || (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
        const reason = deadline
          ? 'the tool took too long'
          : timeout
            ? `no answer within ${Math.round(this.o.callTimeoutMs / 1000)} s`
            : networkReason(err);
        if (read && !deadline && otherRetries < MAX_OTHER_RETRIES) {
          otherRetries++;
          await this.o.sleep(OTHER_RETRY_DELAY_MS);
          continue;
        }
        throw new TransportError(op, !read, timeout, reason);
      }
      const version = res.headers.get(VERSION_HEADER);
      if (version) this.apiVersion = version.trim();
      this.o.onCall?.({ op, method, status: res.status, ms: Date.now() - started, attempt });
      if (res.status === 204) return undefined as T;
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok) return body as T;

      const e = new ApiError(`${method} ${OPS[op].path}`, res.status, body, res.headers.get('retry-after'));
      if (res.status === 401) this.o.onRefused?.();
      if (read && res.status === 429 && e.code === 'rate_limited' && rateRetries < MAX_RATE_RETRIES) {
        const wait = e.retryAfter ?? Infinity;
        if (wait <= MAX_RATE_WAIT_SEC) {
          rateRetries++;
          await this.o.sleep(Math.max(0, wait) * 1000);
          continue;
        }
      }
      if (read && res.status >= 500 && otherRetries < MAX_OTHER_RETRIES) {
        otherRetries++;
        await this.o.sleep(OTHER_RETRY_DELAY_MS);
        continue;
      }
      throw e;
    }
  }

  /** Every page of a cursor-paginated list, up to `maxItems` (then `more` is true). */
  async all<T>(op: OpId, o: CallOptions & { maxItems: number }): Promise<{ items: T[]; more: boolean }> {
    const items: T[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.call<{ data: T[]; next_cursor: string | null }>(op, {
        ...o,
        query: { ...o.query, limit: 100, cursor: cursor ?? undefined },
      });
      items.push(...page.data);
      cursor = page.next_cursor;
      if (items.length >= o.maxItems)
        return { items: items.slice(0, o.maxItems), more: items.length > o.maxItems || Boolean(cursor) };
    } while (cursor);
    return { items, more: false };
  }
}

function networkReason(err: unknown) {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (err as Error)?.message ?? 'network error';
}
