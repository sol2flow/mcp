import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { session, world, type Session } from './mcp.js';
import { rest } from './rest.js';

/*
 * One realistic flow on a real sol2flow (test/integration/run.sh): create a board and tasks → update → comment →
 * checklist → link → time → archive, checking the app's state through the REST API after the writes. The per-tool
 * details are in tools.test.ts, references in refs.test.ts, permissions in permissions.test.ts, the transports in
 * transports.test.ts.
 */

const w = world();
const api = rest(w.keys.flows!.key);
let s: Session;

beforeAll(async () => {
  s = await session(w.keys.flows!.key, { defaultWorkspace: w.workspaces.w1.slug });
});
afterAll(() => s?.close());

describe('a flow against a real sol2flow', () => {
  let key = '';
  let other = '';
  let boardKey = '';

  it('whoami', async () => {
    const t = await s.ok('whoami');
    expect(t).toContain(`You are Ada Admin (@${w.users.ada!.username})`);
    expect(t).toContain(`default **${w.workspaces.w1.slug}**`);
  });

  it('create a board and tasks', async () => {
    const b = await s.ok('create_board', { name: 'Flow board', lists: ['To do', 'Doing', 'Done'] });
    expect(b).toMatch(/with 3 list/);
    boardKey = /\(([A-Z0-9]+)\) with/.exec(b)![1]!;
    const created = await s.ok('create_task', {
      board: boardKey,
      title: 'First task',
      description: 'Some **markdown**',
      assignees: ['me'],
      due_date: '2026-12-01',
      estimate: '2h',
    });
    key = /^Created (\S+)/.exec(created)![1]!;
    other = /^Created (\S+)/.exec(
      await s.ok('create_task', { board: boardKey, list: 'Doing', title: 'Second task' }),
    )![1]!;
    expect(await s.ok('search', { query: key })).toContain(key);
  });

  it('update step by step, with a new label', async () => {
    await s.ok('create_label', { board: boardKey, name: 'flow', color: 'purple' });
    const t = await s.ok('update_task', {
      task: key,
      title: 'First task, renamed',
      add_labels: ['flow'],
      list: 'Doing',
      due_date: null,
    });
    expect(t).toMatch(/✓ fields[\s\S]*✓ labels[\s\S]*✓ list/);
    const got = await s.ok('get_task', { task: key });
    expect(got).toMatch(/First task, renamed/);
    expect(got).toMatch(/List: Doing/);
    expect(got).toMatch(/Labels: flow/);
    expect(got).toMatch(/Some \*\*markdown\*\*/);
    await s.ok('move_task', { task: key, before: other });
  });

  it('comment, checklist, links', async () => {
    await s.ok('add_comment', { task: key, text: 'A comment with `code`' });
    await s.ok('add_checklist_items', { task: key, items: ['one', 'two'] });
    await s.ok('update_checklist_item', { task: key, item: 'two', done: true });
    await s.ok('link_tasks', { task: key, kind: 'blocks', other_task: other });
    const got = await s.ok('get_task', { task: key });
    expect(got).toMatch(/## Checklist \(1\/2\)/);
    expect(got).toMatch(/blocks \*\*/);
    expect(got).toMatch(/A comment with `code`/);
    expect(await s.ok('unlink_tasks', { task: other, other_task: key })).toMatch(/Removed 1/);
  });

  it('time', async () => {
    expect(await s.ok('log_time', { task: key, duration: '45m', note: 'integration' })).toMatch(/Logged 45m/);
    expect(await s.ok('start_timer', { task: other })).toMatch(/Timer started/);
    expect(await s.ok('get_timer')).toMatch(/Timer running/);
    await s.ok('stop_timer');
    expect(await s.ok('list_time_entries', { task: key })).toMatch(/"integration"/);
  });

  it('archive: read-only until unarchived', async () => {
    await s.ok('archive_task', { task: key });
    expect(await s.fail('add_comment', { task: key, text: 'x' })).toMatch(/unarchive_task first/);
    await s.ok('unarchive_task', { task: key });
    await s.ok('add_comment', { task: key, text: 'back' });
  });

  it('the app has it all (REST)', async () => {
    const found = await api.get(`/workspaces/${w.workspaces.w1.slug}/search?q=${key}`);
    const id = found.tasks.find((t: { key: string }) => t.key === key).id;
    const t = await api.get(`/tasks/${id}?format=markdown`);
    expect(t).toMatchObject({ title: 'First task, renamed', due_date: null, archived: false });
    expect(t.list.name).toBe('Doing');
    expect(t.labels.map((l: { name: string }) => l.name)).toEqual(['flow']);
    expect(t.counts).toMatchObject({ comments: 2, checklist: 2, checklist_done: 1 });
    const entries = await api.get(`/time-entries?workspace=${w.workspaces.w1.slug}&task_id=${id}`);
    expect(entries.data.map((e: { duration_sec: number }) => e.duration_sec)).toEqual([2700]);
  });
});
