import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { session, world, type Session } from './mcp.js';
import { rest } from './rest.js';

/*
 * References against a real sol2flow (README.md → References): tasks by id, key, URL, old key and archived; boards by
 * key, name, URL and id; lists and labels by name and id; people as me, username and name; the default workspace; and
 * ambiguity across workspaces. Ada (w1, w2, w3) with her `refs` key, Bob (only w1) for the default workspace.
 */

const w = world();
const ws = w.workspaces.w1.slug;
const api = rest(w.keys.refs!.key);
let s: Session;

const title = (text: string) => /^# (\S+): (.+)$/m.exec(text)?.slice(1, 3);

beforeAll(async () => {
  s = await session(w.keys.refs!.key);
});
afterAll(() => s?.close());

describe('tasks', () => {
  it('by id, key (any case), app URL — with or without the workspace', async () => {
    const { id } = w.tasks.FL1!;
    expect(title(await s.ok('get_task', { task: id }))).toEqual(['FL-1', 'Due early']);
    expect(title(await s.ok('get_task', { task: id.toUpperCase() }))).toEqual(['FL-1', 'Due early']);
    expect(title(await s.ok('get_task', { task: 'FL-1', workspace: ws }))).toEqual(['FL-1', 'Due early']);
    // Ada is in three workspaces: without `workspace` the key is looked up in each
    expect(title(await s.ok('get_task', { task: 'fl-1' }))).toEqual(['FL-1', 'Due early']);
    const url = (await api.get(`/tasks/${id}`)).url as string;
    expect(url).toMatch(new RegExp(`/w/${ws}/b/FL/t/1$`));
    expect(title(await s.ok('get_task', { task: url }))).toEqual(['FL-1', 'Due early']);
    // another origin (a proxy's), a language prefix: the path is what counts
    expect(title(await s.ok('get_task', { task: `https://flow.example.com/de/w/${ws}/b/FL/t/1` }))).toEqual([
      'FL-1',
      'Due early',
    ]);
    expect(await s.fail('get_task', { task: `${new URL(url).origin}/w/${ws}/b/FL` })).toMatch(/is a board URL/);
    expect(await s.fail('get_task', { task: 'Due early' })).toMatch(/isn't a task reference/);
    expect(await s.fail('get_task', { task: 'FL-999', workspace: ws })).toMatch(/^No task FL-999 in workspace/);
  });

  it('an archived task by key (search skips archived tasks)', async () => {
    const t = await s.ok('get_task', { task: 'FL-4', workspace: ws });
    expect(title(t)).toEqual(['FL-4', 'Archived one']);
    expect(t).toMatch(/Archived \d{4}-\d\d-\d\d \(read-only: unarchive_task first\)/);
    expect(await s.ok('get_task', { task: 'FL-4' })).toContain('# FL-4: Archived one');
  });

  it('an old key after a move to another board', async () => {
    const created = await s.ok('create_task', { board: 'FL', workspace: ws, title: 'Will move' });
    const oldKey = /^Created (\S+)/.exec(created)![1]!;
    // resolve (and cache) the old key once before the move, as a model would
    await s.ok('get_task', { task: oldKey, workspace: ws });
    const moved = await s.ok('move_task', { task: oldKey, workspace: ws, board: 'OB' });
    const newKey = /it is now (OB-\d+)/.exec(moved)![1]!;
    expect(title(await s.ok('get_task', { task: oldKey, workspace: ws }))).toEqual([newKey, 'Will move']);
    expect(title(await s.ok('get_task', { task: newKey, workspace: ws }))).toEqual([newKey, 'Will move']);
    // a fresh session (nothing cached): the old key goes through the app's redirect
    const fresh = await session(w.keys.flows!.key);
    expect(title(await fresh.ok('get_task', { task: oldKey }))).toEqual([newKey, 'Will move']);
    await fresh.close();
    // writes by the old key reach the moved task
    await s.ok('add_comment', { task: oldKey, workspace: ws, text: 'by the old key' });
    const id = (await api.get(`/workspaces/${ws}/search?q=${newKey}`)).tasks[0].id;
    expect((await api.get(`/tasks/${id}`)).counts.comments).toBe(1);
  });

  it('ambiguous across workspaces: the same key in two of them', async () => {
    expect(await s.fail('get_task', { task: 'TB-1' })).toBe(
      `task TB-1 exists in several workspaces (${w.workspaces.w1.slug}, ${w.workspaces.w2.slug}): pass \`workspace\`.`,
    );
    expect(title(await s.ok('get_task', { task: 'TB-1', workspace: w.workspaces.w2.slug }))).toEqual([
      'TB-1',
      'Twin one in w2',
    ]);
    expect(title(await s.ok('get_task', { task: 'TB-1', workspace: ws }))).toEqual(['TB-1', 'Twin one in w1']);
  });
});

describe('boards, lists, labels', () => {
  it('a board by key, name, URL and id', async () => {
    const b = await api.get(`/boards/${w.boards.FL.id}`);
    for (const board of ['FL', 'fl', 'Filter lab', 'filter LAB', b.url, w.boards.FL.id])
      expect(await s.ok('get_board', { board, workspace: ws, include_tasks: false })).toMatch(/^# Filter lab \(FL\)/);
    // the URL names its workspace: no `workspace` needed
    expect(await s.ok('get_board', { board: b.url, include_tasks: false })).toMatch(/^# Filter lab \(FL\)/);
    expect(await s.fail('get_board', { board: 'No such board', workspace: ws })).toMatch(/^No board "No such board"/);
    // an archived board isn't in search: found through the archived boards
    expect(await s.ok('get_board', { board: 'AS', workspace: ws })).toMatch(/^# Archive shelf \(AS\)[\s\S]*archived/);
    // the same name in two workspaces
    expect(await s.fail('get_board', { board: 'Twin board' })).toMatch(/exists in several workspaces/);
  });

  it('a list and a label by name or id', async () => {
    const lists = w.boards.MB.lists;
    const labels = (await api.get(`/boards/${w.boards.FL.id}/labels`)).data as { id: string; name: string }[];
    const feature = labels.find((l) => l.name === 'Feature')!.id;
    const make = async (list: string, label: string) => {
      const t = await s.ok('create_task', { board: 'FL', workspace: ws, list, labels: [label], title: `ref ${list}` });
      const key = /^Created (\S+)/.exec(t)![1]!;
      const id = (await api.get(`/workspaces/${ws}/search?q=${key}`)).tasks[0].id;
      return api.get(`/tasks/${id}`);
    };
    let t = await make('closed', 'bug');
    expect(t.list.name).toBe('Closed');
    expect(t.labels.map((l: { name: string }) => l.name)).toEqual(['Bug']);
    t = await make(w.boards.FL.lists.Open!, feature);
    expect(t.list.name).toBe('Open');
    expect(t.labels.map((l: { name: string }) => l.name)).toEqual(['Feature']);
    // a unique part of a list's name works too; an unknown one names the lists
    expect(await s.ok('create_task', { board: 'MB', workspace: ws, list: 'oin', title: 'loose' })).toMatch(
      / in Doing\./,
    );
    expect(await s.fail('create_task', { board: 'MB', workspace: ws, list: 'nowhere', title: 'x' })).toBe(
      'No list "nowhere" on board MB. Its lists: "To do", "Doing", "Done".',
    );
    expect(lists['To do']).toBeTruthy();
  });
});

describe('people', () => {
  it('me, a username (with or without @), a name, an id', async () => {
    const t = await s.ok('create_task', {
      board: 'FL',
      workspace: ws,
      title: 'Assigned by reference',
      assignees: ['me', w.users.bob!.username, '@' + w.users.vera!.username, 'Nina Outside', w.users.gus!.id],
    });
    const key = /^Created (\S+)/.exec(t)![1]!;
    const id = (await api.get(`/workspaces/${ws}/search?q=${key}`)).tasks[0].id;
    const ids = (await api.get(`/tasks/${id}`)).assignees.map((u: { id: string }) => u.id).sort();
    expect(ids).toEqual(['ada', 'bob', 'vera', 'nina', 'gus'].map((u) => w.users[u]!.id).sort());
    expect(await s.fail('update_task', { task: key, workspace: ws, add_assignees: ['Nobody Here'] })).toMatch(
      /^Nobody called "Nobody Here" in workspace/,
    );
  });
});

describe('the default workspace', () => {
  it('the only workspace, the configured one, or a clear error', async () => {
    // Bob is only in w1
    const bob = await session(w.keys.bob!.key);
    expect(await bob.ok('whoami')).toContain(`default **${ws}**`);
    expect(await bob.ok('list_boards')).toContain('**FL**');
    expect(title(await bob.ok('get_task', { task: 'FL-1' }))).toEqual(['FL-1', 'Due early']);
    await bob.close();
    // Ada is in three: an error naming them for tools that need one workspace
    expect(await s.fail('list_boards')).toMatch(
      /^You are in 3 workspaces \(.+\): pass `workspace` \(the slug\), or set SOL2FLOW_WORKSPACE\.$/,
    );
    // SOL2FLOW_WORKSPACE / ?workspace=
    const def = await session(w.keys.refs!.key, { defaultWorkspace: w.workspaces.w2.slug });
    expect(await def.ok('whoami')).toContain(`default **${w.workspaces.w2.slug}**`);
    expect(title(await def.ok('get_task', { task: 'TB-1' }))).toEqual(['TB-1', 'Twin one in w2']);
    expect(await def.ok('list_boards')).not.toContain('**FL**');
    await def.close();
    // a workspace that doesn't exist (or isn't visible)
    expect(await s.fail('list_boards', { workspace: 'no-such-workspace' })).toMatch(
      /^Not found, or you don't have access/,
    );
  });
});
