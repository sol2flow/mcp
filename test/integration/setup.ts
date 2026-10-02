import type { TestProject } from 'vitest/node';
import { APP_URL, CONTROL_URL, rest } from './rest.js';

/*
 * The integration suite's global setup: waits for the app and control.mjs, takes the seeded accounts and keys, and
 * builds the boards every test file shares through the REST API with the `seed` key (as Ada, admin of w1). Test files
 * read it with inject('world').
 *
 *   w1  MB Main board (To do, Doing, Done)      tests create their tasks here
 *       FL Filter lab (Open, Closed)            FL-1..3 with due dates, assignees, labels; FL-4 archived; FL-3 → RR-1 link
 *       BT Bulk tasks (Many, Few)               60 tasks in Many (paging)
 *       RR Restricted room (RESTRICTED)         Bob editor, Vera and Gus viewers, Nina nothing; RR-1 "Secret plan"
 *       OB Other board (Inbox, Later)           move target
 *       AS Archive shelf (archived)             AS-1
 *       TB Twin board                           TB-1 (also in w2: an ambiguous key)
 *   w2  TB Twin board                           TB-1
 *   w3  SB Switch board                         SB-1 (the workspace's API access is switched in a test)
 *
 * Plus: Bob mentions Ada in a comment on FL-1 and assigns her FL-2 (her notifications), FL-1 has a checklist, a comment
 * with a reply and an attachment, and Cleo has two pending invitations (w1, w2).
 */

export type Ref = { id: string; key: string };
export type Key = { key: string; id: string; prefix: string };
export type World = {
  run: string;
  database: string;
  testHooks: boolean;
  appUrl: string;
  /** the app's Sol2flow-Api-Version (1.8.0 or later: the suite relies on GET /me → api_key) */
  apiVersion: string;
  users: Record<string, { id: string; username: string; name: string; email: string }>;
  workspaces: Record<'w1' | 'w2' | 'w3' | 'noapi' | 'cap' | 'ro', { id: string; slug: string; orgId: string }>;
  keys: Record<string, Key>;
  boards: Record<
    'MB' | 'FL' | 'BT' | 'RR' | 'OB' | 'AS' | 'TB' | 'TB2' | 'SB',
    Ref & { lists: Record<string, string> }
  >;
  tasks: Record<string, Ref & { title: string }>;
  labels: Record<string, string>;
  invitations: { w1: string; w2: string };
};

declare module 'vitest' {
  export interface ProvidedContext {
    world: World;
  }
}

