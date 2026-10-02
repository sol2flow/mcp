import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeApi, KEYS } from '../fake-api/server.js';

// The real CLI over stdio: bundled like scripts/build.mjs does, then spawned with a key for the fake API.
const fake = new FakeApi();
const dir = mkdtempSync(path.join(tmpdir(), 'mcp-stdio-'));
const bin = path.join(dir, 'index.js');

beforeAll(async () => {
  await fake.start();
  await build({
    entryPoints: ['src/index.ts'],
    outfile: bin,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'error',
    external: ['./sentry-sdk.js'],
    define: { __VERSION__: '"test"' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}, 60_000);
afterAll(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string>, messages: object[], waitFor: number) {
  return new Promise<{ out: string[]; err: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [bin], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`timeout; stdout: ${out}; stderr: ${err}`));
    }, 15_000);
    p.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n').filter(Boolean);
      if (lines.length >= waitFor) {
        clearTimeout(timer);
        p.stdin.end();
        p.kill();
        resolve({ out: lines, err });
      }
    });
    p.stderr.on('data', (d) => (err += d));
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

describe('stdio', () => {
  it('stdout carries only JSON-RPC; logs go to stderr; a read-only key hides the writes', async () => {
    const { out, err } = await run(
      { SOL2FLOW_URL: fake.url, SOL2FLOW_API_KEY: KEYS.read, LOG_LEVEL: 'debug' },
      [
        INIT,
        INITIALIZED,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      ],
      3,
    );
    const msgs = out.map((l) => JSON.parse(l));
    for (const m of msgs) expect(m.jsonrpc).toBe('2.0');
    expect(msgs.find((m) => m.id === 2).result.tools).toHaveLength(13);
    expect(JSON.stringify(msgs.find((m) => m.id === 3).result)).toMatch(/read-only/);
    expect(err).toMatch(/"msg":"connected to sol2flow"/);
    expect(err).toMatch(/"scope":"read"/);
    expect(err).not.toContain(KEYS.read);
  });

  it('a refused key: the server still starts and every tool explains', async () => {
    const { out } = await run(
      { SOL2FLOW_URL: fake.url, SOL2FLOW_API_KEY: 'sf_Gone0000_' + 'z'.repeat(43) },
      [
        INIT,
        INITIALIZED,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_boards', arguments: {} } },
      ],
      2,
    );
    const r = JSON.parse(out[1]!);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/refused the API key/);
  });

  it('--version and --help print and exit; --api-key is refused', async () => {
    const cli = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const p = spawn(process.execPath, [bin, ...args]);
        let out = '',
          err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => resolve({ code, out, err }));
      });
    expect(await cli(['--version'])).toMatchObject({ code: 0, out: 'test\n' });
    expect((await cli(['--help'])).out).toMatch(/SOL2FLOW_API_KEY/);
    expect(await cli(['--api-key', 'x'])).toMatchObject({ code: 2, err: expect.stringMatching(/no --api-key flag/) });
  });
});
