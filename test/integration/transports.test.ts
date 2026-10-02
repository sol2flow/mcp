import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world } from './mcp.js';
import { APP_URL, rest, rows } from './rest.js';

/*
 * Both transports of the real CLI (dist/index.js, bundled by run.sh) against a real sol2flow:
 *
 * - stdio: spawned with SOL2FLOW_URL / SOL2FLOW_API_KEY, like Claude Desktop does; the key's scope hides the writes.
 * - Streamable HTTP: spawned with --http (or, with MCP_HTTP_URL, a server that already runs, e.g. the Docker image),
 *   the SDK client with a Bearer header: keys kept apart, Host / Origin checks, limits, refused keys.
 *
 * Neither log may contain a key, a tool argument or a result: both are captured and searched.
 */

const w = world();
const ws = w.workspaces.w1.slug;
const BIN = path.resolve('dist/index.js');
const SECRET_ARG = `ARG-SECRET-${w.run}`;
const ALL_KEYS = Object.values(w.keys).map((k) => k.key);

const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** What a log must never contain: a key (or its secret part), an argument, a result, a bearer header. */
function expectClean(log: string, results: string[]) {
  expect(log.length).toBeGreaterThan(0);
  for (const k of ALL_KEYS) {
    expect(log).not.toContain(k);
    expect(log).not.toContain(k.split('_')[2]!);
  }
  expect(log).not.toContain(SECRET_ARG);
  expect(log).not.toMatch(/Bearer\s+sf_/i);
  for (const r of results) expect(log).not.toContain(r);
}

describe('stdio', () => {
  const logs: string[] = [];
  async function stdio(key: string, env: Record<string, string> = {}) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { PATH: process.env.PATH ?? '', SOL2FLOW_URL: APP_URL, SOL2FLOW_API_KEY: key, LOG_LEVEL: 'debug', ...env },
      stderr: 'pipe',
    });
    let log = '';
    transport.stderr?.on('data', (d) => (log += d));
    const client = new Client({ name: 'it-stdio', version: '1' });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return { text: text(r), isError: Boolean(r.isError) };
    };
    return {
      client,
      call,
      close: async () => {
        await client.close();
        logs.push(log);
      },
      log: () => log,
    };
  }

  it('a full key: every tool listed, reads and writes work', async () => {
    const c = await stdio(w.keys.stdio!.key, { SOL2FLOW_WORKSPACE: ws });
    try {
      expect((await c.client.listTools()).tools).toHaveLength(32);
      const who = await c.call('whoami');
      expect(who.text).toContain(`API key "it stdio" (sf_${w.keys.stdio!.prefix}…): full access`);
      expect(who.text).toContain(`API ${w.apiVersion}`);
      expect(who.text).toContain(`default **${ws}**`);
      const created = await c.call('create_task', { board: 'MB', title: SECRET_ARG, description: 'stdio body text' });
      expect(created.isError).toBe(false);
      const key = /^Created (\S+)/.exec(created.text)![1]!;
      const got = await c.call('get_task', { task: key });
      expect(got.text).toContain(`# ${key}: ${SECRET_ARG}`);
      const found = (await rest(w.keys.seed!.key).get(`/workspaces/${ws}/search?q=${key}`)).tasks;
      expect(found.map((t: { title: string }) => t.title)).toEqual([SECRET_ARG]);
      // the log: the start, each call with the key's prefix, no key, no arguments, no results
      const log = c.log();
      expect(log).toContain('"connected to sol2flow"');
      expect(log).toContain(`"key_prefix":"${w.keys.stdio!.prefix}"`);
      expect(log).toContain('"tool":"create_task"');
      expectClean(log, ['stdio body text', 'Due early']);
    } finally {
      await c.close();
    }
  });

  it('a read-only key (1.8.0 scope): the write tools are hidden', async () => {
    const c = await stdio(w.keys.read!.key);
    try {
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      expect(names).toHaveLength(13);
      expect(names).not.toContain('create_task');
      expect((await c.call('list_boards', { workspace: ws })).text).toContain('**FL**');
      expect(c.log()).toContain('read-only API key: the write tools are hidden');
    } finally {
      await c.close();
    }
  });

  it('a revoked key: the server starts, every tool says why', async () => {
    const c = await stdio(w.keys.revoked!.key);
    try {
      expect((await c.client.listTools()).tools).toHaveLength(32);
      const r = await c.call('list_boards', { workspace: ws });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^sol2flow refused the API key/);
      expect(c.log()).toContain('the API key was refused');
    } finally {
      await c.close();
    }
  });

  afterAll(() => expectClean(logs.join('\n'), ['stdio body text']));
});

