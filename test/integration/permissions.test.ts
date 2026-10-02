import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, parseArgs } from '../../src/config.js';
import { checkKey } from '../../src/transports/stdio.js';
import { recordingFetch, session, world, type Session } from './mcp.js';
import { APP_URL, exec, rest, rows } from './rest.js';

/*
 * Permissions against a real sol2flow (README.md → How it works: "the API decides"). For each refusal the app makes,
 * the MCP server must say clearly what happened and what to do, and must not leak what the key can't see. Writes that
 * were refused are checked to have changed nothing (REST, as Ada).
 */

const w = world();
const ws = w.workspaces.w1.slug;
const ada = rest(w.keys.perm!.key);
let s: Session;

const REFUSED = /^sol2flow refused the API key: it is unknown, expired or revoked/;
const FORBIDDEN = /^You don't have permission for this \(.+\): your role on the board or workspace doesn't allow it/;
const NOT_FOUND = /^Not found, or you don't have access to it/;

beforeAll(async () => {
  s = await session(w.keys.perm!.key);
});
afterAll(() => s?.close());

const taskCount = async (boardId: string) => (await ada.get(`/boards/${boardId}`)).task_count as number;

describe('keys', () => {
  it('a read-only key: reads work, every write is refused with the scope error', async () => {
    const r = await session(w.keys.read!.key);
    try {
      expect(await r.ok('list_boards', { workspace: ws })).toContain('**FL**');
      const before = await taskCount(w.boards.MB.id);
      for (const [tool, args] of [
        ['create_task', { board: 'MB', workspace: ws, title: 'nope' }],
        ['add_comment', { task: 'FL-1', workspace: ws, text: 'nope' }],
        ['archive_task', { task: 'FL-1', workspace: ws }],
        ['start_timer', { task: 'FL-1', workspace: ws }],
        ['mark_notifications_read', { all: true }],
        ['create_board', { workspace: ws, name: 'nope' }],
      ] as const)
        expect(await r.fail(tool, args)).toMatch(
          new RegExp(`^This API key is read-only, so ${tool} can't change anything`),
        );
      expect(await taskCount(w.boards.MB.id)).toBe(before);
    } finally {
      await r.close();
    }
    // stdio checks the key at start: the 1.8 API names its scope, so the write tools are hidden there
    const check = await checkKey(
      loadConfig({ SOL2FLOW_URL: APP_URL, SOL2FLOW_API_KEY: w.keys.read!.key }, parseArgs([])),
    );
    expect(check).toEqual({ readOnly: true, apiVersion: w.apiVersion });
  });

  it('revoked, expired and unknown keys: one clear answer (and stdio reports it from the start)', async () => {
    const unknown = `sf_${'Zz9'.repeat(3).slice(0, 8)}_${'q'.repeat(43)}`;
    for (const key of [w.keys.revoked!.key, w.keys.expired!.key, unknown]) {
      const r = await session(key);
      expect(await r.fail('whoami')).toMatch(REFUSED);
      expect(await r.fail('list_boards', { workspace: ws })).toContain(`${APP_URL}/settings/api-keys`);
      await r.close();
      const check = await checkKey(loadConfig({ SOL2FLOW_URL: APP_URL, SOL2FLOW_API_KEY: key }, parseArgs([])));
      expect(check.unavailable).toMatch(REFUSED);
    }
  });

  it('API keys switched off on the instance (api_disabled)', async () => {
    await exec('UPDATE instance_settings SET api_keys = false WHERE id = 1');
    try {
      expect(await s.fail('whoami')).toMatch(/^API keys are switched off on this sol2flow instance/);
      expect(await s.fail('create_task', { board: w.boards.MB.id, title: 'nope' })).toMatch(
        /^API keys are switched off/,
      );
      const check = await checkKey(
        loadConfig({ SOL2FLOW_URL: APP_URL, SOL2FLOW_API_KEY: w.keys.perm!.key }, parseArgs([])),
      );
      expect(check.unavailable).toMatch(/^API keys are switched off/);
    } finally {
      await exec('UPDATE instance_settings SET api_keys = true WHERE id = 1');
    }
    expect(await s.ok('whoami')).toContain('Ada Admin');
  });

  it("a workspace's API access switched off (api_disabled_workspace), the others unaffected", async () => {
    const w3 = w.workspaces.w3.slug;
    await exec('UPDATE workspaces SET api_access = false WHERE id = $1::uuid', [w.workspaces.w3.id]);
    try {
      const fresh = await session(w.keys.perm!.key); // nothing cached
      try {
        const off = /^API access is switched off for this workspace \(Workspace settings → API access\)/;
        expect(await fresh.fail('list_boards', { workspace: w3 })).toMatch(off);
        expect(await fresh.fail('get_task', { task: 'SB-1', workspace: w3 })).toMatch(off);
        expect(await fresh.fail('get_task', { task: w.tasks.SB1!.id })).toMatch(off);
        // the other workspaces keep working, also when a key is looked up in all of them
        expect(await fresh.ok('get_task', { task: 'FL-1' })).toContain('# FL-1: Due early');
        const found = await fresh.ok('search', { query: 'Due early' });
        expect(found).toContain('**FL-1**');
        expect(found).toContain(`# ${w3}\n_Not searched: `);
        expect(await fresh.ok('list_boards', { workspace: ws })).toContain('**FL**');
      } finally {
        await fresh.close();
      }
    } finally {
      await exec('UPDATE workspaces SET api_access = true WHERE id = $1::uuid', [w.workspaces.w3.id]);
    }
  });
});

