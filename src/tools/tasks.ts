import { z } from 'zod';
import { ApiError, ToolError, describeError } from '../api/errors.js';
import type { Comment, Label, Page, SearchResult, Task, TaskLink, TaskSummary } from '../api/types.js';
import { searchView, taskLine, taskView } from '../format/entities.js';
import { lines, more, render } from '../format/text.js';
import {
  getBoard,
  resolveBoard,
  resolveLabels,
  resolveList,
  resolveTask,
  resolveUsers,
  workspaceSlug,
  workspaceSlugById,
} from '../resolve/refs.js';
import { workspaces } from './context.js';
import { defineTool, p, RESOLVE_OPS, RESOLVE_PEOPLE_OPS, type ToolDef } from './registry.js';
import type { ToolContext } from './context.js';

const dayOrNull = z.union([p.day, z.null()]);
const description = z
  .string()
  .max(20_000)
  .describe(
    'Markdown (GFM). Mentions: @[Name](user:<user id>). Raw HTML stays text; links only http(s), mailto or relative',
  );
const estimate = z
  .string()
  .max(20)
  .describe(
    'Working time: "90m", "2h", "3d", "1w 2d"; a bare number is hours (1 day = 8 h, 1 week = 5 days by default)',
  );

const TASK_PARAMS = {
  label_ids: 'labels',
  assignee_ids: 'assignees',
  user_ids: 'assignees',
  list_id: 'list',
  board_id: 'board',
  estimate_minutes: 'estimate',
};

/* ───────────── read ───────────── */

export const search = defineTool({
  name: 'search',
  title: 'Search',
  description:
    'sol2flow: find boards (by name or key) and tasks (by title, key like PRD-12, or description), like ⌘K in the ' +
    "app. Archived boards and tasks aren't searched. Without `workspace` and with several workspaces, searches them all.",
  scope: 'read',
  ops: ['listWorkspaces', 'search'],
  input: {
    query: z.string().trim().min(1).max(200),
    workspace: p.workspace,
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    const chosen = a.workspace ?? ctx.defaultWorkspace;
    const slugs = chosen ? [chosen] : (await workspaces(ctx)).map((w) => w.slug).slice(0, 10);
    const results = await Promise.all(
      slugs.map(async (slug) => ({
        workspace: slug,
        ...(await ctx.api.call<SearchResult>('search', { params: { slug }, query: { q: a.query } })),
      })),
    );
    return render(a.response_format, slugs.length === 1 ? results[0] : results, () =>
      slugs.length === 1
        ? searchView(results[0]!, a.query)
        : results.map((r) => `# ${r.workspace}\n${searchView(r, a.query)}`).join('\n\n'),
    );
  },
});

