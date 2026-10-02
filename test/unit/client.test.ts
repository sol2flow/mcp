import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/api/client.js';
import { ApiError, TransportError } from '../../src/api/errors.js';
import { FakeApi, KEYS } from '../fake-api/server.js';

const fake = new FakeApi();
const sleeps: number[] = [];
const client = (o: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) =>
  new ApiClient({
    apiBase: fake.url + '/api/v1',
    apiKey: KEYS.full,
    userAgent: 'sol2flow-mcp/test',
    sleep: async (ms) => void sleeps.push(ms),
    ...o,
  });

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests = [];
  fake.inject.clear();
  fake.version = '1.8.0';
  sleeps.length = 0;
});

const rateLimited = (retryAfter: number) => ({
  status: 429,
  body: { error: { code: 'rate_limited', message: 'Too many requests.', retry_after: retryAfter } },
  headers: { 'Retry-After': String(retryAfter) },
});

describe('requests', () => {
  it('sends the key, the user agent and JSON, and builds paths and queries', async () => {
    const c = client();
    expect(c.url('getTask', { params: { taskId: 'a/b' } })).toBe(fake.url + '/api/v1/tasks/a%2Fb');
    expect(c.url('listTasks', { query: { assignee: ['x', 'y'], q: '', cursor: undefined, archived: 'true' } })).toBe(
      fake.url + '/api/v1/tasks?assignee=x&assignee=y&archived=true',
    );
    await c.call('getMe');
    const r = fake.requests[0]!;
    expect(r.headers.authorization).toBe(`Bearer ${KEYS.full}`);
    expect(r.headers['user-agent']).toBe('sol2flow-mcp/test');
    expect(r.headers['x-forwarded-for']).toBeUndefined();
  });

  it('forwards the client IP when asked', async () => {
    await client({ clientIp: '203.0.113.7' }).call('getMe');
    expect(fake.requests[0]!.headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('reads the API version header, and has none from a 1.7 instance', async () => {
    const c = client();
    await c.call('getMe');
    expect(c.apiVersion).toBe('1.8.0');
    fake.version = null;
    const old = client();
    await old.call('getMe');
    expect(old.apiVersion).toBeNull();
  });

  it('pages through a list', async () => {
    const r = await client().all('listTasks', { query: { workspace: 'acme' }, maxItems: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.more).toBe(true);
    const all = await client().all('listTasks', { query: { workspace: 'acme' }, maxItems: 100 });
    expect(all.items).toHaveLength(3);
    expect(all.more).toBe(false);
  });
});

describe('retries', () => {
  it('retries a GET on rate_limited with Retry-After ≤ 10 s, at most twice', async () => {
    fake.inject.set('GET /me', { ...rateLimited(3), times: 2 });
    await client().call('getMe');
    expect(fake.requests).toHaveLength(3);
    expect(sleeps).toEqual([3000, 3000]);

    fake.requests = [];
    fake.inject.set('GET /me', { ...rateLimited(3), times: 3 });
    await expect(client().call('getMe')).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(fake.requests).toHaveLength(3);
  });

  it("doesn't wait out a long Retry-After", async () => {
    fake.inject.set('GET /me', rateLimited(120));
    await expect(client().call('getMe')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 120 });
    expect(fake.requests).toHaveLength(1);
  });

  it('never retries the daily plan cap', async () => {
    fake.inject.set('GET /me', {
      status: 429,
      body: { error: { code: 'plan_limit', message: 'cap', kind: 'apiCalls', limit: 1000, retry_after: 5 } },
    });
    await expect(client().call('getMe')).rejects.toMatchObject({ code: 'plan_limit', kind: 'apiCalls' });
    expect(fake.requests).toHaveLength(1);
  });

  it('retries a GET once on 5xx and on network errors', async () => {
    fake.inject.set('GET /me', { status: 502, body: { error: { code: 'internal', message: 'x' } }, times: 1 });
    await client().call('getMe');
    expect(fake.requests).toHaveLength(2);

    let n = 0;
    const flaky: typeof fetch = async (u, i) => {
      if (n++ === 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return fetch(u, i);
    };
    await client({ fetch: flaky }).call('getMe');
    expect(n).toBe(2);
  });

  it('never retries a write: no answer means "may or may not have been applied"', async () => {
    fake.inject.set('POST /timer/stop', { status: 503, body: { error: { code: 'internal', message: 'x' } } });
    await expect(client().call('stopTimer')).rejects.toBeInstanceOf(ApiError);
    expect(fake.requests).toHaveLength(1);

    fake.requests = [];
    fake.inject.set('POST /timer/stop', { status: 200, body: { stopped: null }, delayMs: 300 });
    const err = await client({ callTimeoutMs: 50 })
      .call('stopTimer')
      .catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ write: true, timeout: true });
    expect(fake.requests).toHaveLength(1);
  });

  it('a 401 tells the transport the key was refused', async () => {
    let refused = 0;
    await expect(
      client({ apiKey: 'sf_Nope0000_' + 'x'.repeat(43), onRefused: () => refused++ }).call('getMe'),
    ).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(refused).toBe(1);
  });
});