async function waitFor(url: string, what: string) {
  const until = Date.now() + 120_000;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) throw new Error(`${what} at ${url} isn't answering (README.md → Tests)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

type Board = { id: string; key: string; lists: { id: string; name: string }[] };

export default async function setup(project: TestProject) {
  await waitFor(APP_URL + '/api/health', 'the app');
  const seeded = (await (await waitFor(CONTROL_URL + '/world', 'control.mjs')).json()) as Omit<
    World,
    'boards' | 'tasks' | 'labels' | 'invitations' | 'appUrl' | 'apiVersion'
  >;
  if (!seeded.database.endsWith('_test')) throw new Error(`not a test database: ${seeded.database}`);
  const { w1, w2, w3 } = seeded.workspaces;
  const ada = rest(seeded.keys.seed!.key);
  const meAnswer = await ada.req('GET', '/me');
  const apiVersion = meAnswer.headers.get('sol2flow-api-version') ?? '';
  const [major = 0, minor = 0] = apiVersion.split('.').map(Number);
  if (major < 1 || (major === 1 && minor < 8) || !meAnswer.data?.api_key)
    throw new Error(`the app's API is ${apiVersion || '1.7 or older'}: the integration suite needs 1.8.0 or later`);
  const bob = rest(seeded.keys.bob!.key);

  const board = async (slug: string, name: string, lists: string[], o: Record<string, unknown> = {}) => {
    const b = await ada.post<Board>(`/workspaces/${slug}/boards`, { name, lists, ...o });
    return { id: b.id, key: b.key, lists: Object.fromEntries(b.lists.map((l) => [l.name, l.id])) };
  };
  const task = async (boardId: string, listId: string, title: string, o: Record<string, unknown> = {}) => {
    const t = await ada.post<{ id: string; key: string; title: string }>('/tasks', {
      board_id: boardId,
      list_id: listId,
      title,
      ...o,
    });
    return { id: t.id, key: t.key, title: t.title };
  };

  const boards = {
    MB: await board(w1.slug, 'Main board', ['To do', 'Doing', 'Done']),
    FL: await board(w1.slug, 'Filter lab', ['Open', 'Closed']),
    BT: await board(w1.slug, 'Bulk tasks', ['Many', 'Few']),
    RR: await board(w1.slug, 'Restricted room', ['Ideas', 'Decided'], { access: 'RESTRICTED' }),
    OB: await board(w1.slug, 'Other board', ['Inbox', 'Later']),
    AS: await board(w1.slug, 'Archive shelf', ['Shelf']),
    TB: await board(w1.slug, 'Twin board', ['Twins']),
    TB2: await board(w2.slug, 'Twin board', ['Twins']),
    SB: await board(w3.slug, 'Switch board', ['Switches']),
  };
  const { users } = seeded;

  // FL's own labels
  const bug = await ada.post<{ id: string }>(`/boards/${boards.FL.id}/labels`, { name: 'Bug', color: 'red' });
  const feature = await ada.post<{ id: string }>(`/boards/${boards.FL.id}/labels`, { name: 'Feature', color: 'blue' });

  const tasks: World['tasks'] = {};
  const fl = boards.FL.lists;
  tasks.FL1 = await task(boards.FL.id, fl.Open!, 'Due early', {
    due_date: '2026-11-01',
    assignee_ids: [users.ada!.id],
    label_ids: [bug.id],
  });
  tasks.FL2 = await task(boards.FL.id, fl.Open!, 'Due late', {
    due_date: '2026-12-15',
    assignee_ids: [users.bob!.id],
    label_ids: [feature.id],
  });
  tasks.FL3 = await task(boards.FL.id, fl.Closed!, 'No due date');
  tasks.FL4 = await task(boards.FL.id, fl.Closed!, 'Archived one');
  await ada.post(`/tasks/${tasks.FL4.id}/archive`);

  for (let i = 1; i <= 60; i++) await task(boards.BT.id, boards.BT.lists.Many!, `Bulk ${String(i).padStart(2, '0')}`);

  await ada.post(`/boards/${boards.RR.id}/members`, { user_id: users.bob!.id, role: 'EDITOR' });
  await ada.post(`/boards/${boards.RR.id}/members`, { user_id: users.vera!.id, role: 'VIEWER' });
  await ada.post(`/boards/${boards.RR.id}/members`, { user_id: users.gus!.id, role: 'VIEWER' });
  tasks.RR1 = await task(boards.RR.id, boards.RR.lists.Ideas!, `Secret plan ${seeded.run}`);
  await ada.post(`/tasks/${tasks.FL3.id}/links`, { kind: 'relates_to', task_id: tasks.RR1.id });

  tasks.AS1 = await task(boards.AS.id, boards.AS.lists.Shelf!, 'Shelved task');
  await ada.post(`/boards/${boards.AS.id}/archive`);
  tasks.TB1 = await task(boards.TB.id, boards.TB.lists.Twins!, 'Twin one in w1');
  tasks.TB2_1 = await task(boards.TB2.id, boards.TB2.lists.Twins!, 'Twin one in w2');
  tasks.SB1 = await task(boards.SB.id, boards.SB.lists.Switches!, 'Switch me');

  // FL-1: checklist, a comment with a reply, an attachment
  await ada.post(`/tasks/${tasks.FL1.id}/checklist`, { text: 'first step' });
  await ada.post(`/tasks/${tasks.FL1.id}/checklist`, { text: 'second step' });
  const c = await ada.post<{ id: string }>(`/tasks/${tasks.FL1.id}/comments`, {
    text: 'Top **level** comment',
    format: 'markdown',
  });
  await ada.post(`/tasks/${tasks.FL1.id}/comments`, { text: 'A reply', format: 'markdown', parent_id: c.id });
  const content = Buffer.from('hello from the integration suite\n');
  const up = await ada.post<{ upload_id: string; parts?: { n: number }[] }>('/uploads', {
    board_id: boards.FL.id,
    task_id: tasks.FL1.id,
    name: 'notes.txt',
    size: content.length,
    mime_type: 'text/plain',
  });
  const part = await fetch(`${APP_URL}/api/v1/uploads/${up.upload_id}/parts/${up.parts?.[0]?.n ?? 1}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${seeded.keys.seed!.key}`, 'Content-Type': 'application/octet-stream' },
    body: content,
  });
  if (!part.ok) throw new Error(`upload part: HTTP ${part.status} ${await part.text()}`);
  await ada.post(`/uploads/${up.upload_id}/complete`);

  // Ada's notifications: Bob mentions her and assigns her a task
  await bob.post(`/tasks/${tasks.FL1.id}/comments`, {
    text: `Please look @[${users.ada!.name}](user:${users.ada!.id})`,
    format: 'markdown',
  });
  await bob.put(`/tasks/${tasks.FL2.id}/assignees`, { user_ids: [users.bob!.id, users.ada!.id] });

  // Cleo's invitations
  await ada.post(`/workspaces/${w1.slug}/invitations`, { emails: [users.cleo!.email], role: 'MEMBER' });
  await ada.post(`/workspaces/${w2.slug}/invitations`, { emails: [users.cleo!.email], role: 'MEMBER' });
  const mine = await rest(seeded.keys.cleo!.key).get<{ data: { id: string; workspace: { slug: string } }[] }>(
    '/me/invitations',
  );
  const inv = (slug: string) => mine.data.find((i) => i.workspace.slug === slug)!.id;

  project.provide('world', {
    ...seeded,
    appUrl: APP_URL,
    apiVersion,
    boards,
    tasks,
    labels: { bug: bug.id, feature: feature.id },
    invitations: { w1: inv(w1.slug), w2: inv(w2.slug) },
  });
}