export const listTasks = defineTool({
  name: 'list_tasks',
  title: 'List tasks',
  description:
    'sol2flow: tasks on a board, or on every board of a workspace, filtered by list, assignee ("me", a username or ' +
    'name), label, text, due dates or last change. Ordered by last change, oldest first (use `updated_since` for ' +
    "what's new). Archived tasks only with include_archived.",
  scope: 'read',
  ops: [...RESOLVE_OPS, ...RESOLVE_PEOPLE_OPS, 'getBoard', 'listBoardLabels', 'listWorkspaceLabels', 'listTasks'],
  params: { ...TASK_PARAMS, assignee: 'assignee', label: 'label', due_from: 'due_after', due_to: 'due_before' },
  input: {
    workspace: p.workspace,
    board: p.board.optional().describe('Only this board (key, name, URL or id); default every board of the workspace'),
    list: z.string().max(200).optional().describe('Only this list (name or id); needs `board`'),
    assignee: z
      .array(z.string().max(200))
      .max(20)
      .optional()
      .describe('Assigned to any of these: "me", usernames, names'),
    label: z.array(z.string().max(100)).max(20).optional().describe('Carrying any of these labels (names)'),
    query: z.string().max(200).optional().describe('Title or description contains'),
    due_after: p.day.optional().describe('Due on or after this day (YYYY-MM-DD)'),
    due_before: p.day.optional().describe('Due on or before this day (YYYY-MM-DD)'),
    updated_since: z.iso.datetime({ offset: true }).optional().describe('Changed since (ISO 8601)'),
    include_archived: z.boolean().optional(),
    cursor: p.cursor,
    limit: p.limit(50),
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    if (a.list && !a.board) throw new ToolError('`list` needs `board`.');
    const boardId = a.board ? await resolveBoard(ctx, a.board, a.workspace) : undefined;
    const board = boardId ? await getBoard(ctx, boardId) : undefined;
    const slug = board ? await workspaceSlugById(ctx, board.workspace_id) : await workspaceSlug(ctx, a.workspace);
    const [assignees, labels] = await Promise.all([
      a.assignee?.length ? resolveUsers(ctx, a.assignee, slug) : undefined,
      a.label?.length
        ? boardId
          ? resolveLabels(ctx, boardId, a.label)
          : workspaceLabelIds(ctx, slug, a.label)
        : undefined,
    ]);
    const r = await ctx.api.call<Page<TaskSummary>>('listTasks', {
      query: {
        board_id: boardId,
        workspace: boardId ? undefined : slug,
        list_id: board && a.list ? resolveList(board, a.list).id : undefined,
        assignee: assignees,
        label: labels,
        q: a.query,
        due_from: a.due_after,
        due_to: a.due_before,
        updated_since: a.updated_since,
        archived: a.include_archived ? 'true' : undefined,
        cursor: a.cursor,
        limit: a.limit ?? 50,
      },
    });
    const listName = (id: string) => board?.lists.find((l) => l.id === id)?.name;
    return render(
      a.response_format,
      r,
      () =>
        lines(
          r.data.map((t) => taskLine(t, { list: listName(t.list_id) })),
          'No tasks match.',
        ) + more(r.next_cursor),
    );
  },
});

async function workspaceLabelIds(ctx: ToolContext, slug: string, names: string[]) {
  const { data } = await ctx.api.call<Page<Label>>('listWorkspaceLabels', { params: { slug } });
  return names.map((n) => {
    const l = data.find((x) => x.name.toLowerCase() === n.trim().toLowerCase() || x.id === n.trim());
    if (!l)
      throw new ToolError(
        `No workspace label "${n}". Board labels need \`board\`; workspace labels: ${data.map((x) => `"${x.name}"`).join(', ') || 'none'}.`,
      );
    return l.id;
  });
}

export const getTask = defineTool({
  name: 'get_task',
  title: 'Show a task',
  description:
    'sol2flow: one task in full: list, assignees, labels, dates, estimate, description (Markdown), checklist (with ' +
    'item ids), links to other tasks and the latest comments.',
  scope: 'read',
  ops: [...RESOLVE_OPS, 'getTask', 'listTaskLinks', 'listComments'],
  input: {
    task: p.task,
    workspace: p.workspace,
    comments: z
      .number()
      .int()
      .min(0)
      .max(50)
      .optional()
      .describe('How many of the newest comments (default 5; 0: none)'),
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const n = a.comments ?? 5;
    const [t, links, comments] = await Promise.all([
      ctx.api.call<Task>('getTask', { params: { taskId: id }, query: { format: 'markdown' } }),
      ctx.api.call<{ data: TaskLink[] }>('listTaskLinks', { params: { taskId: id } }).catch(optional),
      n
        ? ctx.api.call<Page<Comment>>('listComments', {
            params: { taskId: id },
            query: { limit: n, order: 'newest', format: 'markdown' },
          })
        : null,
    ]);
    return render(a.response_format, { ...t, links: links?.data ?? null, comments: comments?.data ?? null }, () =>
      taskView(t, links?.data ?? null, comments?.data ?? null, Boolean(comments?.next_cursor)),
    );
  },
});

/** An optional part of an answer: an older instance without the endpoint leaves it out. */
function optional(e: unknown): null {
  if (e instanceof ApiError && e.unknownEndpoint) return null;
  throw e;
}

/* ───────────── write ───────────── */

