import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPS, type OpId } from '../../src/api/operations.js';
import { TOOLS } from '../../src/tools/index.js';
import { FakeApi } from '../fake-api/server.js';
import { clearCache, connect } from '../helpers.js';

/*
 * The server against the vendored OpenAPI document (openapi/openapi-<version>.json, `make openapi-sync`): every
 * operation it calls exists with that method, path and operationId; each tool's scope is what its operations need
 * (`x-required-scope`); and every request the tools make sends only query parameters and body fields the API knows.
 */

const file = readdirSync('openapi').find((f) => /^openapi-\d+\.\d+\.\d+\.json$/.test(f))!;
type Op = {
  operationId: string;
  'x-required-scope'?: 'read' | 'full';
  parameters?: { name: string; in: string }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
};
type Schema = { $ref?: string; properties?: Record<string, unknown>; anyOf?: Schema[] };
const doc = JSON.parse(readFileSync(`openapi/${file}`, 'utf8')) as {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, Schema> };
};
const opOf = (id: OpId) => doc.paths[OPS[id].path]?.[OPS[id].method.toLowerCase()];
const deref = (s: Schema): Schema => (s.$ref ? deref(doc.components.schemas[s.$ref.split('/').pop()!]!) : s);

describe(`contract with ${file}`, () => {
  it.each(Object.keys(OPS) as OpId[])('%s exists with its method and path', (id) => {
    const op = opOf(id);
    expect(op, `${OPS[id].method} ${OPS[id].path}`).toBeDefined();
    expect(op!.operationId).toBe(id);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s: its scope is what its operations need', (_, t) => {
    const needs = t.ops.map((id) => opOf(id)!['x-required-scope']);
    expect(needs.every(Boolean)).toBe(true);
    const required = needs.includes('full') ? 'full' : 'read';
    if (t.scope === 'read') expect(required, `${t.name} calls an operation that needs a full-access key`).toBe('read');
    // a write tool may read first, but must call at least one write
    else expect(required).toBe('full');
  });

  it('every listed operation is used by a tool', () => {
    const used = new Set(TOOLS.flatMap((t) => t.ops));
    expect(Object.keys(OPS).filter((id) => !used.has(id as OpId))).toEqual([]);
  });

  describe('requests the tools make', () => {
    const fake = new FakeApi();
    beforeAll(() => fake.start());
    afterAll(() => fake.stop());

    it('send only parameters and body fields the API knows', async () => {
      clearCache();
      const c = await connect(fake);
      const calls: [string, Record<string, unknown>][] = [
        ['whoami', {}],
        ['list_workspaces', {}],
        ['list_boards', { query: 'Prod', archived: true }],
        ['get_board', { board: 'PRD' }],
        ['search', { query: 'login' }],
        [
          'list_tasks',
          {
            board: 'PRD',
            list: 'To do',
            assignee: ['me'],
            label: ['bug'],
            query: 'x',
            due_after: '2026-01-01',
            due_before: '2026-12-31',
            updated_since: '2026-01-01T00:00:00Z',
            include_archived: true,
            limit: 10,
          },
        ],
        ['list_tasks', { label: ['bug'] }],
        ['get_task', { task: 'PRD-2', comments: 3 }],
        ['list_labels', { board: 'PRD' }],
        ['list_labels', {}],
        ['list_people', { query: 'a', role: 'MEMBER' }],
        [
          'list_time_entries',
          { board: 'PRD', task: 'PRD-2', user: 'me', from: '2026-01-01', to: '2026-12-31T00:00:00Z' },
        ],
        ['get_timer', {}],
        ['list_notifications', { unread_only: true }],
        ['list_my_invitations', {}],
        [
          'create_task',
          {
            board: 'PRD',
            title: 'T',
            description: 'd',
            labels: ['bug'],
            assignees: ['ben'],
            start_date: '2026-10-01',
            due_date: '2026-10-09',
            estimate: '2h',
            position: 'top',
          },
        ],
        [
          'update_task',
          {
            task: 'PRD-4',
            title: 'T2',
            description: null,
            start_date: null,
            due_date: '2026-10-10',
            estimate: null,
            labels: ['feature'],
            assignees: ['me'],
            list: 'Doing',
          },
        ],
        ['move_task', { task: 'PRD-4', list: 'To do', before: 'PRD-2' }],
        ['add_comment', { task: 'PRD-4', text: 'hi' }],
        ['add_checklist_items', { task: 'PRD-4', items: ['a'] }],
        ['update_checklist_item', { task: 'PRD-4', item: '1', done: true, text: 'b' }],
        ['link_tasks', { task: 'PRD-4', kind: 'relates_to', other_task: 'PRD-1' }],
        ['unlink_tasks', { task: 'PRD-4', other_task: 'PRD-1' }],
        ['log_time', { task: 'PRD-4', duration: '30m', note: 'n' }],
        ['start_timer', { task: 'PRD-4' }],
        ['stop_timer', {}],
        ['create_board', { name: 'Ops', lists: ['A'], access: 'WORKSPACE', default_role: 'EDITOR' }],
        ['move_task', { task: 'PRD-4', board: 'OPS', position: 'top' }],
        ['archive_task', { task: 'PRD-1' }],
        ['unarchive_task', { task: 'PRD-1' }],
        ['create_list', { board: 'PRD', name: 'Later' }],
        ['create_label', { board: 'PRD', name: 'ux', color: 'pink' }],
        ['mark_notifications_read', { ids: [fake.notifications[0]!.id] }],
        ['mark_notifications_read', { all: true }],
        ['respond_to_invitation', { invitation_id: fake.invitations[0]!.id, response: 'accept' }],
      ];
      for (const [name, args] of calls) {
        const r = await c.call(name, args);
        expect(r.isError, `${name}: ${r.text}`).toBe(false);
      }
      const entry = fake.entries.find((e) => !e.running)!;
      expect(
        (
          await c.call('update_time_entry', {
            entry_id: entry.id,
            duration: '45m',
            note: null,
            started_at: '2026-10-01T09:00:00Z',
          })
        ).isError,
      ).toBe(false);
      await c.close();

      const covered = new Set<OpId>();
      for (const req of fake.requests) {
        const id = (Object.keys(OPS) as OpId[]).find(
          (k) =>
            OPS[k].method === req.method &&
            new RegExp('^' + OPS[k].path.replace(/\{\w+\}/g, '[^/]+') + '$').test(req.path),
        );
        expect(id, `${req.method} ${req.path} is not a listed operation`).toBeDefined();
        covered.add(id!);
        const op = opOf(id!)!;
        const known = new Set((op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name));
        for (const q of Object.keys(req.query)) expect(known.has(q), `${id}: query parameter ${q}`).toBe(true);
        if (req.body !== undefined && op.requestBody) {
          const schema = deref(op.requestBody.content['application/json']!.schema);
          for (const k of Object.keys(req.body as object))
            expect(Object.keys(schema.properties ?? {}), `${id}: body field ${k}`).toContain(k);
        } else if (req.body !== undefined) expect(req.body, `${id} takes no body`).toBeUndefined();
      }
      // the flow above exercises nearly everything; these are the alternatives it doesn't take
      const notExercised = (Object.keys(OPS) as OpId[]).filter((k) => !covered.has(k));
      expect(notExercised.sort()).toEqual(['declineInvitation']);
    });
  });
});
