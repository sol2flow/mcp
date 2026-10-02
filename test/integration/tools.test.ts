import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/tools/index.js';
import { session, world, type Session } from './mcp.js';
import { rest } from './rest.js';

/*
 * Every tool and both prompts against a real sol2flow, as Ada (admin of w1, w2, w3) with her `tools` key. After each
 * write the app's state is read back through the REST API, not taken from the tool's answer. The world: setup.ts.
 */

const w = world();
const ws = w.workspaces.w1.slug;
const api = rest(w.keys.tools!.key);
const used = new Set<string>();
let s: Session;

const keysIn = (text: string) => [...text.matchAll(/\*\*([A-Z0-9]+-\d+)\*\*/g)].map((m) => m[1]!);
const idsIn = (text: string) => [...text.matchAll(/<!-- id ([0-9a-f-]{36}) -->/g)].map((m) => m[1]!);
type T = { id: string; key: string; position: string; list_id: string; board_id: string };
const getTask = (id: string) => api.get(`/tasks/${id}?format=markdown`);
const idOf = async (key: string) => {
  const r = await api.get(`/workspaces/${ws}/search?q=${encodeURIComponent(key)}`);
  return (r.tasks as T[]).find((t) => t.key === key)!.id;
};
const created = (text: string) => /^Created (\S+)/.exec(text)![1]!;
const listOrder = async (boardId: string, listId: string) =>
  ((await api.get(`/tasks?board_id=${boardId}&list_id=${listId}&limit=100`)).data as T[])
    .sort((a, b) => (a.position < b.position ? -1 : 1))
    .map((t) => t.key);

/** a session whose tool calls count for the coverage check at the end */
async function tracked(key: string) {
  const t = await session(key);
  const call = t.call;
  t.call = (name, args) => {
    used.add(name);
    return call(name, args);
  };
  return t;
}

beforeAll(async () => {
  s = await tracked(w.keys.tools!.key);
});
afterAll(() => s?.close());