export const createTask = defineTool({
  name: 'create_task',
  title: 'Create a task',
  description:
    'sol2flow: create a task on a board, in a list (default: the first list), with an optional Markdown description, ' +
    'labels (names), assignees ("me", usernames or names), dates and an estimate. Editors and board admins.',
  scope: 'full',
  ops: [...RESOLVE_OPS, ...RESOLVE_PEOPLE_OPS, 'getBoard', 'listBoardLabels', 'createTask'],
  destructive: false,
  idempotent: false,
  params: TASK_PARAMS,
  input: {
    board: p.board,
    workspace: p.workspace,
    list: z.string().max(200).optional().describe('List name or id (default: the first list)'),
    title: z.string().trim().min(1).max(500),
    description: description.optional(),
    labels: z.array(z.string().max(100)).max(20).optional(),
    assignees: z.array(z.string().max(200)).max(20).optional(),
    start_date: p.day.optional(),
    due_date: p.day.optional(),
    estimate: estimate.optional(),
    position: z.enum(['top', 'bottom']).optional().describe('Where in the list (default bottom)'),
  },
  async run(ctx, a) {
    const boardId = await resolveBoard(ctx, a.board, a.workspace);
    const board = await getBoard(ctx, boardId);
    const list = a.list ? resolveList(board, a.list) : board.lists[0];
    if (!list) throw new ToolError(`Board ${board.key} has no lists yet: create_list adds one.`);
    const slug = a.assignees?.length ? await workspaceSlugById(ctx, board.workspace_id) : '';
    const [labelIds, assigneeIds] = await Promise.all([
      resolveLabels(ctx, boardId, a.labels ?? []),
      a.assignees?.length ? resolveUsers(ctx, a.assignees, slug) : [],
    ]);
    const t = await ctx.api.call<Task>('createTask', {
      body: {
        board_id: boardId,
        list_id: list.id,
        title: a.title,
        description: a.description,
        format: a.description !== undefined ? 'markdown' : undefined,
        label_ids: labelIds.length ? labelIds : undefined,
        assignee_ids: assigneeIds.length ? assigneeIds : undefined,
        start_date: a.start_date,
        due_date: a.due_date,
        estimate: a.estimate,
        position: a.position,
      },
    });
    return `Created ${t.key} "${t.title}" in ${t.list.name}. ${t.url}`;
  },
});

type Step = { name: string; run: () => Promise<unknown> };

/** Runs steps in order; the first failure stops the rest, and the report says what was and wasn't applied. */
async function runSteps(ctx: ToolContext, tool: ToolDef, steps: Step[], what: string): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    try {
      await steps[i]!.run();
      done.push(`✓ ${steps[i]!.name}`);
    } catch (e) {
      const reason = describeError(e, {
        tool: tool.name,
        appUrl: ctx.appUrl,
        apiVersion: ctx.api.apiVersion,
        params: tool.params,
        write: true,
      });
      const rest = steps.slice(i + 1).map((s) => `– ${s.name}: not attempted`);
      throw new ToolError(
        [`${what}: stopped at a failed step.`, ...done, `✗ ${steps[i]!.name}: ${reason}`, ...rest].join('\n'),
      );
    }
  }
  return done;
}