describe('Streamable HTTP', () => {
  const external = process.env.MCP_HTTP_URL?.replace(/\/+$/, '');
  let base = external ?? '';
  let server: ChildProcess | undefined;
  let log = '';

  beforeAll(async () => {
    if (external) return;
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [BIN, '--http', '--port', String(port)], {
      env: { PATH: process.env.PATH ?? '', SOL2FLOW_URL: APP_URL, LOG_LEVEL: 'debug' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', (d) => (log += d));
    server.stderr!.on('data', (d) => (log += d));
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(base + '/healthz').then(
          (r) => r.ok,
          () => false,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the HTTP server didn't start: ${log}`);
  });
  afterAll(() => {
    server?.kill();
  });

  async function http(key: string, query = '') {
    const client = new Client({ name: 'it-http', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + '/mcp' + query), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return { text: text(r), isError: Boolean(r.isError) };
    };
    return { client, call, close: () => client.close() };
  }
  const INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const authFails = async () =>
    Number(
      (
        await rows<{ n: string }>(
          "SELECT COALESCE(SUM(count), 0)::text AS n FROM rate_limits WHERE bucket = 'api-auth-fail'",
        )
      )[0]!.n,
    );

  it('/healthz, and 405 for GET and DELETE /mcp', async () => {
    const h = await fetch(base + '/healthz');
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: 'ok' });
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(base + '/mcp', { method, headers: { Authorization: `Bearer ${w.keys.http!.key}` } });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('POST, OPTIONS');
    }
  });

  it('a full key: tools work and their writes land', async () => {
    const c = await http(w.keys.http!.key, `?workspace=${ws}`);
    try {
      expect((await c.client.listTools()).tools).toHaveLength(32);
      expect((await c.call('whoami')).text).toContain(`default **${ws}**`);
      const created = await c.call('create_task', { board: 'MB', title: SECRET_ARG, description: 'http body text' });
      const key = /^Created (\S+)/.exec(created.text)![1]!;
      expect((await c.call('get_task', { task: key })).text).toContain('http body text');
      expect((await c.call('get_task', { task: 'FL-1' })).text).toContain('Due early');
      const found = (await rest(w.keys.seed!.key).get(`/workspaces/${ws}/search?q=${key}`)).tasks;
      expect(found).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  it('a read-only key: the writes are listed but refused with the scope error; ?read_only=1 hides them', async () => {
    const c = await http(w.keys.read!.key, `?workspace=${ws}`);
    try {
      expect((await c.client.listTools()).tools).toHaveLength(32);
      const r = await c.call('create_task', { board: 'MB', title: 'nope' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^This API key is read-only, so create_task can't change anything/);
      expect((await c.call('list_boards')).text).toContain('**FL**');
    } finally {
      await c.close();
    }
    const ro = await http(w.keys.read!.key, '?read_only=1');
    expect((await ro.client.listTools()).tools).toHaveLength(13);
    await ro.close();
  });

  it('two clients with different keys at the same time never see each other', async () => {
    const [a, b] = await Promise.all([http(w.keys.http!.key), http(w.keys.bob!.key)]);
    try {
      const calls: Promise<readonly [string, string]>[] = Array.from({ length: 12 }, (_, i) =>
        i % 2
          ? a.call('whoami').then((r) => ['ada', r.text] as const)
          : b.call('whoami').then((r) => ['bob', r.text] as const),
      );
      calls.push(
        a.call('list_workspaces').then((r) => ['ada-ws', r.text] as const),
        b.call('list_workspaces').then((r) => ['bob-ws', r.text] as const),
      );
      for (const [who, t] of await Promise.all(calls)) {
        if (who === 'ada') expect(t).toContain('You are Ada Admin');
        if (who === 'bob') expect(t).toContain('You are Bob Member');
        if (who === 'ada-ws') expect(t).toContain(w.workspaces.w2.slug);
        if (who === 'bob-ws') expect(t).not.toContain(w.workspaces.w2.slug);
      }
      // Nina can't use what Ada's key resolved (the cache is per key)
      expect((await a.call('get_task', { task: 'RR-1', workspace: ws })).isError).toBe(false);
      const nina = await http(w.keys.nina!.key);
      expect((await nina.call('get_task', { task: 'RR-1', workspace: ws })).text).toMatch(/^No task RR-1/);
      await nina.close();
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('no key or a malformed one: 401 with WWW-Authenticate, without asking the app', async () => {
    const before = await authFails();
    for (const h of [
      {} as Record<string, string>,
      { Authorization: 'Bearer nope' },
      { Authorization: 'Basic abc' },
      { Authorization: 'Bearer sf_short_x' },
    ]) {
      const r = await post(INIT, h);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/^Bearer realm="sol2flow"/);
      expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/Settings → API keys/);
    }
    expect(await authFails()).toBe(before); // the app never saw them
  });

  it('a well-formed key the app refuses: a clear tool error, then 401 without asking the app again', async () => {
    const unknown = `sf_Unkn${w.run}_${'u'.repeat(43)}`.replace(/_(\w{8})\w*_/, (_, p) => `_${p}_`);
    for (const key of [unknown, w.keys.expired!.key]) {
      const before = await authFails();
      const c = await http(key);
      const r = await c.call('whoami');
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^sol2flow refused the API key/);
      await c.close().catch(() => undefined);
      const seen = await authFails();
      expect(seen).toBeGreaterThan(before); // the app refused it (whoami's requests run in parallel)
      const again = await post(INIT, { Authorization: `Bearer ${key}` });
      expect(again.status).toBe(401);
      expect(((await again.json()) as { error: { message: string } }).error.message).toMatch(
        /^sol2flow refused this API key/,
      );
      expect(await authFails()).toBe(seen);
    }
  });

  it('Host and Origin checks, the body limit', async () => {
    const auth = { Authorization: `Bearer ${w.keys.http!.key}` };
    // fetch can't set Host: a raw request
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(base + '/mcp');
      const req = request(
        { host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', ...auth } },
        (res) => resolve(res.statusCode!),
      );
      req.on('error', reject);
      req.end(JSON.stringify(INIT));
    });
    expect(status).toBe(403);
    const origin = await post(INIT, { ...auth, Origin: 'https://evil.example' });
    expect(origin.status).toBe(403);
    expect(((await origin.json()) as { error: { message: string } }).error.message).toMatch(/Origin not allowed/);
    expect((await post(INIT, { ...auth, Origin: 'http://localhost:6274' })).status).toBe(200);
    const big = await post(JSON.stringify({ ...INIT, pad: 'x'.repeat(1024 * 1024 + 10) }), auth);
    expect(big.status).toBe(413);
  });

  it('the log: requests and tool calls with the key prefix, never a key, an argument or a result', async (t) => {
    if (external) return t.skip();
    expect(log).toContain('"tool":"create_task"');
    expect(log).toContain(`"key_prefix":"${w.keys.http!.prefix}"`);
    expect(log).toContain('"reason":"malformed_key"');
    expect(log).toContain('"reason":"refused_key"');
    expectClean(log, ['http body text', 'Due early', 'Secret plan']);
  });
});
