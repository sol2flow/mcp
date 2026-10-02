import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/*
 * A fake sol2flow REST API (node:http) for the unit and protocol tests: the response shapes of the real one
 * (openapi/openapi-<version>.json), an in-memory workspace, and switches for what the tests need — the API version
 * header (1.8.0) or none (1.7.0), injected errors, and a log of every request.
 */

export const KEYS = {
  full: 'sf_Full0001_' + 'a'.repeat(43),
  read: 'sf_Read0001_' + 'b'.repeat(43),
  other: 'sf_Othr0001_' + 'c'.repeat(43),
};

type User = { id: string; name: string; username: string };
type Label = { id: string; name: string; color: string; scope: 'workspace' | 'board'; board_id: string | null };
type List = { id: string; name: string; position: string };
type Board = {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  lists: List[];
  next: number;
  archived: boolean;
};
type Task = {
  id: string;
  board_id: string;
  list_id: string;
  number: number;
  title: string;
  position: string;
  description_text: string | null;
  start_date: string | null;
  due_date: string | null;
  estimate_minutes: number | null;
  labels: string[];
  assignees: string[];
  archived_at: string | null;
  updated_at: string;
  checklist: { id: string; text: string; done: boolean; position: string; completed_at: string | null }[];
  comments: { id: string; text: string; author: string; created_at: string; parent_id: string | null }[];
};

export type Injected = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times?: number;
  delayMs?: number;
};
export type RequestLog = {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body: unknown;
  key: string | null;
  headers: IncomingMessage['headers'];
};

const NOW = '2026-10-02T08:00:00.000Z';
const id = () => randomUUID();

export class FakeApi {
  version: string | null = '1.8.0';
  requests: RequestLog[] = [];
  /** "METHOD /path/with/{params}" (the OpenAPI template) or "METHOD /concrete/path" → injected answers */
  inject = new Map<string, Injected>();
  url = '';
  private server?: Server;

  users: Record<string, User> = {
    ana: { id: id(), name: 'Ana Lima', username: 'ana' },
    ben: { id: id(), name: 'Ben Okafor', username: 'ben' },
    cara: { id: id(), name: 'Cara Diaz', username: 'cara' },
  };
  /** whose key is which */
  keyUser: Record<string, keyof FakeApi['users']> = { [KEYS.full]: 'ana', [KEYS.read]: 'ana', [KEYS.other]: 'ben' };
  keyScope: Record<string, 'full' | 'read'> = { [KEYS.full]: 'full', [KEYS.read]: 'read', [KEYS.other]: 'full' };
  workspaces = [{ id: id(), slug: 'acme', name: 'Acme', members: ['ana', 'ben', 'cara'] }];
  labels: Label[] = [];
  boards: Board[] = [];
  tasks: Task[] = [];
  links: { id: string; from: string; to: string; kind: string }[] = [];
  entries: {
    id: string;
    task_id: string;
    user: string;
    started_at: string;
    duration_sec: number;
    note: string | null;
    running: boolean;
  }[] = [];
  notifications = [
    { id: id(), type: 'assigned', read: false, user: 'ana' },
    { id: id(), type: 'mentioned', read: true, user: 'ana' },
  ];
  invitations = [{ id: id(), workspace: { id: id(), slug: 'beta', name: 'Beta' }, user: 'ana' }];

  constructor() {
    const ws = this.workspaces[0]!;
    const prd: Board = {
      id: id(),
      workspace_id: ws.id,
      key: 'PRD',
      name: 'Product',
      lists: [
        { id: id(), name: 'To do', position: 'a0' },
        { id: id(), name: 'Doing', position: 'a1' },
        { id: id(), name: 'Done', position: 'a2' },
      ],
      next: 4,
      archived: false,
    };
    this.boards.push(prd);
    this.labels.push(
      { id: id(), name: 'bug', color: 'red', scope: 'workspace', board_id: null },
      { id: id(), name: 'feature', color: 'blue', scope: 'board', board_id: prd.id },
    );
    const todo = prd.lists[0]!.id;
    for (const [n, title, pos] of [
      [1, 'Set up billing', 'a0'],
      [2, 'Fix login redirect', 'a1'],
      [3, 'Write onboarding guide', 'a2'],
    ] as const)
      this.tasks.push({
        id: id(),
        board_id: prd.id,
        list_id: todo,
        number: n,
        title,
        position: pos,
        description_text: n === 2 ? 'Users land on /404 after sign-in.' : null,
        start_date: null,
        due_date: n === 2 ? '2026-10-05' : null,
        estimate_minutes: null,
        labels: n === 2 ? [this.labels[0]!.id] : [],
        assignees: n === 2 ? [this.users.ana!.id] : [],
        archived_at: null,
        updated_at: NOW,
        checklist: [],
        comments: [],
      });
  }

