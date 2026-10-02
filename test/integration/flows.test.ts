import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseBaseUrl, loadConfig, parseArgs } from '../../src/config.js';
import { checkKey } from '../../src/transports/stdio.js';
import { connect } from '../helpers.js';

/*
 * make test-integration (test/integration/run.sh): the tools against a real sol2flow (the app image on PostgreSQL 18)
 * with the keys seed.mjs created. The flows: create → update → comment → checklist → link → time → archive, and the
 * read-only key's refusal.
 */

const url = process.env.SOL2FLOW_URL ?? 'http://app:3000';
const full = process.env.IT_FULL_KEY ?? '';
const read = process.env.IT_READ_KEY ?? '';
const upstream = { url: normaliseBaseUrl(url).appUrl };

type Session = Awaited<ReturnType<typeof connect>>;
let s: Session;
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await s.call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.text;
};

beforeAll(async () => {
  expect(full, 'IT_FULL_KEY (run through make test-integration)').toMatch(/^sf_/);
  s = await connect(upstream, { apiKey: full });
});
afterAll(() => s?.close());

describe('against a real sol2flow', () => {
  let key = '';
  let other = '';

  it('whoami', async () => {
    const t = await ok('whoami');
    expect(t).toMatch(/You are MCP Tester \(@mcpit\)/);
    expect(t).toMatch(/default \*\*it\*\*/);
  });

  it('create a board and tasks', async () => {
    expect(await ok('create_board', { name: 'MCP Flows', lists: ['To do', 'Doing', 'Done'] })).toMatch(/with 3 list/);
    const created = await ok('create_task', {
      board: 'MCP Flows',
      title: 'First task',
      description: 'Some **markdown**',
      assignees: ['me'],
      due_date: '2026-12-01',
      estimate: '2h',
    });
    key = /^Created (\S+)/.exec(created)![1]!;
    other = /^Created (\S+)/.exec(
      await ok('create_task', { board: 'MCP Flows', list: 'Doing', title: 'Second task' }),
    )![1]!;
    expect(await ok('search', { query: key })).toContain(key);
  });

  it('update step by step, with a new label', async () => {
    const board = key.split('-')[0]!;
    await ok('create_label', { board, name: 'mcp', color: 'purple' });
    const t = await ok('update_task', {
      task: key,
      title: 'First task, renamed',
      add_labels: ['mcp'],
      list: 'Doing',
      due_date: null,
    });
    expect(t).toMatch(/✓ fields[\s\S]*✓ labels[\s\S]*✓ list/);
    const got = await ok('get_task', { task: key });
    expect(got).toMatch(/First task, renamed/);
    expect(got).toMatch(/List: Doing/);
    expect(got).toMatch(/Labels: mcp/);
    expect(got).toMatch(/Some \*\*markdown\*\*/);
    await ok('move_task', { task: key, before: other });
  });

  it('comment, checklist, links', async () => {
    await ok('add_comment', { task: key, text: 'A comment with `code`' });
    await ok('add_checklist_items', { task: key, items: ['one', 'two'] });
    await ok('update_checklist_item', { task: key, item: 'two', done: true });
    await ok('link_tasks', { task: key, kind: 'blocks', other_task: other });
    const got = await ok('get_task', { task: key });
    expect(got).toMatch(/## Checklist \(1\/2\)/);
    expect(got).toMatch(/blocks \*\*/);
    expect(got).toMatch(/A comment with `code`/);
    expect(await ok('unlink_tasks', { task: other, other_task: key })).toMatch(/Removed 1/);
  });

  it('time', async () => {
    expect(await ok('log_time', { task: key, duration: '45m', note: 'integration' })).toMatch(/Logged 45m/);
    expect(await ok('start_timer', { task: other })).toMatch(/Timer started/);
    expect(await ok('get_timer')).toMatch(/Timer running/);
    await ok('stop_timer');
    expect(await ok('list_time_entries', { task: key })).toMatch(/"integration"/);
  });

  it('archive: read-only until unarchived', async () => {
    await ok('archive_task', { task: key });
    const refused = await s.call('add_comment', { task: key, text: 'x' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/unarchive_task first/);
    await ok('unarchive_task', { task: key });
    await ok('add_comment', { task: key, text: 'back' });
  });

  it('the read-only key: reads work, writes are refused or hidden', async () => {
    const r = await connect(upstream, { apiKey: read });
    try {
      expect((await r.call('list_boards')).isError).toBe(false);
      const w = await r.call('create_task', { board: 'MCP Flows', title: 'nope' });
      expect(w.isError).toBe(true);
      expect(w.text).toMatch(/API key is read-only/);
    } finally {
      await r.close();
    }
    // stdio checks the key at start: from API 1.8 the read-only scope hides the writes
    const config = loadConfig({ SOL2FLOW_URL: url, SOL2FLOW_API_KEY: read }, parseArgs([]));
    const check = await checkKey(config);
    expect(check.unavailable).toBeUndefined();
    if (check.apiVersion) expect(check.readOnly).toBe(true);
  });
});
