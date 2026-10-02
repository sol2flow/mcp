import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/index.js';
import { FakeApi, KEYS } from '../fake-api/server.js';
import { clearCache, connect } from '../helpers.js';

const fake = new FakeApi();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  clearCache();
  fake.requests = [];
  fake.version = '1.8.0';
});

describe('tools/list', () => {
  it('lists 32 tools with annotations, without calling the API', async () => {
    const c = await connect(fake);
    const { tools } = await c.client.listTools();
    await c.close();
    expect(tools).toHaveLength(32);
    expect(fake.requests).toHaveLength(0);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(t.description).toMatch(/^sol2flow: /);
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_task!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.archive_task!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.create_task!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName.create_task!.inputSchema.required).toEqual(expect.arrayContaining(['board', 'title']));
  });

  it('read-only mode hides every write tool', async () => {
    const c = await connect(fake, { readOnly: true });
    const { tools } = await c.client.listTools();
    await c.close();
    const reads = TOOLS.filter((t) => t.scope === 'read').map((t) => t.name);
    expect(tools.map((t) => t.name).sort()).toEqual(reads.sort());
    expect(reads).toHaveLength(13);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('offers the prompts', async () => {
    const c = await connect(fake);
    const { prompts } = await c.client.listPrompts();
    const p = await c.client.getPrompt({ name: 'board_standup', arguments: { board: 'PRD' } });
    await c.close();
    expect(prompts.map((x) => x.name)).toEqual(['plan_my_day', 'board_standup']);
    expect(JSON.stringify(p.messages)).toContain('get_board');
  });
});

describe('tool calls', () => {
  it('whoami shows the key and the version (1.8) or says it needs 1.8', async () => {
    let c = await connect(fake);
    let r = await c.call('whoami');
    await c.close();
    expect(r.text).toMatch(/You are Ana Lima \(@ana\)/);
    expect(r.text).toMatch(/API key "Test key" \(sf_Full0001…\): full access, never expires/);
    expect(r.text).toMatch(/API 1\.8\.0/);
    expect(r.text).toMatch(/default \*\*acme\*\*/);

    // answered from cache alone (no request): the version seen before still shows, also in JSON
    c = await connect(fake);
    fake.requests = [];
    r = await c.call('whoami');
    const j = JSON.parse((await c.call('whoami', { response_format: 'json' })).text);
    await c.close();
    expect(fake.requests).toHaveLength(0);
    expect(r.text).toMatch(/API 1\.8\.0/);
    expect(j.api_version).toBe('1.8.0');

    fake.version = null;
    clearCache();
    c = await connect(fake);
    r = await c.call('whoami');
    await c.close();
    expect(r.text).toMatch(/details need sol2flow 1\.8 or later/);
    expect(r.text).toMatch(/1\.7 or older/);
  });

  it('a task: get by key, create, update step by step, move, comment, checklist, link, archive', async () => {
    const c = await connect(fake);
    try {
      const got = await c.call('get_task', { task: 'PRD-2' });
      expect(got.text).toMatch(/^# PRD-2: Fix login redirect/);
      expect(got.text).toMatch(/Due: 2026-10-05/);

      const created = await c.call('create_task', {
        board: 'PRD',
        list: 'doing',
        title: 'Ship the MCP server',
        labels: ['feature'],
        assignees: ['me', '@ben'],
        due_date: '2026-10-09',
        description: '**Bold** plan',
      });
      expect(created.text).toMatch(/^Created PRD-4 "Ship the MCP server" in Doing/);
      const t = fake.task('PRD-4');
      expect(t.assignees).toEqual([fake.users.ana!.id, fake.users.ben!.id]);
      expect(fake.requests.find((r) => r.method === 'POST' && r.path === '/tasks')!.body).toMatchObject({
        format: 'markdown',
      });

      const upd = await c.call('update_task', {
        task: 'PRD-4',
        title: 'Ship it',
        due_date: null,
        add_labels: ['bug'],
        remove_assignees: ['ben'],
        list: 'Done',
      });
      expect(upd.isError).toBe(false);
      expect(upd.text).toMatch(/✓ fields \(title, due_date\)\n✓ labels \(2\)\n✓ assignees \(1\)\n✓ list/);
      expect(t.due_date).toBeNull();
      expect(t.assignees).toEqual([fake.users.ana!.id]);

      expect((await c.call('move_task', { task: 'PRD-4', list: 'To do', position: 'top' })).text).toMatch(/at the top/);
      const todo = fake.tasks
        .filter((x) => x.list_id === fake.boards[0]!.lists[0]!.id)
        .sort((a, b) => (a.position < b.position ? -1 : 1));
      expect(todo[0]!.number).toBe(4);
      expect((await c.call('move_task', { task: 'PRD-4', after: 'PRD-2' })).isError).toBe(false);

      expect((await c.call('add_comment', { task: 'PRD-4', text: 'Looks good' })).text).toMatch(/^Commented on PRD-4/);
      expect((await c.call('add_checklist_items', { task: 'PRD-4', items: ['Docs', 'Release'] })).text).toMatch(
        /Added 2/,
      );
      expect((await c.call('update_checklist_item', { task: 'PRD-4', item: '2', done: true })).text).toMatch(
        /ticked: "Release"/,
      );
      expect((await c.call('link_tasks', { task: 'PRD-4', kind: 'blocked_by', other_task: 'PRD-2' })).text).toMatch(
        /PRD-4 blocked by PRD-2/,
      );
      expect((await c.call('link_tasks', { task: 'PRD-2', kind: 'blocks', other_task: 'PRD-4' })).text).toMatch(
        /already linked/,
      );
      expect((await c.call('get_task', { task: 'PRD-4' })).text).toMatch(
        /## Checklist \(1\/2\)[\s\S]*## Links\n- blocked by \*\*PRD-2\*\*[\s\S]*Looks good/,
      );
      expect((await c.call('unlink_tasks', { task: 'PRD-4', other_task: 'PRD-2' })).text).toMatch(/Removed 1 link/);

      expect((await c.call('archive_task', { task: 'PRD-4' })).text).toMatch(/Archived PRD-4/);
      const refused = await c.call('add_comment', { task: 'PRD-4', text: 'x' });
      expect(refused).toEqual({ isError: true, text: expect.stringMatching(/unarchive_task first/) });
      expect((await c.call('unarchive_task', { task: 'PRD-4' })).text).toMatch(/back in/);
    } finally {
      await c.close();
    }
  });

  it('a failed step stops the update and says what was applied', async () => {
    const c = await connect(fake);
    fake.inject.set('PUT /tasks/{taskId}/labels', {
      status: 409,
      body: { error: { code: 'label_scope', message: 'x' } },
      times: 1,
    });
    const r = await c.call('update_task', {
      task: 'PRD-3',
      title: 'Onboarding guide',
      labels: ['bug'],
      assignees: ['me'],
    });
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(
      /✓ fields \(title\)\n✗ labels \(1\): That label belongs to another board[\s\S]*– assignees \(1\): not attempted/,
    );
  });

  it('a bad name fails before anything is changed', async () => {
    const c = await connect(fake);
    const r = await c.call('update_task', { task: 'PRD-3', title: 'x', labels: ['nope'] });
    await c.close();
    expect(r.text).toMatch(/Unknown label on this board: "nope"/);
    expect(fake.requests.some((q) => q.method !== 'GET')).toBe(false);
  });

  it('time: log, timer, list', async () => {
    const c = await connect(fake);
    try {
      expect((await c.call('log_time', { task: 'PRD-2', duration: '1h30m', note: 'review' })).text).toMatch(
        /^Logged 1h 30m on PRD-2/,
      );
      expect((await c.call('log_time', { task: 'PRD-2', duration: 'a while' })).text).toMatch(
        /Can't read the duration/,
      );
      expect((await c.call('start_timer', { task: 'PRD-1' })).text).toMatch(/Timer started on PRD-1/);
      expect((await c.call('get_timer')).text).toMatch(/Timer running on \*\*PRD-1\*\*/);
      expect((await c.call('stop_timer')).text).toMatch(/15m logged/);
      expect((await c.call('list_time_entries', { user: 'me' })).text).toMatch(/PRD-2.*1h 30m.*"review"/);
    } finally {
      await c.close();
    }
  });

  it('read tools: boards, search, list_tasks filters, labels, people, notifications, invitations', async () => {
    const c = await connect(fake);
    try {
      expect((await c.call('list_workspaces')).text).toMatch(/\*\*acme\*\*: Acme/);
      expect((await c.call('list_boards')).text).toMatch(/\*\*PRD\*\* Product/);
      expect((await c.call('get_board', { board: 'PRD' })).text).toMatch(/## To do \(\d+\)\n- \*\*PRD-/);
      expect((await c.call('search', { query: 'login' })).text).toMatch(
        /\*\*PRD-2\*\* Fix login redirect · Product · To do/,
      );
      const mine = await c.call('list_tasks', { assignee: ['me'], label: ['bug'] });
      expect(mine.text).toMatch(/PRD-2/);
      expect(mine.text).not.toMatch(/PRD-1\b/);
      expect((await c.call('list_tasks', { board: 'PRD', list: 'To do', response_format: 'json' })).text).toMatch(
        /^\{/,
      );
      expect((await c.call('list_labels', { board: 'PRD' })).text).toMatch(/feature \(blue, board label\)/);
      expect((await c.call('list_people', { query: 'ben' })).text).toMatch(/Ben Okafor \(@ben\)/);
      expect((await c.call('list_notifications', { unread_only: true })).text).toMatch(/\*\*unread\*\* · assigned/);
      expect((await c.call('list_my_invitations')).text).toMatch(/Beta \(beta\)/);
    } finally {
      await c.close();
    }
  });

  it('a read-only key gets a clear refusal for writes', async () => {
    const c = await connect(fake, { apiKey: KEYS.read });
    const r = await c.call('add_comment', { task: 'PRD-2', text: 'hi' });
    await c.close();
    expect(r).toEqual({
      isError: true,
      text: expect.stringMatching(/API key is read-only, so add_comment can't change anything/),
    });
  });

  it('no key, or a key refused at start: every tool says what to do', async () => {
    let c = await connect(fake, { apiKey: undefined });
    let r = await c.call('whoami');
    await c.close();
    expect(r.text).toMatch(/No sol2flow API key is configured.*SOL2FLOW_API_KEY/);
    c = await connect(fake, { unavailable: () => 'refused at start' });
    r = await c.call('get_task', { task: 'PRD-1' });
    await c.close();
    expect(r).toEqual({ isError: true, text: 'refused at start' });
    expect(fake.requests).toHaveLength(0);
  });

  it('an instance without an endpoint is "too old"', async () => {
    fake.inject.set('GET /me/invitations', {
      status: 404,
      body: { error: { code: 'not_found', message: 'No such endpoint. See /api/v1/openapi.json.' } },
    });
    fake.version = null;
    const c = await connect(fake);
    const r = await c.call('list_my_invitations');
    await c.close();
    fake.inject.clear();
    expect(r.text).toMatch(/too old for list_my_invitations/);
  });

  it('invalid arguments are refused by the schema', async () => {
    const c = await connect(fake);
    const r = await c.call('create_task', { board: 'PRD', title: '' });
    await c.close();
    expect(r.isError).toBe(true);
    expect(fake.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
  });
});