  task(key: string) {
    return this.tasks.find((t) => this.keyOf(t) === key)!;
  }

  start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    return new Promise((r) =>
      this.server!.listen(0, '127.0.0.1', () => {
        this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
        r(this.url);
      }),
    );
  }

  stop() {
    return new Promise<void>((r) => {
      this.server?.closeAllConnections();
      this.server?.close(() => r());
    });
  }

  /* ───────────── shapes ───────────── */

  private keyOf(t: Task) {
    return `${this.boards.find((b) => b.id === t.board_id)!.key}-${t.number}`;
  }
  private userRef(u: string) {
    const x = Object.values(this.users).find((v) => v.id === u)!;
    return { id: x.id, name: x.name, username: x.username };
  }
  private wsOf(b: Board) {
    return this.workspaces.find((w) => w.id === b.workspace_id)!;
  }
  private boardJson(b: Board) {
    return {
      id: b.id,
      workspace_id: b.workspace_id,
      key: b.key,
      name: b.name,
      access: 'WORKSPACE',
      default_role: 'EDITOR',
      archived: b.archived,
      role: 'ADMIN',
      task_count: this.tasks.filter((t) => t.board_id === b.id && !t.archived_at).length,
      last_activity_at: NOW,
      created_at: NOW,
      url: `${this.url}/w/${this.wsOf(b).slug}/b/${b.key}`,
    };
  }
  private boardDetail(b: Board) {
    return {
      ...this.boardJson(b),
      lists: b.lists.map((l) => ({
        id: l.id,
        name: l.name,
        position: l.position,
        task_count: this.tasks.filter((t) => t.list_id === l.id && !t.archived_at).length,
      })),
    };
  }
  private summary(t: Task) {
    const b = this.boards.find((x) => x.id === t.board_id)!;
    return {
      id: t.id,
      key: this.keyOf(t),
      number: t.number,
      board_id: t.board_id,
      list_id: t.list_id,
      title: t.title,
      position: t.position,
      start_date: t.start_date,
      due_date: t.due_date,
      estimate_minutes: t.estimate_minutes,
      estimate_display: t.estimate_minutes ? `${t.estimate_minutes / 60}h` : null,
      labels: t.labels.map((l) => {
        const x = this.labels.find((y) => y.id === l)!;
        return { id: x.id, name: x.name, color: x.color };
      }),
      assignees: t.assignees.map((u) => this.userRef(u)),
      created_at: NOW,
      updated_at: t.updated_at,
      archived: Boolean(t.archived_at),
      archived_at: t.archived_at,
      url: `${this.url}/w/${this.wsOf(b).slug}/b/${b.key}/t/${t.number}`,
    };
  }
  private full(t: Task, markdown: boolean) {
    const b = this.boards.find((x) => x.id === t.board_id)!;
    return {
      ...this.summary(t),
      description: t.description_text ? { type: 'doc' } : null,
      description_text: t.description_text,
      ...(markdown ? { description_markdown: t.description_text } : {}),
      list: { id: t.list_id, name: b.lists.find((l) => l.id === t.list_id)?.name ?? '?' },
      members: [],
      checklist: t.checklist.map((c) => ({ ...c, task_id: t.id })),
      counts: {
        comments: t.comments.length,
        attachments: 0,
        checklist: t.checklist.length,
        checklist_done: t.checklist.filter((c) => c.done).length,
      },
      logged_sec: this.entries.filter((e) => e.task_id === t.id).reduce((s, e) => s + e.duration_sec, 0),
      creator: this.userRef(this.users.ana!.id),
    };
  }
  private entryJson(e: FakeApi['entries'][number]) {
    const t = this.tasks.find((x) => x.id === e.task_id)!;
    const u = this.userRef(e.user);
    return {
      id: e.id,
      workspace_id: this.workspaces[0]!.id,
      board_id: t.board_id,
      task_id: t.id,
      task_key: this.keyOf(t),
      user: { id: u.id, name: u.name },
      user_name: u.name,
      started_at: e.started_at,
      ended_at: e.running ? null : new Date(Date.parse(e.started_at) + e.duration_sec * 1000).toISOString(),
      duration_sec: e.duration_sec,
      note: e.note,
      running: e.running,
    };
  }

  /* ───────────── HTTP ───────────── */

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url!, 'http://x');
    const path = u.pathname.replace(/^\/api\/v1/, '');
    const query: Record<string, string | string[]> = {};
    for (const [k, v] of u.searchParams) {
      const cur = query[k];
      query[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const auth = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
    this.requests.push({ method: req.method!, path, query, body, key: auth, headers: req.headers });

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (this.version) headers['Sol2flow-Api-Version'] = this.version;
    const reply = (status: number, data?: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...headers, ...extra });
      res.end(status === 204 || data === undefined ? undefined : JSON.stringify(data));
    };
    const error = (status: number, code: string, message: string, more: Record<string, unknown> = {}) =>
      reply(
        status,
        { error: { code, message, ...more } },
        status === 401 ? { 'WWW-Authenticate': 'Bearer realm="sol2flow"' } : {},
      );

    const route = this.match(req.method!, path);
    const injected =
      this.inject.get(`${req.method} ${path}`) ??
      (route ? this.inject.get(`${req.method} ${route.template}`) : undefined);
    if (injected) {
      if (injected.times !== undefined && --injected.times <= 0) {
        this.inject.delete(`${req.method} ${path}`);
        if (route) this.inject.delete(`${req.method} ${route.template}`);
      }
      if (injected.delayMs) await new Promise((r) => setTimeout(r, injected.delayMs));
      if (res.destroyed) return;
      return reply(injected.status, injected.body, injected.headers);
    }

    if (!auth || !(auth in this.keyUser)) return error(401, 'unauthenticated', 'A valid API key is required.');
    if (!route) return error(404, 'not_found', 'No such endpoint. See /api/v1/openapi.json.');
    if (this.keyScope[auth] === 'read' && req.method !== 'GET')
      return error(
        403,
        'insufficient_scope',
        'This API key is read-only: it may only call GET and HEAD. Use a key with full access.',
      );
    const me = this.users[this.keyUser[auth]!]!;
    try {
      const out = route.run({ p: route.params, q: query, body, me, key: auth });
      if (out && typeof out === 'object' && 'status' in out && 'data' in out)
        return reply(out.status as number, out.data);
      if (out === undefined) return reply(204);
      return reply(req.method === 'POST' && route.created ? 201 : 200, out);
    } catch (e) {
      const x = e as { status?: number; code?: string; message: string; field?: string };
      return error(x.status ?? 500, x.code ?? 'internal', x.message, x.field ? { field: x.field } : {});
    }
  }

  private match(method: string, path: string) {
    for (const r of this.routes()) {
      if (r.method !== method) continue;
      const names: string[] = [];
      const re = new RegExp('^' + r.template.replace(/\{(\w+)\}/g, (_, n: string) => (names.push(n), '([^/]+)')) + '$');
      const m = re.exec(path);
      if (m) return { ...r, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
    }
    return null;
  }

  private fail(status: number, code: string, message: string, field?: string): never {
    throw Object.assign(new Error(message), { status, code, field });
  }
  private findTask(tid: string) {
    return this.tasks.find((t) => t.id === tid) ?? this.fail(404, 'not_found', 'Not found.');
  }
  private findBoard(bid: string) {
    return this.boards.find((b) => b.id === bid) ?? this.fail(404, 'not_found', 'Not found.');
  }
  private ws(slug: string) {
    return this.workspaces.find((w) => w.slug === slug) ?? this.fail(404, 'not_found', 'Not found.');
  }
  private page<T>(items: T[], q: Record<string, string | string[]>) {
    const limit = Number(q.limit ?? 50);
    const start = q.cursor ? Number(Buffer.from(String(q.cursor), 'base64url').toString()) : 0;
    const data = items.slice(start, start + limit);
    const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
    return { data, next_cursor: next };
  }
  private arr(v: string | string[] | undefined) {
    return v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(','));
  }
  private writable(t: Task) {
    if (t.archived_at) this.fail(409, 'task_archived', 'The task is archived.');
  }

  private routes(): {
    method: string;
    template: string;
    created?: boolean;
    run: (c: {
      p: Record<string, string>;
      q: Record<string, string | string[]>;
      // the request body as JSON: each route reads the fields it knows
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: any;
      me: User;
      key: string;
    }) => unknown;
  }[] {
    return [
      {
        method: 'GET',
        template: '/me',
        run: ({ me, key }) => ({
          id: me.id,
          username: me.username,
          name: me.name,
          email: null,
          email_verified: true,
          locale: 'en',
          staff_role: null,
          created_at: NOW,
          time_zone: 'Europe/Berlin',
          ...(this.version && this.version >= '1.8.0'
            ? { api_key: { name: 'Test key', prefix: key.slice(3, 11), scope: this.keyScope[key], expires_at: null } }
            : {}),
        }),
      },
      {
        method: 'GET',
        template: '/workspaces',
        run: ({ q }) =>
          this.page(
            this.workspaces.map((w) => ({
              id: w.id,
              slug: w.slug,
              name: w.name,
              is_private: false,
              role: 'MEMBER',
              url: `${this.url}/w/${w.slug}`,
              organization: null,
            })),
            q,
          ),
      },
      {
        method: 'GET',
        template: '/workspaces/{slug}/boards',
        run: ({ p, q }) => {
          const w = this.ws(p.slug!);
          const archived = q.archived === 'true' || q.archived === '1';
          return this.page(
            this.boards
              .filter((b) => b.workspace_id === w.id && b.archived === archived)
              .filter((b) => !q.q || b.name.toLowerCase().includes(String(q.q).toLowerCase()))
              .map((b) => this.boardJson(b)),
            q,
          );
        },
      },
      {
        method: 'POST',
        template: '/workspaces/{slug}/boards',
        created: true,
        run: ({ p, body }) => {
          const w = this.ws(p.slug!);
          const b: Board = {
            id: id(),
            workspace_id: w.id,
            key: body.name.slice(0, 3).toUpperCase(),
            name: body.name,
            lists: (body.lists ?? []).map((n: string, i: number) => ({ id: id(), name: n, position: `a${i}` })),
            next: 1,
            archived: false,
          };
          this.boards.push(b);
          return this.boardDetail(b);
        },
      },
      { method: 'GET', template: '/boards/{boardId}', run: ({ p }) => this.boardDetail(this.findBoard(p.boardId!)) },
      {
        method: 'POST',
        template: '/boards/{boardId}/lists',
        created: true,
        run: ({ p, body }) => {
          const b = this.findBoard(p.boardId!);
          const l = { id: id(), name: body.name, position: `b${b.lists.length}` };
          b.lists.push(l);
          return { ...l, task_count: 0 };
        },
      },
      {
        method: 'GET',
        template: '/workspaces/{slug}/labels',
        run: () => ({ data: this.labels.filter((l) => l.scope === 'workspace'), next_cursor: null }),
      },
      {
        method: 'GET',
        template: '/boards/{boardId}/labels',
        run: ({ p }) => ({
          data: this.labels.filter((l) => l.scope === 'workspace' || l.board_id === p.boardId),
          next_cursor: null,
        }),
      },
      {
        method: 'POST',
        template: '/boards/{boardId}/labels',
        created: true,
        run: ({ p, body }) => {
          const same = this.labels.find((l) => l.name.toLowerCase() === body.name.toLowerCase());
          if (same) return same;
          const l: Label = {
            id: id(),
            name: body.name,
            color: body.color ?? 'gray',
            scope: 'board',
            board_id: p.boardId!,
          };
          this.labels.push(l);
          return l;
        },
      },
      {
        method: 'GET',
        template: '/workspaces/{slug}/search',
        run: ({ p, q }) => {
          const w = this.ws(p.slug!);
          const s = String(q.q ?? '')
            .trim()
            .toLowerCase();
          const boards = this.boards.filter((b) => b.workspace_id === w.id && !b.archived);
          const tasks = this.tasks.filter(
            (t) =>
              !t.archived_at &&
              boards.some((b) => b.id === t.board_id) &&
              (this.keyOf(t).toLowerCase() === s ||
                t.title.toLowerCase().includes(s) ||
                (t.description_text ?? '').toLowerCase().includes(s)),
          );
          return {
            boards: boards
              .filter((b) => b.key.toLowerCase() === s || b.name.toLowerCase().includes(s))
              .map((b) => ({ id: b.id, key: b.key, name: b.name, lists: b.lists.length, tasks: 0 })),
            tasks: tasks.map((t) => {
              const b = this.boards.find((x) => x.id === t.board_id)!;
              return {
                id: t.id,
                key: this.keyOf(t),
                title: t.title,
                board_key: b.key,
                where: `${b.name} · ${b.lists.find((l) => l.id === t.list_id)?.name}`,
              };
            }),
            more: 0,
          };
        },
      },
      {
        method: 'GET',
        template: '/tasks',
        run: ({ q }) => {
          if (!q.board_id && !q.workspace)
            this.fail(400, 'invalid_input', 'board_id or workspace is required', 'board_id');
          const assignees = this.arr(q.assignee),
            labels = this.arr(q.label);
          const archived = q.archived === 'true';
          return this.page(
            this.tasks
              .filter((t) => (q.board_id ? t.board_id === q.board_id : true))
              .filter((t) => (q.list_id ? t.list_id === q.list_id : true))
              .filter((t) => archived || !t.archived_at)
              .filter((t) => !assignees.length || t.assignees.some((a) => assignees.includes(a)))
              .filter((t) => !labels.length || t.labels.some((a) => labels.includes(a)))
              .filter((t) => !q.q || t.title.toLowerCase().includes(String(q.q).toLowerCase()))
              .map((t) => this.summary(t)),
            q,
          );
        },
      },
      {
        method: 'POST',
        template: '/tasks',
        created: true,
        run: ({ body, me }) => {
          const b = this.findBoard(body.board_id);
          if (!b.lists.some((l) => l.id === body.list_id)) this.fail(404, 'not_found', 'Not found.');
          if (!body.title) this.fail(422, 'invalid_input', 'title: required', 'title');
          const t: Task = {
            id: id(),
            board_id: b.id,
            list_id: body.list_id,
            number: b.next++,
            title: body.title,
            position: body.position === 'top' ? '0' : 'z' + this.tasks.length,
            description_text: body.description ?? null,
            start_date: body.start_date ?? null,
            due_date: body.due_date ?? null,
            estimate_minutes: body.estimate ? 120 : null,
            labels: body.label_ids ?? [],
            assignees: body.assignee_ids ?? [],
            archived_at: null,
            updated_at: new Date().toISOString(),
            checklist: [],
            comments: [],
          };
          void me;
          this.tasks.push(t);
          return this.full(t, false);
        },
      },
      {
        method: 'GET',
        template: '/tasks/{taskId}',
        run: ({ p, q }) => this.full(this.findTask(p.taskId!), q.format === 'markdown'),
      },
      {
        method: 'PATCH',
        template: '/tasks/{taskId}',
        run: ({ p, body }) => {
          const t = this.findTask(p.taskId!);
          this.writable(t);
          if (body.due_date !== undefined && body.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date))
            this.fail(422, 'invalid_input', 'due_date: invalid date', 'due_date');
          for (const k of ['title', 'start_date', 'due_date'] as const) if (body[k] !== undefined) t[k] = body[k];
          if (body.description !== undefined) t.description_text = body.description;
          if (body.estimate !== undefined) t.estimate_minutes = body.estimate ? 120 : null;
          t.updated_at = new Date().toISOString();
          return this.full(t, false);
        },
      },
      {
        method: 'POST',
        template: '/tasks/{taskId}/move',
        run: ({ p, body }) => {
          const t = this.findTask(p.taskId!);
          this.writable(t);
          t.list_id = body.list_id;
          const near = (x: string | null | undefined) => (x ? this.findTask(x).position : undefined);
          const a = near(body.previous_id),
            b = near(body.next_id);
          // a string between the neighbours (the real API uses fractional indexing)
          t.position = a && b ? a + 'm' : a ? a + 'z' : b ? b.slice(0, -1) || '0' : 'zz' + Date.now();
          return this.full(t, false);
        },
      },
      {
        method: 'POST',
        template: '/tasks/{taskId}/move-board',
        run: ({ p, body }) => {
          const t = this.findTask(p.taskId!);
          const b = this.findBoard(body.board_id);
          t.board_id = b.id;
          t.list_id = body.list_id;
          t.number = b.next++;
          return this.full(t, false);
        },
      },
      {
        method: 'POST',
        template: '/tasks/{taskId}/archive',
        run: ({ p }) => {
          const t = this.findTask(p.taskId!);
          t.archived_at ??= new Date().toISOString();
          return this.full(t, false);
        },
      },
      {
        method: 'POST',
        template: '/tasks/{taskId}/unarchive',
        run: ({ p }) => {
          const t = this.findTask(p.taskId!);
          t.archived_at = null;
          return this.full(t, false);
        },
      },
      {
        method: 'PUT',
        template: '/tasks/{taskId}/labels',
        run: ({ p, body }) => {
          const t = this.findTask(p.taskId!);
          this.writable(t);
          t.labels = body.label_ids;
          return this.full(t, false);
        },
      },
      {
        method: 'PUT',
        template: '/tasks/{taskId}/assignees',
        run: ({ p, body }) => {
          const t = this.findTask(p.taskId!);
          this.writable(t);
          t.assignees = body.user_ids;
          return this.full(t, false);
        },
      },
      {
        method: 'GET',
        template: '/tasks/{taskId}/links',
        run: ({ p }) => {
          this.findTask(p.taskId!);
          return {
            data: this.links
              .filter((l) => l.from === p.taskId || l.to === p.taskId)
              .map((l) => {
                const other = this.findTask(l.from === p.taskId ? l.to : l.from);
                const s = this.summary(other);
                return {
                  id: l.id,
                  kind: l.kind,
                  task: {
                    id: other.id,
                    key: s.key,
                    title: other.title,
                    board_id: other.board_id,
                    list: 'To do',
                    assignees: [],
                    archived: false,
                    open: true,
                    url: s.url,
                  },
                  created_at: NOW,
                };
              }),
          };
        },
      },
      {
        method: 'POST',
        template: '/tasks/{taskId}/links',
        created: true,
        run: ({ p, body }) => {
          const t = this.findTask(p.taskId!);
          const o = this.findTask(body.task_id);
          if (t.id === o.id) this.fail(422, 'link_self', 'A task cannot be linked to itself.');
          if (this.links.some((l) => (l.from === t.id && l.to === o.id) || (l.from === o.id && l.to === t.id)))
            this.fail(409, 'link_exists', 'These tasks are already linked.');
          const l = { id: id(), from: t.id, to: o.id, kind: body.kind };
          this.links.push(l);
          const s = this.summary(o);
          return {
            id: l.id,
            kind: l.kind,
            task: {
              id: o.id,
              key: s.key,
              title: o.title,
              board_id: o.board_id,
              list: 'To do',
              assignees: [],
              archived: false,
              open: true,
              url: s.url,
            },
            created_at: NOW,
          };
        },
      },
      {
        method: 'DELETE',
        template: '/tasks/{taskId}/links/{linkId}',
        run: ({ p }) => {
          this.links = this.links.filter((l) => l.id !== p.linkId);
          return undefined;
        },
      },
      {
        method: 'POST',
        template: '/tasks/{taskId}/checklist',
        created: true,
        run: ({ p, body }) => {
          const t = this.findTask(p.taskId!);
          this.writable(t);
          const c = { id: id(), text: body.text, done: false, position: `c${t.checklist.length}`, completed_at: null };
          t.checklist.push(c);
          return { ...c, task_id: t.id };
        },
      },
      {
        method: 'PATCH',
        template: '/checklist/{itemId}',
        run: ({ p, body }) => {
          for (const t of this.tasks) {
            const c = t.checklist.find((x) => x.id === p.itemId);
            if (c) {
              if (body.text !== undefined) c.text = body.text;
              if (body.done !== undefined) c.done = body.done;
              return { ...c, task_id: t.id };
            }
          }
          return this.fail(404, 'not_found', 'Not found.');
        },
      },
      {
        method: 'GET',
        template: '/tasks/{taskId}/comments',
        run: ({ p, q }) => {
          const t = this.findTask(p.taskId!);
          return this.page(
            [...t.comments].reverse().map((c) => ({
              id: c.id,
              task_id: t.id,
              parent_id: c.parent_id,
              author: { id: c.author, name: this.userRef(c.author).name },
              text: c.text,
              doc: null,
              deleted: false,
              created_at: c.created_at,
              edited_at: null,
              ...(q.format === 'markdown' ? { markdown: c.text } : {}),
              replies: [],
            })),
            q,
          );
        },
      },
      {
        method: 'POST',
        template: '/tasks/{taskId}/comments',
        created: true,
        run: ({ p, body, me }) => {
          const t = this.findTask(p.taskId!);
          this.writable(t);
          const c = {
            id: id(),
            text: body.text,
            author: me.id,
            created_at: new Date().toISOString(),
            parent_id: body.parent_id ?? null,
          };
          t.comments.push(c);
          return {
            id: c.id,
            task_id: t.id,
            parent_id: c.parent_id,
            author: { id: me.id, name: me.name },
            text: c.text,
            doc: null,
            deleted: false,
            created_at: c.created_at,
            edited_at: null,
            replies: [],
          };
        },
      },
      {
        method: 'GET',
        template: '/time-entries',
        run: ({ q }) => {
          if (!q.workspace) this.fail(400, 'invalid_input', 'workspace: required', 'workspace');
          return this.page(
            this.entries
              .filter((e) => (!q.task_id || e.task_id === q.task_id) && (!q.user_id || e.user === q.user_id))
              .map((e) => this.entryJson(e)),
            q,
          );
        },
      },
      {
        method: 'POST',
        template: '/time-entries',
        created: true,
        run: ({ body, me }) => {
          const t = this.findTask(body.task_id);
          this.writable(t);
          if (body.duration_sec < 60 || body.duration_sec > 86400)
            this.fail(422, 'invalid_input', 'duration_sec: out of range', 'duration_sec');
          const e = {
            id: id(),
            task_id: t.id,
            user: me.id,
            started_at: body.started_at,
            duration_sec: body.duration_sec,
            note: body.note ?? null,
            running: false,
          };
          this.entries.push(e);
          return this.entryJson(e);
        },
      },
      {
        method: 'PATCH',
        template: '/time-entries/{entryId}',
        run: ({ p, body }) => {
          const e = this.entries.find((x) => x.id === p.entryId) ?? this.fail(404, 'not_found', 'Not found.');
          if (body.note !== undefined) e.note = body.note;
          if (body.duration_sec !== undefined) e.duration_sec = body.duration_sec;
          if (body.started_at !== undefined) e.started_at = body.started_at;
          return this.entryJson(e);
        },
      },
      {
        method: 'GET',
        template: '/timer',
        run: ({ me }) => {
          const e = this.entries.find((x) => x.running && x.user === me.id);
          if (!e) return { timer: null };
          const t = this.findTask(e.task_id);
          return {
            timer: { id: e.id, task_id: t.id, task_key: this.keyOf(t), title: t.title, started_at: e.started_at },
          };
        },
      },
      {
        method: 'POST',
        template: '/timer/start',
        run: ({ body, me }) => {
          const t = this.findTask(body.task_id);
          const running = this.entries.find((x) => x.running && x.user === me.id);
          let stopped = null;
          if (running) {
            running.running = false;
            running.duration_sec = 600;
            stopped = { id: running.id, task_key: this.keyOf(this.findTask(running.task_id)), duration_sec: 600 };
          }
          const e = {
            id: id(),
            task_id: t.id,
            user: me.id,
            started_at: new Date().toISOString(),
            duration_sec: 0,
            note: null,
            running: true,
          };
          this.entries.push(e);
          return {
            timer: { id: e.id, task_id: t.id, task_key: this.keyOf(t), title: t.title, started_at: e.started_at },
            stopped,
          };
        },
      },
      {
        method: 'POST',
        template: '/timer/stop',
        run: ({ me }) => {
          const e = this.entries.find((x) => x.running && x.user === me.id);
          if (!e) return { stopped: null };
          e.running = false;
          e.duration_sec = 900;
          return { stopped: { id: e.id, task_key: this.keyOf(this.findTask(e.task_id)), duration_sec: 900 } };
        },
      },
      {
        method: 'GET',
        template: '/notifications',
        run: ({ q, me }) =>
          this.page(
            this.notifications
              .filter((n) => this.users[n.user]!.id === me.id && (q.unread !== 'true' || !n.read))
              .map((n) => ({
                id: n.id,
                type: n.type,
                count: 1,
                read: n.read,
                read_at: null,
                updated_at: NOW,
                actor: { id: this.users.ben!.id, name: 'Ben Okafor' },
                visible: true,
                task: { key: 'PRD-2', title: 'Fix login redirect', deleted: false },
                workspace: 'Acme',
                board: 'Product',
                url: null,
                values: {},
              })),
            q,
          ),
      },
      {
        method: 'PATCH',
        template: '/notifications/{notificationId}',
        run: ({ p, body }) => {
          const n =
            this.notifications.find((x) => x.id === p.notificationId) ?? this.fail(404, 'not_found', 'Not found.');
          n.read = body.read;
          return { ok: true };
        },
      },
      {
        method: 'POST',
        template: '/notifications/read-all',
        run: () => {
          for (const n of this.notifications) n.read = true;
          return { status: 200, data: { ok: true } };
        },
      },
      {
        method: 'GET',
        template: '/workspaces/{slug}/members',
        run: ({ p, q }) => {
          const w = this.ws(p.slug!);
          const s = String(q.q ?? '').toLowerCase();
          return this.page(
            w.members
              .map((k) => this.users[k]!)
              .filter((u) => !s || u.name.toLowerCase().includes(s) || u.username.includes(s))
              .map((u) => ({
                type: 'member',
                user: u,
                email: null,
                role: 'MEMBER',
                managed: false,
                automatic: false,
                joined_at: NOW,
              })),
            q,
          );
        },
      },
      {
        method: 'GET',
        template: '/me/invitations',
        run: () => ({
          data: this.invitations.map((i) => ({
            id: i.id,
            workspace: i.workspace,
            board: null,
            role: 'MEMBER',
            board_role: null,
            invited_by: 'Ben Okafor',
            created_at: NOW,
            expires_at: '2026-10-30T00:00:00.000Z',
          })),
          next_cursor: null,
        }),
      },
      {
        method: 'POST',
        template: '/me/invitations/{invitationId}/accept',
        run: ({ p }) => {
          const i = this.invitations.find((x) => x.id === p.invitationId) ?? this.fail(404, 'not_found', 'Not found.');
          this.invitations = this.invitations.filter((x) => x !== i);
          this.workspaces.push({
            id: i.workspace.id,
            slug: i.workspace.slug,
            name: i.workspace.name,
            members: ['ana'],
          });
          return {
            id: i.workspace.id,
            slug: i.workspace.slug,
            name: i.workspace.name,
            is_private: false,
            role: 'MEMBER',
            url: `${this.url}/w/${i.workspace.slug}`,
            organization: null,
          };
        },
      },
      {
        method: 'POST',
        template: '/me/invitations/{invitationId}/decline',
        run: ({ p }) => {
          this.invitations = this.invitations.filter((x) => x.id !== p.invitationId);
          return undefined;
        },
      },
    ];
  }
}