export const updateTask = defineTool({
  name: 'update_task',
  title: 'Update a task',
  description:
    'sol2flow: change a task: title, description (Markdown), start/due date, estimate (null clears), labels and ' +
    'assignees (set all, or add/remove some), and the list it is in. Fields left out stay as they are. The changes are ' +
    'applied step by step and the answer lists each step.',
  scope: 'full',
  ops: [
    ...RESOLVE_OPS,
    ...RESOLVE_PEOPLE_OPS,
    'getTask',
    'getBoard',
    'listBoardLabels',
    'updateTask',
    'setTaskLabels',
    'setTaskAssignees',
    'moveTask',
  ],
  destructive: true,
  idempotent: true,
  params: TASK_PARAMS,
  input: {
    task: p.task,
    workspace: p.workspace,
    title: z.string().trim().min(1).max(500).optional(),
    description: z.union([description, z.null()]).optional().describe('Markdown; null clears it'),
    start_date: dayOrNull.optional(),
    due_date: dayOrNull.optional(),
    estimate: z.union([estimate, z.null()]).optional(),
    labels: z.array(z.string().max(100)).max(20).optional().describe('Replace all labels with these (names)'),
    add_labels: z.array(z.string().max(100)).max(20).optional(),
    remove_labels: z.array(z.string().max(100)).max(20).optional(),
    assignees: z.array(z.string().max(200)).max(20).optional().describe('Replace all assignees with these'),
    add_assignees: z.array(z.string().max(200)).max(20).optional(),
    remove_assignees: z.array(z.string().max(200)).max(20).optional(),
    list: z.string().max(200).optional().describe('Move to this list of the same board (to the bottom)'),
  },
  async run(ctx, a) {
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const fields: Record<string, unknown> = {};
    if (a.title !== undefined) fields.title = a.title;
    if (a.description !== undefined) {
      fields.description = a.description;
      if (a.description !== null) fields.format = 'markdown';
    }
    if (a.start_date !== undefined) fields.start_date = a.start_date;
    if (a.due_date !== undefined) fields.due_date = a.due_date;
    if (a.estimate !== undefined) fields.estimate = a.estimate;
    const wantsLabels = a.labels || a.add_labels?.length || a.remove_labels?.length;
    const wantsPeople = a.assignees || a.add_assignees?.length || a.remove_assignees?.length;
    if (!Object.keys(fields).length && !wantsLabels && !wantsPeople && !a.list)
      throw new ToolError('Nothing to change: pass at least one field.');

    // what the steps need, resolved before anything is changed (a bad name fails without a half-applied update)
    const current =
      wantsLabels || wantsPeople || a.list
        ? await ctx.api.call<Task>('getTask', { params: { taskId: id } })
        : undefined;
    let labelIds: string[] | undefined;
    let assigneeIds: string[] | undefined;
    let listId: string | undefined;
    if (current) {
      const board = a.list || wantsPeople ? await getBoard(ctx, current.board_id) : undefined;
      if (board && a.list) listId = resolveList(board, a.list).id;
      if (wantsLabels) {
        const base = a.labels ? await resolveLabels(ctx, current.board_id, a.labels) : current.labels.map((l) => l.id);
        const add = await resolveLabels(ctx, current.board_id, a.add_labels ?? []);
        const remove = new Set(await resolveLabels(ctx, current.board_id, a.remove_labels ?? []));
        labelIds = [...new Set([...base, ...add])].filter((x) => !remove.has(x));
      }
      if (wantsPeople) {
        const slug = await workspaceSlugById(ctx, board!.workspace_id);
        const base = a.assignees ? await resolveUsers(ctx, a.assignees, slug) : current.assignees.map((u) => u.id);
        const add = await resolveUsers(ctx, a.add_assignees ?? [], slug);
        const remove = new Set(await resolveUsers(ctx, a.remove_assignees ?? [], slug));
        assigneeIds = [...new Set([...base, ...add])].filter((x) => !remove.has(x));
      }
    }

    const steps: Step[] = [];
    if (Object.keys(fields).length)
      steps.push({
        name: `fields (${Object.keys(fields)
          .filter((k) => k !== 'format')
          .join(', ')})`,
        run: () => ctx.api.call('updateTask', { params: { taskId: id }, body: fields }),
      });
    if (labelIds)
      steps.push({
        name: `labels (${labelIds.length})`,
        run: () => ctx.api.call('setTaskLabels', { params: { taskId: id }, body: { label_ids: labelIds } }),
      });
    if (assigneeIds)
      steps.push({
        name: `assignees (${assigneeIds.length})`,
        run: () => ctx.api.call('setTaskAssignees', { params: { taskId: id }, body: { user_ids: assigneeIds } }),
      });
    if (listId && listId !== current?.list_id)
      steps.push({
        name: 'list',
        run: () => ctx.api.call('moveTask', { params: { taskId: id }, body: { list_id: listId } }),
      });
    const done = await runSteps(ctx, updateTask, steps, 'Update');
    const t = await ctx.api.call<Task>('getTask', { params: { taskId: id } }).catch(() => null);
    return [`Updated ${t?.key ?? a.task}${t ? ` "${t.title}" (in ${t.list.name})` : ''}:`, ...done].join('\n');
  },
});