describe('roles', () => {
  it('a Viewer: reads work, writes are refused and change nothing', async () => {
    const v = await session(w.keys.vera!.key);
    try {
      expect(await v.ok('get_board', { board: 'RR' })).toContain('you: viewer');
      expect(await v.ok('get_task', { task: 'RR-1' })).toContain(`# RR-1: Secret plan ${w.run}`);
      expect(await v.ok('list_tasks', { board: 'RR' })).toContain('**RR-1**');
      const before = await ada.get(`/tasks/${w.tasks.RR1!.id}`);
      for (const [tool, args] of [
        ['create_task', { board: 'RR', title: 'nope' }],
        ['update_task', { task: 'RR-1', title: 'nope' }],
        ['move_task', { task: 'RR-1', list: 'Decided' }],
        ['archive_task', { task: 'RR-1' }],
        ['add_comment', { task: 'RR-1', text: 'nope' }],
        ['add_checklist_items', { task: 'RR-1', items: ['nope'] }],
        ['log_time', { task: 'RR-1', duration: '5m' }],
        ['start_timer', { task: 'RR-1' }],
        ['create_list', { board: 'RR', name: 'nope' }],
        ['create_label', { board: 'RR', name: 'nope' }],
      ] as const) {
        const t = await v.fail(tool, args);
        expect(t, tool).toMatch(tool === 'update_task' ? /✗ fields \(title\): You don't have permission/ : FORBIDDEN);
      }
      const after = await ada.get(`/tasks/${w.tasks.RR1!.id}`);
      expect(after).toMatchObject({ title: before.title, list_id: before.list_id, archived: false });
      expect(after.counts).toEqual(before.counts);
      expect((await ada.get(`/boards/${w.boards.RR.id}`)).lists).toHaveLength(2);
    } finally {
      await v.close();
    }
  });

  it('a guest: only their boards, no members or timesheets, no writes', async () => {
    const g = await session(w.keys.gus!.key);
    try {
      expect(await g.ok('whoami')).toContain(`default **${ws}**`);
      const boards = await g.ok('list_boards');
      expect(boards).toContain('**RR**');
      expect(boards).not.toMatch(/\*\*(MB|FL|BT|OB|TB)\*\*/);
      expect(await g.ok('search', { query: 'Due early' })).toMatch(/^Nothing found/);
      expect(await g.ok('list_tasks', {})).not.toContain('FL-');
      expect(await g.ok('list_tasks', {})).toContain('**RR-1**');
      expect(await g.fail('get_board', { board: 'FL' })).toMatch(
        /^No board "FL" in workspace .+, or you have no access/,
      );
      expect(await g.fail('get_task', { task: w.tasks.FL1!.id })).toMatch(NOT_FOUND);
      expect(await g.fail('list_people')).toMatch(NOT_FOUND);
      expect(await g.fail('list_time_entries')).toMatch(NOT_FOUND);
      expect(await g.fail('create_task', { board: 'RR', title: 'nope' })).toMatch(FORBIDDEN);
      expect(await g.fail('add_comment', { task: 'RR-1', text: 'nope' })).toMatch(FORBIDDEN);
      expect(await g.fail('start_timer', { task: 'RR-1' })).toMatch(FORBIDDEN);
    } finally {
      await g.close();
    }
  });

  it('no access to a restricted board: 404 everywhere, nothing leaks through search, lists or links', async () => {
    const n = await session(w.keys.nina!.key);
    try {
      const secret = `Secret plan ${w.run}`;
      expect(await n.fail('get_board', { board: 'RR' })).toMatch(
        /^No board "RR" in workspace .+, or you have no access/,
      );
      expect(await n.fail('get_board', { board: w.boards.RR.id })).toMatch(NOT_FOUND);
      expect(await n.fail('get_task', { task: 'RR-1' })).toMatch(
        /^No task RR-1 in workspace .+, or you have no access/,
      );
      expect(await n.fail('get_task', { task: w.tasks.RR1!.id })).toMatch(NOT_FOUND);
      expect(await n.ok('search', { query: secret })).toMatch(/^Nothing found/);
      expect(await n.ok('search', { query: 'RR-1' })).toMatch(/^Nothing found/);
      expect(await n.ok('list_tasks', { query: 'Secret' })).toBe('No tasks match.');
      expect(await n.ok('list_boards')).not.toContain('**RR**');
      expect(await n.fail('list_labels', { board: w.boards.RR.id })).toMatch(NOT_FOUND);
      // FL-3 is linked to RR-1: Nina sees FL-3 but not the link
      const t = await n.ok('get_task', { task: 'FL-3' });
      expect(t).toContain('# FL-3:');
      expect(t).not.toContain('RR-1');
      expect(t).not.toContain(secret);
      expect(t).not.toContain('## Links');
      expect(JSON.stringify((await rest(w.keys.nina!.key).get(`/tasks/${w.tasks.FL3!.id}/links`)).data)).toBe('[]');
      // and can't link to it or write to it
      expect(await n.fail('link_tasks', { task: 'FL-1', kind: 'blocks', other_task: w.tasks.RR1!.id })).toMatch(
        NOT_FOUND,
      );
      expect(await n.fail('add_comment', { task: w.tasks.RR1!.id, text: 'x' })).toMatch(NOT_FOUND);
      expect(await n.fail('log_time', { task: w.tasks.RR1!.id, duration: '5m' })).toMatch(NOT_FOUND);
      expect(await n.ok('list_time_entries', { task: w.tasks.RR1!.id })).toBe('No time entries.');
      // the link is still there for Ada
      expect(await s.ok('get_task', { task: 'FL-3', workspace: ws })).toContain(`relates to **RR-1** ${secret}`);
    } finally {
      await n.close();
    }
  });

  it('an archived board is read-only', async () => {
    const before = await taskCount(w.boards.AS.id);
    expect(await s.ok('get_board', { board: 'AS', workspace: ws })).toMatch(/archived \(read-only\)/);
    expect(await s.ok('get_task', { task: 'AS-1', workspace: ws })).toContain('# AS-1: Shelved task');
    const archived = /^The board is archived and read-only\. Restore it in the app first\.$/;
    expect(await s.fail('create_task', { board: 'AS', workspace: ws, title: 'nope' })).toMatch(archived);
    expect(await s.fail('add_comment', { task: 'AS-1', workspace: ws, text: 'nope' })).toMatch(archived);
    expect(await s.fail('create_list', { board: 'AS', workspace: ws, name: 'nope' })).toMatch(archived);
    expect(await s.fail('log_time', { task: 'AS-1', workspace: ws, duration: '5m' })).toMatch(archived);
    expect(await taskCount(w.boards.AS.id)).toBe(before);
  });
});

describe('plans (cloud edition, or plans switched on)', () => {
  // the cloud edition through the app's test-only header where test hooks are on; plans are on in the instance anyway
  const cloud = () => recordingFetch(w.testHooks ? { 'x-sol2flow-edition': 'cloud' } : {});

  it("the plan doesn't include the API (plan_feature)", async () => {
    const p = await session(w.keys.pia!.key, cloud());
    try {
      const t = await p.fail('list_boards');
      expect(t).toMatch(/^The organization's plan doesn't include the REST API, which this MCP server uses\./);
      expect(t).toContain('Organization settings → Plan');
      expect(await p.fail('create_board', { name: 'nope' })).toMatch(/plan doesn't include the REST API/);
    } finally {
      await p.close();
    }
  });

  it('the daily API limit (plan_limit apiCalls): a clear answer, never retried', async () => {
    const f = cloud();
    const c = await session(w.keys.cap!.key, f);
    try {
      let text = '';
      for (let i = 0; i < 10 && !text; i++) {
        const r = await c.call('list_boards', { workspace: w.workspaces.cap.slug });
        if (r.isError) text = r.text;
      }
      expect(text).toMatch(
        /^The organization's plan allows 5 API requests per day and they are used up; the limit resets at midnight UTC \(in .+\)\.$/,
      );
      const boards = f.calls.filter((x) => x.path.startsWith(`/workspaces/${w.workspaces.cap.slug}/boards`));
      expect(boards.filter((x) => x.status === 429)).toHaveLength(1); // not retried
      expect(boards.filter((x) => x.status === 200)).toHaveLength(5);
      // a write too, without a retry
      const before = f.calls.length;
      expect(await c.fail('create_board', { workspace: w.workspaces.cap.slug, name: 'nope' })).toMatch(/used up/);
      expect(f.calls.slice(before).filter((x) => x.method === 'POST')).toHaveLength(1);
      const usage = await rows<{ count: number }>('SELECT count FROM api_usage WHERE organization_id = $1::uuid', [
        w.workspaces.cap.orgId,
      ]);
      expect(Number(usage[0]!.count)).toBeGreaterThan(5);
    } finally {
      await c.close();
    }
  });

  it('a past-due plan: reads work, changes are refused (plan_read_only)', async () => {
    const r = await session(w.keys.rod!.key, cloud());
    try {
      expect(await r.ok('list_boards')).toBe('No boards.');
      expect(await r.fail('create_board', { name: 'nope' })).toMatch(
        /^The organization's workspaces are read-only: its subscription is past due or has ended\./,
      );
      expect((await rest(w.keys.rod!.key).get(`/workspaces/${w.workspaces.ro.slug}/boards`)).data).toEqual([]);
    } finally {
      await r.close();
    }
  });
});

describe('rate limits (test hooks: the per-key limit lowered for one scope)', () => {
  it('rate_limited: a read waits and retries (Retry-After ≤ 10 s)', async (t) => {
    if (!w.testHooks) return t.skip();
    const f = recordingFetch({ 'x-e2e-rate-limit': `api=1/2@rl-read-${w.run}` });
    const r = await session(w.keys.limits!.key, f);
    try {
      expect(await r.ok('list_boards', { workspace: ws })).toContain('**FL**');
      expect(await r.ok('list_boards', { workspace: ws })).toContain('**FL**'); // refused once, then retried
      const statuses = f.calls.map((c) => c.status);
      expect(statuses[0]).toBe(200);
      expect(statuses).toContain(429);
      expect(statuses.at(-1)).toBe(200);
    } finally {
      await r.close();
    }
  });

  it('rate_limited with a long wait: a read answers at once with the time to wait', async (t) => {
    if (!w.testHooks) return t.skip();
    const f = recordingFetch({ 'x-e2e-rate-limit': `api=1/600@rl-long-${w.run}` });
    const r = await session(w.keys.limits!.key, f);
    try {
      await r.ok('list_boards', { workspace: ws });
      expect(await r.fail('list_boards', { workspace: ws })).toMatch(
        /^sol2flow's rate limit is reached \(per key: 600 requests per 10 minutes, at most 120 of them changes\)\. Try again in \d+ min\.$/,
      );
      expect(f.calls.map((c) => c.status)).toEqual([200, 429]);
    } finally {
      await r.close();
    }
  });

  it('rate_limited: a write is never retried, even with a short Retry-After', async (t) => {
    if (!w.testHooks) return t.skip();
    const f = recordingFetch({ 'x-e2e-rate-limit': `api-write=1/3@rl-write-${w.run}` });
    const r = await session(w.keys.limits!.key, f);
    const title = `rate limited ${w.run}`;
    try {
      await r.ok('create_task', { board: 'MB', workspace: ws, title });
      const before = f.calls.length;
      expect(await r.fail('create_task', { board: 'MB', workspace: ws, title })).toMatch(
        /^sol2flow's rate limit is reached .+ Try again in \d+ s\.$/,
      );
      const posts = f.calls.slice(before).filter((c) => c.method === 'POST');
      expect(posts).toEqual([{ method: 'POST', path: '/tasks', status: 429 }]);
      const found = (await ada.get(`/tasks?board_id=${w.boards.MB.id}&q=${encodeURIComponent(title)}`)).data;
      expect(found).toHaveLength(1);
    } finally {
      await r.close();
    }
  });
});
