import { inject } from 'vitest';
import { connect } from '../helpers.js';
import { APP_URL } from './rest.js';

/* The MCP side of the integration suite: a server in memory (the same createServer the transports use) on the real app. */

export const world = () => inject('world');

export type Call = { method: string; path: string; status: number };

/**
 * A fetch that records every upstream request (method, path, status) and can add headers — the app's test-only ones:
 * `x-sol2flow-edition` (src/server/core/edition.ts) and `x-e2e-rate-limit` (src/server/auth/rate-limit.ts).
 */
export function recordingFetch(headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init) => {
    const h = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const r = await fetch(input, { ...init, headers: h });
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({
      method: init?.method ?? 'GET',
      path: u.pathname.replace(/^\/api\/v1/, '') + u.search,
      status: r.status,
    });
    return r;
  };
  return { fetch: f, calls };
}

export type Session = Awaited<ReturnType<typeof connect>> & {
  ok(name: string, args?: Record<string, unknown>): Promise<string>;
  fail(name: string, args?: Record<string, unknown>): Promise<string>;
};

/** An MCP client on a fresh in-memory server with `key`; ok() expects success, fail() an error result. */
export async function session(
  key: string,
  o: { fetch?: typeof fetch; defaultWorkspace?: string; readOnly?: boolean } = {},
): Promise<Session> {
  const s = await connect({ url: APP_URL }, { apiKey: key, ...o });
  return Object.assign(s, {
    async ok(name: string, args: Record<string, unknown> = {}) {
      const r = await s.call(name, args);
      if (r.isError) throw new Error(`${name} failed: ${r.text}`);
      return r.text;
    },
    async fail(name: string, args: Record<string, unknown> = {}) {
      const r = await s.call(name, args);
      if (!r.isError) throw new Error(`${name} should have failed: ${r.text}`);
      return r.text;
    },
  });
}