export const moveTask = defineTool({
  name: 'move_task',
  title: 'Move a task',
  description:
    'sol2flow: move a task to another list and/or position (top, bottom, or before/after another task), or to a ' +
    'list of another board in the same workspace (the task then gets a new key there; the old key still finds it).',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'getTask', 'getBoard', 'listTasks', 'moveTask', 'moveTaskToBoard'],
  destructive: false,
  idempotent: true,
  params: TASK_PARAMS,
  input: {
    task: p.task,
    workspace: p.workspace,
    list: z
      .string()
      .max(200)
      .optional()
      .describe("Target list (name or id); default the task's current list, or the first list of `board`"),
    board: p.board.optional().describe('Another board to move it to (same workspace)'),
    position: z.enum(['top', 'bottom']).optional().describe('Default bottom'),
    before: z.string().max(500).optional().describe('Place directly before this task (key or id), in the target list'),
    after: z.string().max(500).optional().describe('Place directly after this task (key or id), in the target list'),
  },
  async run(ctx, a) {
    if ([a.position, a.before, a.after].filter(Boolean).length > 1)
      throw new ToolError('Give only one of position, before and after.');
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const task = await ctx.api.call<Task>('getTask', { params: { taskId: id } });
    const targetBoardId = a.board ? await resolveBoard(ctx, a.board, a.workspace) : task.board_id;

    if (targetBoardId !== task.board_id) {
      if (a.before || a.after) throw new ToolError('Across boards only position top or bottom is possible.');
      const target = await getBoard(ctx, targetBoardId);
      const list = a.list ? resolveList(target, a.list) : target.lists[0];
      if (!list) throw new ToolError(`Board ${target.key} has no lists.`);
      const t = await ctx.api.call<Task>('moveTaskToBoard', {
        params: { taskId: id },
        body: { board_id: targetBoardId, list_id: list.id, position: a.position ?? 'bottom' },
      });
      return `Moved ${task.key} to board ${target.key}, list ${list.name}: it is now ${t.key}. ${t.url}`;
    }

    const board = await getBoard(ctx, task.board_id);
    const list = a.list ? resolveList(board, a.list) : board.lists.find((l) => l.id === task.list_id)!;
    let body: { list_id: string; previous_id?: string | null; next_id?: string | null } = { list_id: list.id };
    if (a.position === 'top' || a.before || a.after) {
      const { items } = await ctx.api.all<TaskSummary>('listTasks', {
        query: { board_id: board.id, list_id: list.id },
        maxItems: 1000,
      });
      const order = items.filter((t) => t.id !== id).sort((x, y) => (x.position < y.position ? -1 : 1));
      if (a.position === 'top') body = order[0] ? { list_id: list.id, next_id: order[0].id } : body;
      else {
        const anchorId = (await resolveTask(ctx, (a.before ?? a.after)!, a.workspace)).id;
        const i = order.findIndex((t) => t.id === anchorId);
        if (i < 0) throw new ToolError(`${a.before ?? a.after} isn't in list ${list.name} of board ${board.key}.`);
        body = a.before
          ? { list_id: list.id, previous_id: order[i - 1]?.id ?? null, next_id: order[i]!.id }
          : { list_id: list.id, previous_id: order[i]!.id, next_id: order[i + 1]?.id ?? null };
      }
    }
    await ctx.api.call<Task>('moveTask', { params: { taskId: id }, body });
    const where = a.before
      ? `before ${a.before}`
      : a.after
        ? `after ${a.after}`
        : (a.position ?? 'bottom') === 'top'
          ? 'at the top'
          : 'at the bottom';
    return `Moved ${task.key} to ${list.name}, ${where}.`;
  },
});

export const archiveTask = defineTool({
  name: 'archive_task',
  title: 'Archive a task',
  description:
    'sol2flow: archive a task. It leaves lists, search and counts, stays in timesheets and exports, and is read-only ' +
    'until unarchive_task. Already archived: no change. (Deleting is not offered: archiving is the safe way.)',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'archiveTask'],
  destructive: true,
  idempotent: true,
  input: { task: p.task, workspace: p.workspace },
  async run(ctx, a) {
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const t = await ctx.api.call<Task>('archiveTask', { params: { taskId: id } });
    return `Archived ${t.key} "${t.title}". unarchive_task brings it back.`;
  },
});

export const unarchiveTask = defineTool({
  name: 'unarchive_task',
  title: 'Unarchive a task',
  description: 'sol2flow: bring an archived task back into its list (the first list if that one is gone).',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'unarchiveTask'],
  destructive: false,
  idempotent: true,
  input: { task: p.task, workspace: p.workspace },
  async run(ctx, a) {
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const t = await ctx.api.call<Task>('unarchiveTask', { params: { taskId: id } });
    return `Unarchived ${t.key} "${t.title}": back in ${t.list.name}.`;
  },
});
