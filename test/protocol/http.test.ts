import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseArgs } from '../../src/config.js';
import { startHttp } from '../../src/transports/http.js';
import { FakeApi, KEYS } from '../fake-api/server.js';
import { clearCache } from '../helpers.js';

const fake = new FakeApi();
let server: Server;
let base = '';

const config = (env: Record<string, string> = {}) =>
  loadConfig({ MCP_TRANSPORT: 'http', SOL2FLOW_URL: fake.url, PORT: '1', ...env }, parseArgs([]));

async function start(env: Record<string, string> = {}) {
  const s = await startHttp({ ...config(env), http: { ...config(env).http, port: 0 } });
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};
const post = (body: unknown, headers: Record<string, string> = {}, url = base + '/mcp') =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

async function client(key: string, query = '') {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp' + query), { requestInit: { headers: auth(key) } }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await c.callTool({ name, arguments: args })) as CallToolResult).content
      .map((x) => (x.type === 'text' ? x.text : ''))
      .join('');
  return { c, call };
}

beforeAll(async () => {
  await fake.start();
  ({ s: server, url: base } = await start());
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await fake.stop();
});
beforeEach(() => {
  clearCache();
  fake.requests = [];
});

describe('HTTP transport', () => {
  it('healthz', async () => {
    const r = await fetch(base + '/healthz');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', version: 'dev' });
  });

  it('401 without a key or with a malformed one, with WWW-Authenticate', async () => {
    for (const h of [{}, auth('nope'), { Authorization: 'Basic abc' }]) {
      const r = await post(INIT, h);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/^Bearer realm="sol2flow"/);
      expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/Settings → API keys/);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('403 for a foreign Origin or Host', async () => {
    expect((await post(INIT, { ...auth(KEYS.full), Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(INIT, { ...auth(KEYS.full), Origin: 'http://localhost:6274' })).status).toBe(200);
    // fetch can't fake Host: a server that only allows another host
    const other = await start({ ALLOWED_HOSTS: 'mcp.sol2flow.com' });
    try {
      expect((await post(INIT, auth(KEYS.full), other.url + '/mcp')).status).toBe(403);
      expect((await fetch(other.url + '/healthz')).status).toBe(200);
    } finally {
      other.s.close();
    }
  });

  it('413 for bodies over 1 MB, 400 for bad JSON', async () => {
    const big = JSON.stringify({ ...INIT, pad: 'x'.repeat(1024 * 1024) });
    expect((await post(big, auth(KEYS.full))).status).toBe(413);
    expect((await post('{nope', auth(KEYS.full))).status).toBe(400);
  });

  it('405 for GET and DELETE (stateless: no SSE stream, no sessions)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(base + '/mcp', { method, headers: auth(KEYS.full) });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('POST, OPTIONS');
    }
  });

  it('answers JSON, not SSE, and keeps no session', async () => {
    const r = await post(INIT, auth(KEYS.full));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.headers.get('mcp-session-id')).toBeNull();
    expect(((await r.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('sol2flow');
  });

  it('two keys in parallel are never mixed', async () => {
    const [a, b] = await Promise.all([client(KEYS.full), client(KEYS.other)]);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? b.call('whoami') : a.call('whoami'))),
    );
    results.forEach((t, i) => expect(t).toMatch(i % 2 ? /You are Ben Okafor/ : /You are Ana Lima/));
    const byKey = (k: string) => fake.requests.filter((r) => r.key === k).length;
    expect(byKey(KEYS.full)).toBeGreaterThan(0);
    expect(byKey(KEYS.other)).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.key === KEYS.full || r.key === KEYS.other)).toBe(true);
    await Promise.all([a.c.close(), b.c.close()]);
  });

  it('?read_only=1 hides the writes; ?workspace= sets the default', async () => {
    const { c } = await client(KEYS.full, '?read_only=1&workspace=acme');
    const { tools } = await c.listTools();
    await c.close();
    expect(tools).toHaveLength(13);
  });

  it("a key sol2flow refused isn't sent upstream again for a while", async () => {
    const bad = 'sf_Gone0000_' + 'z'.repeat(43);
    const first = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      auth(bad),
    );
    expect(JSON.stringify(await first.json())).toMatch(/refused the API key/);
    const upstream = fake.requests.length;
    const second = await post(INIT, auth(bad));
    expect(second.status).toBe(401);
    expect(fake.requests.length).toBe(upstream);
  });

  it('after 30 rejected keys from one address: 429', async () => {
    const s = await start();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) statuses.push((await post(INIT, auth('sf_bad'), s.url + '/mcp')).status);
      expect(statuses.slice(0, 30).every((x) => x === 401)).toBe(true);
      const last = await post(INIT, auth(KEYS.full), s.url + '/mcp');
      expect(last.status).toBe(429);
      expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      s.s.close();
    }
  });
});
