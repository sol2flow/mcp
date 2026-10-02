/* eslint-disable @typescript-eslint/no-explicit-any -- REST answers are loosely typed here; the assertions check them */
/*
 * Direct access for the integration suite, beside the MCP server under test: the REST API with any key (to set things up
 * and to check what a tool really changed), and the control helper in the app container (control.mjs) for the database
 * switches the API doesn't offer.
 */

export const APP_URL = (process.env.SOL2FLOW_URL ?? 'http://app:3000').replace(/\/+$/, '');
export const CONTROL_URL = (process.env.CONTROL_URL ?? 'http://app:4555').replace(/\/+$/, '');

export type RestResult<T = any> = { status: number; data: T; headers: Headers };

export function rest(key: string, extraHeaders: Record<string, string> = {}) {
  const req = async <T = any>(method: string, path: string, body?: unknown): Promise<RestResult<T>> => {
    const r = await fetch(APP_URL + '/api/v1' + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: r.status, data: data as T, headers: r.headers };
  };
  const ok = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await req<T>(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return {
    req,
    get: <T = any>(p: string) => ok<T>('GET', p),
    post: <T = any>(p: string, b: unknown = {}) => ok<T>('POST', p, b),
    patch: <T = any>(p: string, b: unknown) => ok<T>('PATCH', p, b),
    put: <T = any>(p: string, b: unknown) => ok<T>('PUT', p, b),
    del: (p: string) => ok('DELETE', p),
  };
}

/** One statement on the test database through control.mjs: rows for a query, the count for `exec`. */
export async function sql<T = Record<string, unknown>>(q: string, params: unknown[] = [], exec = false) {
  const r = await fetch(CONTROL_URL + '/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: q, params, exec }),
  });
  const body = (await r.json()) as { rows?: T[]; count?: number; error?: string };
  if (!r.ok) throw new Error(`control /sql: ${body.error}`);
  return body;
}

export const rows = async <T = Record<string, unknown>>(q: string, params: unknown[] = []) =>
  (await sql<T>(q, params)).rows!;
export const exec = async (q: string, params: unknown[] = []) => (await sql(q, params, true)).count!;
