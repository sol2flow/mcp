import { ApiError, ToolError, TransportError } from './errors.js';
import { OPS, type OpId } from './operations.js';

/*
 * The REST API client (README.md → How it works). One instance per API key and tool call context:
 *
 * - `Authorization: Bearer <key>`, `User-Agent: sol2flow-mcp/<version>`, JSON in and out;
 * - 15 s per call (CALL_TIMEOUT_MS), within the tool's own deadline (the `signal`);
 * - retries for GET only: 429 `rate_limited` with Retry-After ≤ 10 s (twice), 5xx and network errors (once). Never
 *   the daily plan cap (`plan_limit`, also a 429), never a write: the API has no idempotency keys, so a write that
 *   gets no answer is reported as "may or may not have been applied";
 * - the instance's API version from the `Sol2flow-Api-Version` header (API 1.8.0+); without it, 1.7.0 is assumed;
 * - files (`download`): bytes up to a size, following S3's redirect to a signed URL without the key.
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
  /** the version an earlier call saw: a call answered from cache alone still knows it */
  apiVersion?: string | null;
  /** each response's `Sol2flow-Api-Version`, to remember it for later calls */
  onVersion?: (version: string) => void;
};

export const VERSION_HEADER = 'sol2flow-api-version';

export class ApiClient {
  /** the instance's API version, from the last response that carried the header */
  apiVersion: string | null = null;
  /** HTTP requests made (each retry counts: it counts against the rate limits too) */
  requests = 0;
  private readonly o: Required<Pick<ClientOptions, 'callTimeoutMs' | 'fetch' | 'sleep'>> & ClientOptions;

  constructor(o: ClientOptions) {
    this.apiVersion = o.apiVersion ?? null;
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
      if (version) {
        this.apiVersion = version.trim();
        this.o.onVersion?.(this.apiVersion);
      }
      this.o.onCall?.({ op, method, status: res.status, ms: Date.now() - started, attempt });
      if (res.status === 204) return undefined as T;
      const text = await res.text().catch(() => '');
      let body: unknown;
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

  /**
   * A file (`downloadFile`): its type, name and size, and its bytes when they fit `maxBytes(type)` (0: don't read them).
   * The body is read only up to that cap, also without a Content-Length. With S3 storage the API answers 302 to a
   * short-lived signed URL, followed here without the key (only the API sees it); the storage's own errors aren't the
   * API's, so a 401 there doesn't mark the key refused. One attempt per request: a download is rarely worth a second try
   * within the tool's deadline.
   */
  async download(op: OpId, o: CallOptions, maxBytes: (type: string) => number): Promise<Download> {
    const url = this.url(op, o);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.o.apiKey}`,
      'User-Agent': this.o.userAgent,
    };
    if (this.o.clientIp) headers['X-Forwarded-For'] = this.o.clientIp;
    let res = await this.fetchOnce(op, url, { headers, redirect: 'manual' });
    let storage = false;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new ApiError(`GET ${OPS[op].path}`, 502, null);
      storage = true;
      res = await this.fetchOnce(op, new URL(location, url).toString(), {
        headers: { 'User-Agent': this.o.userAgent },
        redirect: 'error',
      });
    }
    if (!res.ok) {
      if (storage) {
        await res.body?.cancel();
        throw new ToolError(
          `The instance's file storage answered ${res.status} for this file (through the signed link sol2flow gave): ` +
            'a storage problem on the instance, not your access. Try again later, or tell its admin.',
        );
      }
      const body = await res.json().catch(() => null);
      if (res.status === 401) this.o.onRefused?.();
      throw new ApiError(`GET ${OPS[op].path}`, res.status, body, res.headers.get('retry-after'));
    }
    const type = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    const name = fileName(res.headers.get('content-disposition'));
    const length = res.headers.get('content-length');
    // a Content-Length that isn't a plain byte count is ignored (the body is measured instead)
    const declared = length !== null && /^\d+$/.test(length.trim()) ? Number(length) : null;
    const max = maxBytes(type);
    if (declared !== null && declared > max) {
      await res.body?.cancel();
      return { type, name, size: declared, atLeast: false, bytes: null };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    try {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        size += chunk.value.length;
        if (size > max) {
          await reader!.cancel();
          return { type, name, size: declared ?? size, atLeast: declared === null, bytes: null };
        }
        chunks.push(chunk.value);
      }
    } catch (err) {
      throw this.transportError(op, err);
    }
    return { type, name, size, atLeast: false, bytes: Buffer.concat(chunks) };
  }

  /** One GET within the call timeout and the tool's deadline; no answer is a TransportError. */
  private async fetchOnce(
    op: OpId,
    url: string,
    init: { headers: Record<string, string>; redirect: 'manual' | 'error' },
  ) {
    const started = Date.now();
    const signals = [AbortSignal.timeout(this.o.callTimeoutMs)];
    if (this.o.signal) signals.push(this.o.signal);
    this.requests++;
    try {
      const res = await this.o.fetch(url, { method: 'GET', ...init, signal: AbortSignal.any(signals) });
      const version = res.headers.get(VERSION_HEADER);
      if (version) {
        this.apiVersion = version.trim();
        this.o.onVersion?.(this.apiVersion);
      }
      this.o.onCall?.({ op, method: 'GET', status: res.status, ms: Date.now() - started, attempt: 1 });
      return res;
    } catch (err) {
      this.o.onCall?.({ op, method: 'GET', status: 'error', ms: Date.now() - started, attempt: 1 });
      throw this.transportError(op, err);
    }
  }

  /** A read that got no (full) answer: the tool's deadline, the call timeout, or the network. */
  private transportError(op: OpId, err: unknown) {
    const deadline = this.o.signal?.aborted ?? false;
    const timeout = deadline || (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
    const reason = deadline
      ? 'the tool took too long'
      : timeout
        ? `no answer within ${Math.round(this.o.callTimeoutMs / 1000)} s`
        : networkReason(err);
    return new TransportError(op, false, timeout, reason);
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

/** `atLeast`: the size is a lower bound (no Content-Length, and reading stopped at the cap). */
export type Download = { type: string; name: string | null; size: number; atLeast: boolean; bytes: Buffer | null };

/** The file name from `Content-Disposition` (RFC 6266: `filename*=UTF-8''…` wins over `filename="…"`). */
export function fileName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star)
    try {
      return decodeURIComponent(star.trim());
    } catch {
      // a malformed encoding: fall back to the plain parameter
    }
  return /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)?.[1]?.replace(/\\(.)/g, '$1') ?? null;
}

function networkReason(err: unknown) {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (err as Error)?.message ?? 'network error';
}
