import { z } from 'zod';
import type { Board, BoardDetail, Label, List, Page, TaskSummary } from '../api/types.js';
import { boardLine, boardView, labelLine } from '../format/entities.js';
import { lines, more, render } from '../format/text.js';
import { getBoard, resolveBoard, workspaceSlug } from '../resolve/refs.js';
import { defineTool, p, RESOLVE_OPS } from './registry.js';

/** get_board shows at most this many tasks (3 pages); list_tasks pages through the rest. */
const BOARD_TASKS = 300;

export const listBoards = defineTool({
  name: 'list_boards',
  title: 'List boards',
  description: 'sol2flow: the boards you can open in a workspace, with their keys (PRD), task counts and your role.',
  scope: 'read',
  ops: ['listWorkspaces', 'listBoards'],
  input: {
    workspace: p.workspace,
    query: z.string().max(200).optional().describe('Name contains'),
    archived: z.boolean().optional().describe('true: archived boards instead'),
    cursor: p.cursor,
    limit: p.limit(50),
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    const slug = await workspaceSlug(ctx, a.workspace);
    const r = await ctx.api.call<Page<Board>>('listBoards', {
      params: { slug },
      query: { q: a.query, archived: a.archived ? 'true' : undefined, cursor: a.cursor, limit: a.limit ?? 50 },
    });
    return render(
      a.response_format,
      r,
      () => lines(r.data.map(boardLine), a.archived ? 'No archived boards.' : 'No boards.') + more(r.next_cursor),
    );
  },
});

export const getBoardTool = defineTool({
  name: 'get_board',
  title: 'Show a board',
  description:
    'sol2flow: a board with its lists and, in each list, its tasks in board order (key, title, due date, assignees, ' +
    `labels). Shows up to ${BOARD_TASKS} tasks.`,
  scope: 'read',
  ops: [...RESOLVE_OPS, 'getBoard', 'listTasks'],
  input: {
    board: p.board,
    workspace: p.workspace,
    include_tasks: z.boolean().optional().describe('false: only the lists (default true)'),
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    const id = await resolveBoard(ctx, a.board, a.workspace);
    const [b, tasks] = await Promise.all([
      getBoard(ctx, id),
      a.include_tasks === false
        ? null
        : ctx.api.all<TaskSummary>('listTasks', { query: { board_id: id }, maxItems: BOARD_TASKS }),
    ]);
    return render(a.response_format, { ...b, tasks: tasks?.items, more_tasks: tasks?.more }, () =>
      boardView(b, tasks?.items ?? null, tasks?.more ?? false),
    );
  },
});

export const listLabels = defineTool({
  name: 'list_labels',
  title: 'List labels',
  description:
    "sol2flow: labels. With `board`: the ones usable on that board (the workspace's labels and the board's own); " +
    "without: the workspace's labels.",
  scope: 'read',
  ops: [...RESOLVE_OPS, 'listBoardLabels', 'listWorkspaceLabels'],
  input: { board: p.board.optional(), workspace: p.workspace, response_format: p.responseFormat },
  async run(ctx, a) {
    const r = a.board
      ? await ctx.api.call<Page<Label>>('listBoardLabels', {
          params: { boardId: await resolveBoard(ctx, a.board, a.workspace) },
        })
      : await ctx.api.call<Page<Label>>('listWorkspaceLabels', {
          params: { slug: await workspaceSlug(ctx, a.workspace) },
        });
    return render(a.response_format, r, () => lines(r.data.map(labelLine), 'No labels.'));
  },
});

export const createBoard = defineTool({
  name: 'create_board',
  title: 'Create a board',
  description:
    'sol2flow: create a board in a workspace, optionally with its lists (in order). You become its board admin. ' +
    'access WORKSPACE (default): every workspace member gets default_role; RESTRICTED: only people added to it.',
  scope: 'full',
  ops: ['listWorkspaces', 'createBoard'],
  destructive: false,
  idempotent: false,
  input: {
    workspace: p.workspace,
    name: z.string().trim().min(1).max(120),
    lists: z
      .array(z.string().trim().min(1).max(120))
      .max(20)
      .optional()
      .describe('List names, e.g. ["To do", "Doing", "Done"]'),
    access: z.enum(['WORKSPACE', 'RESTRICTED']).optional(),
    default_role: z.enum(['EDITOR', 'VIEWER']).optional().describe('The role workspace members get (access WORKSPACE)'),
  },
  async run(ctx, a) {
    const slug = await workspaceSlug(ctx, a.workspace);
    const b = await ctx.api.call<BoardDetail>('createBoard', {
      params: { slug },
      body: { name: a.name, lists: a.lists, access: a.access, default_role: a.default_role },
    });
    return `Created board ${b.name} (${b.key}) with ${b.lists.length} list(s)${
      b.lists.length ? `: ${b.lists.map((l) => l.name).join(', ')}` : ''
    }. ${b.url}`;
  },
});

export const createList = defineTool({
  name: 'create_list',
  title: 'Add a list to a board',
  description: 'sol2flow: add a list (column) at the end of a board. Editors and board admins.',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'createList'],
  destructive: false,
  idempotent: false,
  input: { board: p.board, workspace: p.workspace, name: z.string().trim().min(1).max(120) },
  async run(ctx, a) {
    const boardId = await resolveBoard(ctx, a.board, a.workspace);
    const l = await ctx.api.call<List>('createList', { params: { boardId }, body: { name: a.name } });
    return `Added list "${l.name}" (id ${l.id}).`;
  },
});

export const createLabel = defineTool({
  name: 'create_label',
  title: 'Create a board label',
  description:
    'sol2flow: create a label on a board. If a label with that name exists (workspace or board), that one is returned ' +
    'instead. Colors: yellow, orange, red, pink, purple, blue, cyan, green, gray or #RRGGBB.',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'createBoardLabel'],
  destructive: false,
  idempotent: true,
  input: {
    board: p.board,
    workspace: p.workspace,
    name: z.string().trim().min(1).max(60),
    color: z.string().trim().max(20).optional().describe('Default gray'),
  },
  async run(ctx, a) {
    const boardId = await resolveBoard(ctx, a.board, a.workspace);
    const l = await ctx.api.call<Label>('createBoardLabel', {
      params: { boardId },
      body: { name: a.name, color: a.color },
    });
    return `Label "${l.name}" (${l.color}, ${l.scope} label) is ready (id ${l.id}).`;
  },
});