describe('read tools', () => {
  it('whoami: the account, the key (1.8.0: scope, prefix, expiry), the API version, the workspaces', async () => {
    const t = await s.ok('whoami');
    expect(t).toContain(`You are Ada Admin (@${w.users.ada!.username}) · ${w.users.ada!.email} · time zone UTC.`);
    expect(t).toContain(`API key "it tools" (sf_${w.keys.tools!.prefix}…): full access, never expires.`);
    expect(t).toContain(`· API ${w.apiVersion}.`);
    expect(t).toMatch(/Workspaces \(3\): pass `workspace`/);
    for (const k of ['w1', 'w2', 'w3'] as const) expect(t).toContain(`**${w.workspaces[k].slug}**`);
    const j = JSON.parse(await s.ok('whoami', { response_format: 'json' }));
    expect(j.api_version).toBe(w.apiVersion);
    expect(j.me.api_key).toEqual({
      name: 'it tools',
      prefix: `sf_${w.keys.tools!.prefix}`,
      scope: 'full',
      expires_at: null,
    });
    // a read-only key with an expiry date
    const r = await session(w.keys.read!.key);
    expect(await r.ok('whoami')).toContain(`API key "it read" (sf_${w.keys.read!.prefix}…): read-only, never expires.`);
    await r.close();
    const e = await session(w.keys.expiring!.key);
    expect(await e.ok('whoami')).toMatch(/full access, expires 2099-01-01\./);
    await e.close();
  });

  it('list_workspaces', async () => {
    const t = await s.ok('list_workspaces');
    for (const k of ['w1', 'w2', 'w3'] as const)
      expect(t).toContain(`- **${w.workspaces[k].slug}**: Workspace ${w.workspaces[k].slug} (you: admin`);
    expect(t).not.toContain(w.workspaces.noapi.slug);
  });

  it('list_boards: live, archived, query, paging', async () => {
    const t = await s.ok('list_boards', { workspace: ws });
    expect(keysOfBoards(t)).toEqual(expect.arrayContaining(['MB', 'FL', 'BT', 'RR', 'OB', 'TB']));
    expect(t).not.toContain('**AS**');
    expect(t).toContain('- **BT** Bulk tasks · 60 tasks · you: admin');
    expect(keysOfBoards(await s.ok('list_boards', { workspace: ws, archived: true }))).toEqual(['AS']);
    expect(keysOfBoards(await s.ok('list_boards', { workspace: ws, query: 'twin' }))).toEqual(['TB']);
    const p1 = await s.ok('list_boards', { workspace: ws, limit: 2 });
    const cursor = /cursor: "([^"]+)"/.exec(p1)![1]!;
    const p2 = await s.ok('list_boards', { workspace: ws, limit: 2, cursor });
    expect(keysOfBoards(p1)).toHaveLength(2);
    expect(keysOfBoards(p2)).toHaveLength(2);
    expect(keysOfBoards(p1).some((k) => keysOfBoards(p2).includes(k))).toBe(false);
  });

  it('get_board: lists in order, every task of a 60-task list (paged upstream), lists only', async () => {
    const t = await s.ok('get_board', { board: 'BT', workspace: ws });
    expect(t).toContain('# Bulk tasks (BT)');
    expect(t).toContain('## Many (60)');
    expect(t).toContain('## Few (0)');
    const keys = keysIn(t);
    expect(keys).toHaveLength(60);
    expect(keys[0]).toBe('BT-1');
    expect(keys[59]).toBe('BT-60');
    // JSON: within the output limit, the tasks are cut and it says so (the rest: list_tasks)
    const j = JSON.parse(await s.ok('get_board', { board: 'BT', workspace: ws, response_format: 'json' }));
    expect(j).toMatchObject({ key: 'BT', more_tasks: false, truncated: { field: 'tasks', total: 60 } });
    expect(j.tasks.length).toBe(j.truncated.shown);
    expect(j.lists.map((l: { name: string }) => l.name)).toEqual(['Many', 'Few']);
    const lists = await s.ok('get_board', { board: 'BT', workspace: ws, include_tasks: false });
    expect(keysIn(lists)).toEqual([]);
    expect(lists).toContain('## Many (60)');
  });

  it('search: tasks and boards, one workspace or all', async () => {
    expect(await s.ok('search', { query: `Secret plan ${w.run}`, workspace: ws })).toContain('**RR-1**');
    const all = await s.ok('search', { query: 'Twin' });
    expect(all).toContain(`# ${w.workspaces.w1.slug}`);
    expect(all).toContain(`# ${w.workspaces.w2.slug}`);
    expect(await s.ok('search', { query: 'FL-2', workspace: ws })).toContain('**FL-2** Due late');
    expect(await s.ok('search', { query: 'nothing-like-this', workspace: ws })).toMatch(/^Nothing found/);
  });

  it('list_tasks: every filter', async () => {
    const q = (a: Record<string, unknown>) => s.ok('list_tasks', { workspace: ws, board: 'FL', ...a }).then(keysIn);
    expect((await q({})).sort()).toEqual(['FL-1', 'FL-2', 'FL-3']);
    expect((await q({ include_archived: true })).sort()).toEqual(['FL-1', 'FL-2', 'FL-3', 'FL-4']);
    expect((await q({ assignee: ['me'] })).sort()).toEqual(['FL-1', 'FL-2']);
    expect(await q({ assignee: [w.users.bob!.username] })).toEqual(['FL-2']);
    expect(await q({ assignee: ['@' + w.users.bob!.username] })).toEqual(['FL-2']);
    expect(await q({ assignee: ['Bob Member'] })).toEqual(['FL-2']);
    expect(await q({ label: ['Bug'] })).toEqual(['FL-1']);
    expect((await q({ label: ['bug', 'Feature'] })).sort()).toEqual(['FL-1', 'FL-2']);
    expect(await q({ due_after: '2026-12-01' })).toEqual(['FL-2']);
    expect(await q({ due_before: '2026-11-30' })).toEqual(['FL-1']);
    expect(await q({ due_after: '2026-10-01', due_before: '2026-12-31' })).toHaveLength(2);
    expect(await q({ list: 'Closed' })).toEqual(['FL-3']);
    expect(await q({ list: 'Closed', include_archived: true })).toEqual(expect.arrayContaining(['FL-3', 'FL-4']));
    expect(await q({ query: 'late' })).toEqual(['FL-2']);
    const line = await s.ok('list_tasks', { workspace: ws, board: 'FL', label: ['Bug'] });
    expect(line).toContain(`- **FL-1** Due early · in Open · due 2026-11-01 · @${w.users.ada!.username} [Bug]`);
    // updated_since: only what changed
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await api.patch(`/tasks/${w.tasks.FL3!.id}`, { title: 'No due date (touched)' });
    expect(await q({ updated_since: since })).toEqual(['FL-3']);
    // the whole workspace, no board
    expect(keysIn(await s.ok('list_tasks', { workspace: ws, query: 'Due early' }))).toEqual(['FL-1']);
    // workspace labels need no board; board labels do
    expect(await s.fail('list_tasks', { workspace: ws, label: ['Bug'] })).toMatch(/No workspace label "Bug"/);
    expect(await s.fail('list_tasks', { workspace: ws, list: 'Open' })).toMatch(/`list` needs `board`/);
  });

  it('list_tasks: cursor paging through 60 tasks', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const t = await s.ok('list_tasks', { workspace: ws, board: 'BT', limit: 25, ...(cursor ? { cursor } : {}) });
      seen.push(...keysIn(t));
      cursor = /cursor: "([^"]+)"/.exec(t)?.[1];
    } while (cursor);
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });

  it('get_task: description, checklist, comments with replies, links, attachments', async () => {
    const t = await s.ok('get_task', { task: 'FL-1', workspace: ws });
    expect(t).toContain('# FL-1: Due early');
    expect(t).toContain('- List: Open');
    expect(t).toContain(`- Assignees: @${w.users.ada!.username}`);
    expect(t).toContain('- Labels: Bug');
    expect(t).toContain('- Due: 2026-11-01');
    expect(t).toMatch(/## Checklist \(0\/2\)\n1\. \[ \] first step <!-- id [0-9a-f-]+ -->\n2\. \[ \] second step/);
    expect(t).toMatch(/## Comments \(3\)/);
    expect(t).toContain('Top **level** comment');
    expect(t).toMatch(/\n {2}- Ada Admin, [^\n]+\n {4}A reply/); // the reply, indented under its comment
    expect(t).toContain('Please look @[Ada Admin]');
    expect(t).toContain('_1 attachment(s): open the task in the app._');
    expect(await s.ok('get_task', { task: 'FL-3', workspace: ws })).toContain(
      `- relates to **RR-1** Secret plan ${w.run}`,
    );
    const few = await s.ok('get_task', { task: 'FL-1', workspace: ws, comments: 1 });
    expect(few).toMatch(/## Comments \(3, newest 1 shown\)/);
    expect(await s.ok('get_task', { task: 'FL-1', workspace: ws, comments: 0 })).not.toContain('## Comments');
    const j = JSON.parse(await s.ok('get_task', { task: 'FL-1', workspace: ws, response_format: 'json' }));
    expect(j.counts).toMatchObject({ attachments: 1, checklist: 2, comments: 3 });
  });

  it('list_labels: board and workspace', async () => {
    const t = await s.ok('list_labels', { board: 'FL', workspace: ws });
    expect(t).toContain('- Bug (red, board label)');
    expect(t).toContain('- Feature (blue, board label)');
    expect(await s.ok('list_labels', { workspace: ws })).not.toContain('Bug');
  });

  it('list_people: members, role filter, query', async () => {
    const t = await s.ok('list_people', { workspace: ws });
    for (const u of ['ada', 'bob', 'vera', 'gus', 'nina']) expect(t).toContain(`(@${w.users[u]!.username})`);
    expect(t).toContain(`- Gus Guest (@${w.users.gus!.username}) · guest`);
    expect(t).not.toContain('@example.com'); // other people come without emails
    const guests = await s.ok('list_people', { workspace: ws, role: 'GUEST' });
    expect(guests.trim().split('\n')).toHaveLength(1);
    expect(await s.ok('list_people', { workspace: ws, query: 'vera' })).toContain('Vera Viewer');
  });

  it('get_timer, list_notifications, list_my_invitations', async () => {
    expect(await s.ok('get_timer')).toBe('No timer is running.');
    const n = await s.ok('list_notifications');
    expect(n).toMatch(/mention/);
    expect(n).toMatch(/assign/);
    expect(n).toContain('by Bob Member');
    expect(idsIn(await s.ok('list_notifications', { unread_only: true })).length).toBeGreaterThanOrEqual(2);
    expect(await s.ok('list_my_invitations')).toMatch(/^No pending invitations/);
    const cleo = await session(w.keys.cleo!.key);
    const inv = await cleo.ok('list_my_invitations');
    expect(inv).toContain(`(${w.workspaces.w1.slug})`);
    expect(inv).toContain(`(${w.workspaces.w2.slug})`);
    expect(inv).toContain(`id ${w.invitations.w1}`);
    expect(inv).toContain('from Ada Admin');
    await cleo.close();
  });
});

describe('write tools (each checked through the REST API)', () => {
  let a = '',
    b = '',
    c = '';

  it('create_board, create_list, create_label', async () => {
    const t = await s.ok('create_board', {
      workspace: ws,
      name: 'Tool shed',
      lists: ['Backlog', 'Doing'],
      access: 'RESTRICTED',
      default_role: 'VIEWER',
    });
    expect(t).toMatch(/^Created board Tool shed \(TS\) with 2 list\(s\): Backlog, Doing\./);
    const board = (await api.get(`/workspaces/${ws}/boards?q=Tool%20shed`)).data[0];
    const detail = await api.get(`/boards/${board.id}`);
    expect(detail).toMatchObject({ key: 'TS', access: 'RESTRICTED', role: 'ADMIN' });
    expect(await s.ok('create_list', { board: 'TS', workspace: ws, name: 'Done' })).toMatch(/^Added list "Done"/);
    expect((await api.get(`/boards/${board.id}`)).lists.map((l: { name: string }) => l.name)).toEqual([
      'Backlog',
      'Doing',
      'Done',
    ]);
    const l1 = await s.ok('create_label', { board: 'TS', workspace: ws, name: 'urgent', color: 'red' });
    expect(l1).toMatch(/^Label "urgent" \(red, board label\) is ready/);
    const l2 = await s.ok('create_label', { board: 'TS', workspace: ws, name: 'Urgent' });
    expect(idOfLabel(l2)).toBe(idOfLabel(l1));
    const labels = (await api.get(`/boards/${board.id}/labels`)).data;
    expect(labels.map((l: { name: string }) => l.name)).toEqual(['urgent']);
  });

  it('create_task with every field', async () => {
    await s.ok('create_label', { board: 'MB', workspace: ws, name: 'mcp', color: 'purple' });
    const t = await s.ok('create_task', {
      board: 'MB',
      workspace: ws,
      list: 'Doing',
      title: 'Everything set',
      description: '# Plan\n\n- **bold** item\n- [link](https://example.com)',
      labels: ['mcp'],
      assignees: ['me', w.users.bob!.username],
      start_date: '2026-10-05',
      due_date: '2026-10-20',
      estimate: '2h',
      position: 'top',
    });
    expect(t).toMatch(/^Created MB-\d+ "Everything set" in Doing\. http/);
    const r = await getTask(await idOf(created(t)));
    expect(r).toMatchObject({
      title: 'Everything set',
      start_date: '2026-10-05',
      due_date: '2026-10-20',
      estimate_minutes: 120,
    });
    expect(r.list.name).toBe('Doing');
    expect(r.description_markdown).toContain('**bold** item');
    expect(r.description_markdown).toContain('[link](https://example.com)');
    expect(r.labels.map((l: { name: string }) => l.name)).toEqual(['mcp']);
    expect(r.assignees.map((u: { id: string }) => u.id).sort()).toEqual([w.users.ada!.id, w.users.bob!.id].sort());
    // position top: first in Doing
    expect((await listOrder(w.boards.MB.id, w.boards.MB.lists.Doing!))[0]).toBe(created(t));
    // the first list by default
    const d = await s.ok('create_task', { board: 'MB', workspace: ws, title: 'Defaults' });
    expect(d).toMatch(/ in To do\./);
  });

  it('update_task: each field on its own', async () => {
    const key = created(await s.ok('create_task', { board: 'MB', workspace: ws, title: 'To update' }));
    const id = await idOf(key);
    const up = (a: Record<string, unknown>) => s.ok('update_task', { task: key, workspace: ws, ...a });
    expect(await up({ title: 'Updated title' })).toMatch(
      /^Updated MB-\d+ "Updated title" \(in To do\):\n✓ fields \(title\)$/,
    );
    expect((await getTask(id)).title).toBe('Updated title');
    await up({ description: 'Now with *emphasis*' });
    expect((await getTask(id)).description_markdown).toMatch(/[*_]emphasis[*_]/);
    await up({ description: null });
    expect((await getTask(id)).description_text ?? '').toBe('');
    await up({ start_date: '2026-11-02', due_date: '2026-11-09' });
    expect(await getTask(id)).toMatchObject({ start_date: '2026-11-02', due_date: '2026-11-09' });
    await up({ due_date: null, start_date: null });
    expect(await getTask(id)).toMatchObject({ start_date: null, due_date: null });
    await up({ estimate: '1d' });
    expect((await getTask(id)).estimate_minutes).toBe(480);
    await up({ estimate: null });
    expect((await getTask(id)).estimate_minutes).toBeNull();
    const labelNames = async () => (await getTask(id)).labels.map((l: { name: string }) => l.name).sort();
    await s.ok('create_label', { board: 'MB', workspace: ws, name: 'second', color: 'green' });
    expect(await up({ labels: ['mcp'] })).toContain('✓ labels (1)');
    expect(await labelNames()).toEqual(['mcp']);
    await up({ add_labels: ['second'] });
    expect(await labelNames()).toEqual(['mcp', 'second']);
    await up({ remove_labels: ['mcp'] });
    expect(await labelNames()).toEqual(['second']);
    const people = async () => (await getTask(id)).assignees.map((u: { id: string }) => u.id).sort();
    await up({ assignees: ['me'] });
    expect(await people()).toEqual([w.users.ada!.id]);
    await up({ add_assignees: ['Bob Member'] });
    expect(await people()).toEqual([w.users.ada!.id, w.users.bob!.id].sort());
    await up({ remove_assignees: ['me'] });
    expect(await people()).toEqual([w.users.bob!.id]);
    expect(await up({ list: 'Done' })).toContain('✓ list');
    expect((await getTask(id)).list.name).toBe('Done');
    expect(await s.fail('update_task', { task: key, workspace: ws })).toMatch(/Nothing to change/);
  });

  it('update_task: a failed step stops the rest and the answer says what was applied', async () => {
    const key = created(await s.ok('create_task', { board: 'MB', workspace: ws, title: 'Half applied' }));
    const id = await idOf(key);
    const t = await s.fail('update_task', {
      task: key,
      workspace: ws,
      title: 'Half applied, renamed',
      assignees: [w.users.pia!.id], // not in the workspace: the API refuses
      list: 'Done',
    });
    expect(t).toMatch(
      /^Update: stopped at a failed step\.\n✓ fields \(title\)\n✗ assignees \(1\): .+\n– list: not attempted$/,
    );
    const r = await getTask(id);
    expect(r.title).toBe('Half applied, renamed');
    expect(r.list.name).toBe('To do');
    expect(r.assignees).toEqual([]);
    // a bad name fails before anything is changed
    expect(await s.fail('update_task', { task: key, workspace: ws, title: 'nope', labels: ['no such label'] })).toMatch(
      /Unknown label on this board: "no such label"/,
    );
    expect((await getTask(id)).title).toBe('Half applied, renamed');
  });

  it('move_task: top, before, after, another list, another board', async () => {
    const make = async (title: string) =>
      created(await s.ok('create_task', { board: 'MB', workspace: ws, list: 'Done', title }));
    a = await make('Move A');
    b = await make('Move B');
    c = await make('Move C');
    const done = () =>
      listOrder(w.boards.MB.id, w.boards.MB.lists.Done!).then((o) => o.filter((k) => [a, b, c].includes(k)));
    expect(await done()).toEqual([a, b, c]);
    expect(await s.ok('move_task', { task: c, workspace: ws, position: 'top' })).toBe(
      `Moved ${c} to Done, at the top.`,
    );
    expect((await listOrder(w.boards.MB.id, w.boards.MB.lists.Done!))[0]).toBe(c);
    await s.ok('move_task', { task: a, workspace: ws, after: b });
    expect(await done()).toEqual([c, b, a]);
    await s.ok('move_task', { task: b, workspace: ws, before: c });
    expect(await done()).toEqual([b, c, a]);
    await s.ok('move_task', { task: b, workspace: ws, position: 'bottom' });
    expect(await done()).toEqual([c, a, b]);
    expect(await s.ok('move_task', { task: a, workspace: ws, list: 'Doing' })).toBe(
      `Moved ${a} to Doing, at the bottom.`,
    );
    expect((await getTask(await idOf(a))).list.name).toBe('Doing');
    expect(await s.fail('move_task', { task: a, workspace: ws, before: b })).toMatch(/isn't in list Doing/);
    expect(await s.fail('move_task', { task: a, workspace: ws, position: 'top', after: b })).toMatch(/only one of/);
    // another board: a new key; the old one still finds it
    const cId = await idOf(c);
    const m = await s.ok('move_task', { task: c, workspace: ws, board: 'OB', list: 'Later' });
    const newKey = /it is now (OB-\d+)/.exec(m)![1]!;
    const r = await getTask(cId);
    expect(r).toMatchObject({ key: newKey, board_id: w.boards.OB.id });
    expect(r.list.name).toBe('Later');
    expect(await s.ok('get_task', { task: c, workspace: ws })).toContain(`# ${newKey}: Move C`);
    expect(await s.fail('move_task', { task: newKey, workspace: ws, board: 'MB', before: a })).toMatch(
      /Across boards only position/,
    );
  });

  it('archive_task, unarchive_task', async () => {
    const id = await idOf(b);
    expect(await s.ok('archive_task', { task: b, workspace: ws })).toBe(
      `Archived ${b} "Move B". unarchive_task brings it back.`,
    );
    expect(await getTask(id)).toMatchObject({ archived: true });
    expect(await s.ok('get_task', { task: b, workspace: ws })).toMatch(/Archived \d{4}-\d\d-\d\d \(read-only/);
    expect(await s.ok('archive_task', { task: b, workspace: ws })).toMatch(/^Archived/); // idempotent
    expect(await s.ok('unarchive_task', { task: b, workspace: ws })).toBe(`Unarchived ${b} "Move B": back in Done.`);
    expect(await getTask(id)).toMatchObject({ archived: false });
  });

  it('add_comment: Markdown, a mention (notifies), a reply', async () => {
    const id = await idOf(a);
    const bob = w.users.bob!;
    const before = (await rest(w.keys.bob!.key).get('/notifications?unread=true&limit=100')).data.length;
    const t = await s.ok('add_comment', {
      task: a,
      workspace: ws,
      text: `Hello @[${bob.name}](user:${bob.id}), see **this** and \`code\``,
    });
    const commentId = /comment id ([0-9a-f-]+)/.exec(t)![1]!;
    const list = (await api.get(`/tasks/${id}/comments?format=markdown`)).data;
    const c0 = list.find((x: { id: string }) => x.id === commentId);
    expect(c0.markdown).toContain(`@[${bob.name}](user:${bob.id})`);
    expect(c0.markdown).toContain('**this**');
    const after = (await rest(w.keys.bob!.key).get('/notifications?unread=true&limit=100')).data;
    expect(after.length).toBeGreaterThan(before);
    expect(
      after.some((n: { type: string; task?: { key: string } }) => /mention/.test(n.type) && n.task?.key === a),
    ).toBe(true);
    const r = await s.ok('add_comment', { task: a, workspace: ws, text: 'a reply', reply_to: commentId });
    expect(r).toMatch(/^Replied on/);
    const again = (await api.get(`/tasks/${id}/comments?format=markdown`)).data;
    expect(
      again.find((x: { id: string }) => x.id === commentId).replies.map((x: { markdown: string }) => x.markdown.trim()),
    ).toEqual(['a reply']);
    expect(await s.fail('add_comment', { task: a, workspace: ws, text: 'x', reply_to: 'nope' })).toMatch(
      /reply_to must be/,
    );
  });

  it('add_checklist_items, update_checklist_item (by number, text, id)', async () => {
    const id = await idOf(a);
    expect(await s.ok('add_checklist_items', { task: a, workspace: ws, items: ['alpha', 'beta', 'gamma'] })).toBe(
      `Added 3 checklist item(s) to ${a}.`,
    );
    const items = async () =>
      ((await getTask(id)).checklist as { id: string; text: string; done: boolean; position: string }[]).sort((x, y) =>
        x.position < y.position ? -1 : 1,
      );
    expect((await items()).map((i) => i.text)).toEqual(['alpha', 'beta', 'gamma']);
    expect(await s.ok('update_checklist_item', { task: a, workspace: ws, item: '2', done: true })).toBe(
      'Checklist item ticked: "beta".',
    );
    await s.ok('update_checklist_item', { task: a, workspace: ws, item: 'gamma', text: 'gamma, edited' });
    const third = (await items())[2]!;
    await s.ok('update_checklist_item', { item: third.id, done: true });
    await s.ok('update_checklist_item', { task: a, workspace: ws, item: 'beta', done: false });
    expect((await items()).map((i) => [i.text, i.done])).toEqual([
      ['alpha', false],
      ['beta', false],
      ['gamma, edited', true],
    ]);
    expect(await s.fail('update_checklist_item', { task: a, workspace: ws, item: 'zzz', done: true })).toMatch(
      /No checklist item "zzz"/,
    );
    expect(await s.fail('update_checklist_item', { item: 'alpha', done: true })).toMatch(/`task` is needed/);
  });

  it('link_tasks / unlink_tasks: every kind, and the other side sees the inverse', async () => {
    const inverse = {
      blocks: 'blocked_by',
      blocked_by: 'blocks',
      relates_to: 'relates_to',
      duplicates: 'duplicated_by',
      duplicated_by: 'duplicates',
    } as const;
    const [aId, bId] = [await idOf(a), await idOf(b)];
    const links = async (id: string) =>
      ((await api.get(`/tasks/${id}/links`)).data as { kind: string; task: { id: string } }[]).map((l) => [
        l.kind,
        l.task.id,
      ]);
    for (const kind of Object.keys(inverse) as (keyof typeof inverse)[]) {
      expect(await s.ok('link_tasks', { task: a, kind, other_task: b, workspace: ws })).toBe(
        `Linked: ${a} ${kind.replace('_', ' ')} ${b}.`,
      );
      expect(await links(aId)).toEqual([[kind, bId]]);
      expect(await links(bId)).toEqual([[inverse[kind], aId]]);
      expect(await s.fail('link_tasks', { task: b, kind: inverse[kind], other_task: a, workspace: ws })).toMatch(
        /already linked/,
      );
      // the wrong kind removes nothing; the right one removes it
      const wrong = kind === 'relates_to' ? 'blocks' : 'relates_to';
      expect(await s.ok('unlink_tasks', { task: a, other_task: b, kind: wrong, workspace: ws })).toMatch(
        /aren't linked/,
      );
      expect(await s.ok('unlink_tasks', { task: a, other_task: b, kind, workspace: ws })).toBe(
        `Removed 1 link(s) between ${a} and ${b}.`,
      );
      expect(await links(aId)).toEqual([]);
    }
  });

  let entryId = '';
  it('log_time, update_time_entry, list_time_entries', async () => {
    const id = await idOf(a);
    const t = await s.ok('log_time', { task: a, workspace: ws, duration: '1h30m', note: 'pairing' });
    expect(t).toMatch(new RegExp(`^Logged 1h 30m on ${a} from .+ \\(entry id [0-9a-f-]+\\)\\.$`));
    entryId = /entry id ([0-9a-f-]+)/.exec(t)![1]!;
    const entries = async () => (await api.get(`/time-entries?workspace=${ws}&task_id=${id}`)).data;
    expect(await entries()).toEqual([expect.objectContaining({ id: entryId, duration_sec: 5400, note: 'pairing' })]);
    expect(await s.ok('update_time_entry', { entry_id: entryId, duration: '2h', note: 'pairing, longer' })).toMatch(
      /^Updated: .+ · 2h · Ada Admin · "pairing, longer"/,
    );
    expect(await entries()).toEqual([expect.objectContaining({ duration_sec: 7200, note: 'pairing, longer' })]);
    await s.ok('update_time_entry', { entry_id: entryId, note: null, started_at: '2026-09-01T08:00:00Z' });
    expect(await entries()).toEqual([expect.objectContaining({ note: null, started_at: '2026-09-01T08:00:00.000Z' })]);
    expect(await s.fail('log_time', { task: a, workspace: ws, duration: 'a while' })).toMatch(
      /Can't read the duration/,
    );
    expect(await s.fail('log_time', { task: a, workspace: ws, duration: '25h' })).toMatch(
      /between 1 minute and 24 hours/,
    );
    // the listing and its filters
    const l = await s.ok('list_time_entries', { workspace: ws, task: a });
    expect(l).toContain(`**${a}** · 2h · Ada Admin`);
    expect(l).toContain('Total on this page: 2h');
    expect(await s.ok('list_time_entries', { board: 'MB', workspace: ws, user: 'me' })).toContain(`**${a}**`);
    expect(await s.ok('list_time_entries', { workspace: ws, from: '2026-09-01', to: '2026-09-02' })).toContain(
      `**${a}**`,
    );
    expect(await s.ok('list_time_entries', { workspace: ws, from: '2026-09-02', to: '2026-09-03' })).toBe(
      'No time entries.',
    );
  });

  it('start_timer, switching tasks, get_timer, stop_timer', async () => {
    expect(await s.ok('start_timer', { task: a, workspace: ws })).toBe(`Timer started on ${a} "Move A".`);
    expect(await s.ok('get_timer')).toMatch(new RegExp(`^Timer running on \\*\\*${a}\\*\\* "Move A" since`));
    const sw = await s.ok('start_timer', { task: b, workspace: ws });
    expect(sw).toMatch(
      new RegExp(`^Timer started on ${b} "Move B"\\. Stopped the timer on ${a} \\(\\d+m logged\\)\\.$`),
    );
    expect((await api.get('/timer')).timer.task_key).toBe(b);
    expect(await s.ok('stop_timer')).toMatch(new RegExp(`^Stopped the timer on ${b}: \\d+m logged \\(entry id`));
    expect((await api.get('/timer')).timer).toBeNull();
    expect(await s.ok('stop_timer')).toBe('No timer was running.');
    expect(await s.ok('get_timer')).toBe('No timer is running.');
  });

  it('mark_notifications_read: some, then all', async () => {
    const unread = async () =>
      (await api.get('/notifications?unread=true&limit=100')).data.map((n: { id: string }) => n.id);
    const ids = idsIn(await s.ok('list_notifications', { unread_only: true }));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(await s.ok('mark_notifications_read', { ids: [ids[0]] })).toBe('Marked 1 notification(s) read.');
    expect(await unread()).not.toContain(ids[0]);
    expect(await unread()).toContain(ids[1]);
    expect(await s.ok('mark_notifications_read', { all: true })).toBe('All notifications marked read.');
    expect(await unread()).toEqual([]);
    expect(await s.ok('list_notifications', { unread_only: true })).toBe('No unread notifications.');
    expect(await s.fail('mark_notifications_read', {})).toMatch(/Pass `ids` or `all: true`/);
  });

  it('respond_to_invitation: accept and decline', async () => {
    const cleo = await tracked(w.keys.cleo!.key);
    const cleoApi = rest(w.keys.cleo!.key);
    try {
      expect(await cleo.ok('respond_to_invitation', { invitation_id: w.invitations.w1, response: 'accept' })).toMatch(
        new RegExp(`^Invitation accepted: you are in workspace .+ \\(${w.workspaces.w1.slug}\\) as member\\.`),
      );
      expect(await cleo.ok('respond_to_invitation', { invitation_id: w.invitations.w2, response: 'decline' })).toBe(
        'Invitation declined.',
      );
      const mine = (await cleoApi.get('/workspaces')).data.map((x: { slug: string }) => x.slug);
      expect(mine).toEqual([w.workspaces.w1.slug]);
      expect((await cleoApi.get('/me/invitations')).data).toEqual([]);
      // the accepted workspace is usable at once (the workspace cache was dropped)
      expect(await cleo.ok('list_boards')).toContain('**MB**');
      expect(await cleo.fail('respond_to_invitation', { invitation_id: w.invitations.w2, response: 'accept' })).toMatch(
        /Not found/,
      );
      expect(await cleo.fail('respond_to_invitation', { invitation_id: 'x', response: 'accept' })).toMatch(
        /invitation_id must be/,
      );
    } finally {
      await cleo.close();
    }
  });
});

describe('prompts', () => {
  it('plan_my_day and board_standup', async () => {
    const { prompts } = await s.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['board_standup', 'plan_my_day']);
    const p = await s.client.getPrompt({ name: 'plan_my_day', arguments: { workspace: ws } });
    expect((p.messages[0]!.content as { text: string }).text).toContain(`(workspace ${ws})`);
    const st = await s.client.getPrompt({ name: 'board_standup', arguments: { board: 'FL', since: '2026-10-01' } });
    const text = (st.messages[0]!.content as { text: string }).text;
    expect(text).toContain('board FL');
    expect(text).toContain('"2026-10-01"');
    // what the prompt asks for works
    expect(await s.ok('list_tasks', { board: 'FL', workspace: ws, updated_since: '2026-10-01T00:00:00Z' })).toContain(
      'FL-1',
    );
  });
});

describe('coverage', () => {
  it('every tool was called', () => {
    expect(TOOLS.map((t) => t.name).filter((n) => !used.has(n))).toEqual([]);
    expect(TOOLS).toHaveLength(32);
  });
});

function keysOfBoards(text: string) {
  return [...text.matchAll(/^- \*\*([A-Z0-9]+)\*\* /gm)].map((m) => m[1]!);
}
function idOfLabel(text: string) {
  return /\(id ([0-9a-f-]+)\)/.exec(text)![1]!;
}
