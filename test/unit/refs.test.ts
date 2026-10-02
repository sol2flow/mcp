import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/api/client.js';
import { fingerprint, refCache } from '../../src/resolve/cache.js';
import { parseAppUrl, resolveBoard, resolveTask, resolveUser, workspaceSlug } from '../../src/resolve/refs.js';
import type { ToolContext } from '../../src/tools/context.js';
import { FakeApi, KEYS } from '../fake-api/server.js';
import { clearCache } from '../helpers.js';

const fake = new FakeApi();
const ctx = (key = KEYS.full, defaultWorkspace?: string): ToolContext => ({
  tool: 't',
  appUrl: fake.url,
  defaultWorkspace,
  fp: fingerprint(key),
  cache: refCache,
  api: new ApiClient({ apiBase: fake.url + '/api/v1', apiKey: key, userAgent: 't' }),
});

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  clearCache();
  fake.requests = [];
  fake.workspaces.splice(1);
});

describe('app URLs', () => {
  it('reads task and board URLs, with or without a language prefix', () => {
    expect(parseAppUrl('https://app.sol2flow.com/w/acme/b/PRD/t/12')).toEqual({
      workspace: 'acme',
      boardKey: 'PRD',
      number: 12,
    });
    expect(parseAppUrl('https://x.example/de/w/acme/b/PRD/')).toEqual({
      workspace: 'acme',
      boardKey: 'PRD',
      number: undefined,
    });
    expect(parseAppUrl('PRD-12')).toBeNull();
    expect(parseAppUrl('https://x.example/settings')).toBeNull();
  });
});

describe('tasks', () => {
  it('passes ids through without a request', async () => {
    const t = fake.task('PRD-2');
    expect(await resolveTask(ctx(), t.id.toUpperCase())).toEqual({ id: t.id });
    expect(fake.requests).toHaveLength(0);
  });

  it('finds a key through search (the only workspace), then from the cache', async () => {
    const t = fake.task('PRD-2');
    expect((await resolveTask(ctx(), 'prd-2')).id).toBe(t.id);
    expect(fake.requests.map((r) => r.path)).toEqual(['/workspaces', '/workspaces/acme/search']);
    fake.requests = [];
    await resolveTask(ctx(), 'PRD-2');
    expect(fake.requests).toHaveLength(0);
  });

  it("never answers one key's lookups from another key's cache", async () => {
    await resolveTask(ctx(KEYS.full), 'PRD-2');
    fake.requests = [];
    await resolveTask(ctx(KEYS.other), 'PRD-2');
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.key === KEYS.other)).toBe(true);
  });

  it('finds a task by URL in its workspace', async () => {
    const t = fake.task('PRD-3');
    expect((await resolveTask(ctx(), `${fake.url}/w/acme/b/PRD/t/3`)).id).toBe(t.id);
  });

  it('finds an archived task (not in search) on its board', async () => {
    const t = fake.task('PRD-1');
    t.archived_at = '2026-10-01T00:00:00.000Z';
    try {
      expect((await resolveTask(ctx(), 'PRD-1')).id).toBe(t.id);
    } finally {
      t.archived_at = null;
    }
  });

  it('finds a task of an archived board (not in search) by its key', async () => {
    const prd = fake.boards[0]!;
    prd.archived = true;
    try {
      expect((await resolveTask(ctx(), 'PRD-2')).id).toBe(fake.task('PRD-2').id);
    } finally {
      prd.archived = false;
    }
  });

  it('explains what a task reference is, and what was not found', async () => {
    await expect(resolveTask(ctx(), 'login bug')).rejects.toThrow(/isn't a task reference/);
    await expect(resolveTask(ctx(), 'PRD-99')).rejects.toThrow(/No task PRD-99 in workspace acme/);
  });
});

describe('workspaces', () => {
  it('uses the parameter, then the default, then the only workspace', async () => {
    expect(await workspaceSlug(ctx(), 'given')).toBe('given');
    expect(await workspaceSlug(ctx(KEYS.full, 'dflt'))).toBe('dflt');
    expect(await workspaceSlug(ctx())).toBe('acme');
  });

  it('asks for one when there are several', async () => {
    fake.workspaces.push({ id: crypto.randomUUID(), slug: 'beta', name: 'Beta', members: ['ana'] });
    await expect(workspaceSlug(ctx())).rejects.toThrow(/You are in 2 workspaces \(acme, beta\): pass `workspace`/);
  });

  it('looks a key up in the other workspaces when one refuses the key (API access off, plan)', async () => {
    fake.workspaces.push({ id: crypto.randomUUID(), slug: 'beta', name: 'Beta', members: ['ana'] });
    const off = {
      status: 403,
      body: { error: { code: 'api_disabled_workspace', message: 'API access is switched off for this workspace.' } },
    };
    fake.inject.set('GET /workspaces/beta/search', off);
    try {
      expect((await resolveTask(ctx(), 'PRD-2')).id).toBe(fake.task('PRD-2').id);
      clearCache();
      await expect(resolveTask(ctx(), 'PRD-99')).rejects.toThrow(
        /^No task PRD-99 in your workspaces, .+ Not looked in: beta \(API access is switched off for this workspace\)\.$/,
      );
      // refused everywhere: that refusal
      fake.inject.set('GET /workspaces/acme/search', off);
      clearCache();
      await expect(resolveTask(ctx(), 'PRD-2')).rejects.toMatchObject({ code: 'api_disabled_workspace' });
    } finally {
      fake.inject.clear();
    }
  });
});

describe('boards and people', () => {
  it('finds a board by key or name', async () => {
    const id = fake.boards[0]!.id;
    expect(await resolveBoard(ctx(), 'PRD')).toBe(id);
    expect(await resolveBoard(ctx(), 'product')).toBe(id);
    await expect(resolveBoard(ctx(), 'nothing')).rejects.toThrow(/No board "nothing"/);
  });

  it('prefers an archived board with that exact key over a live one whose name only contains it', async () => {
    const live = fake.boards[0]!; // "Product": contains "duc"
    const archived = { ...live, id: crypto.randomUUID(), key: 'DUC', name: 'Old things', lists: [], archived: true };
    fake.boards.push(archived);
    try {
      expect(await resolveBoard(ctx(), 'DUC')).toBe(archived.id);
      expect(await resolveBoard(ctx(), 'old things')).toBe(archived.id);
      expect(await resolveBoard(ctx(), 'prod')).toBe(live.id); // a unique part of a live name still works
    } finally {
      fake.boards.splice(fake.boards.indexOf(archived), 1);
    }
  });

  it('resolves me, usernames and names', async () => {
    expect(await resolveUser(ctx(), 'me', 'acme')).toBe(fake.users.ana!.id);
    expect(await resolveUser(ctx(), '@ben', 'acme')).toBe(fake.users.ben!.id);
    expect(await resolveUser(ctx(), 'Cara Diaz', 'acme')).toBe(fake.users.cara!.id);
    await expect(resolveUser(ctx(), 'zed', 'acme')).rejects.toThrow(/Nobody called "zed"/);
  });
});
