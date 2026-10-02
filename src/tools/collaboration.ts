import { z } from 'zod';
import { ToolError } from '../api/errors.js';
import type { ChecklistItem, Comment, Task, TaskLink } from '../api/types.js';
import { resolveTask, UUID } from '../resolve/refs.js';
import { defineTool, p, RESOLVE_OPS } from './registry.js';

const LINK_KINDS = ['blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicated_by'] as const;

export const addComment = defineTool({
  name: 'add_comment',
  title: 'Comment on a task',
  description:
    'sol2flow: add a comment (Markdown) to a task, or a reply to a top-level comment (reply_to: its id from get_task). ' +
    'Mention someone with @[Name](user:<user id>): they are notified.',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'addComment'],
  destructive: false,
  idempotent: false,
  params: { text: 'text', parent_id: 'reply_to' },
  input: {
    task: p.task,
    workspace: p.workspace,
    text: z.string().trim().min(1).max(10_000).describe('Markdown (GFM)'),
    reply_to: z.string().trim().optional().describe('Id of the top-level comment to reply to'),
  },
  async run(ctx, a) {
    if (a.reply_to && !UUID.test(a.reply_to)) throw new ToolError('reply_to must be a comment id (from get_task).');
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const c = await ctx.api.call<Comment>('addComment', {
      params: { taskId: id },
      body: { text: a.text, format: 'markdown', parent_id: a.reply_to },
    });
    return `${a.reply_to ? 'Replied' : 'Commented'} on ${a.task} (comment id ${c.id}).`;
  },
});

export const addChecklistItems = defineTool({
  name: 'add_checklist_items',
  title: 'Add checklist items',
  description: "sol2flow: add items to the end of a task's checklist, in the order given (one request each).",
  scope: 'full',
  ops: [...RESOLVE_OPS, 'addChecklistItem'],
  destructive: false,
  idempotent: false,
  input: {
    task: p.task,
    workspace: p.workspace,
    items: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
  },
  async run(ctx, a) {
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const added: string[] = [];
    for (const text of a.items) {
      try {
        await ctx.api.call<ChecklistItem>('addChecklistItem', { params: { taskId: id }, body: { text } });
        added.push(text);
      } catch (e) {
        if (!added.length) throw e;
        const rest = a.items.slice(added.length).map((t) => `- not added: ${t}`);
        throw new ToolError(
          [`Added ${added.length} of ${a.items.length} items, then a request failed:`, ...rest].join('\n') +
            `\n(${e instanceof Error ? e.message : 'error'})`,
        );
      }
    }
    return `Added ${added.length} checklist item(s) to ${a.task}.`;
  },
});

export const updateChecklistItem = defineTool({
  name: 'update_checklist_item',
  title: 'Tick or edit a checklist item',
  description:
    'sol2flow: tick or untick a checklist item, or change its text. The item: its id (from get_task), or with `task` ' +
    'its number (1 = first) or its text.',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'getTask', 'updateChecklistItem'],
  destructive: true,
  idempotent: true,
  input: {
    item: z.string().trim().min(1).max(500).describe('Item id, or its number or text (then `task` is needed)'),
    task: p.task.optional(),
    workspace: p.workspace,
    done: z.boolean().optional(),
    text: z.string().trim().min(1).max(500).optional(),
  },
  async run(ctx, a) {
    if (a.done === undefined && a.text === undefined) throw new ToolError('Pass `done` and/or `text`.');
    let itemId = UUID.test(a.item) ? a.item.toLowerCase() : undefined;
    if (!itemId) {
      if (!a.task) throw new ToolError('Without an item id, `task` is needed to find the item.');
      const { id } = await resolveTask(ctx, a.task, a.workspace);
      const t = await ctx.api.call<Task>('getTask', { params: { taskId: id } });
      const items = [...t.checklist].sort((x, y) => (x.position < y.position ? -1 : 1));
      const n = /^\d+$/.test(a.item) ? Number(a.item) : NaN;
      const byText = items.filter((c) => c.text.trim().toLowerCase() === a.item.toLowerCase());
      const loose = byText.length ? byText : items.filter((c) => c.text.toLowerCase().includes(a.item.toLowerCase()));
      const hit = Number.isInteger(n) && items[n - 1] ? items[n - 1] : loose.length === 1 ? loose[0] : undefined;
      if (!hit)
        throw new ToolError(
          loose.length > 1
            ? `"${a.item}" matches ${loose.length} items; use the number or the id.`
            : `No checklist item "${a.item}" on ${t.key} (${items.length} items).`,
        );
      itemId = hit.id;
    }
    const c = await ctx.api.call<ChecklistItem>('updateChecklistItem', {
      params: { itemId },
      body: { done: a.done, text: a.text },
    });
    return `Checklist item ${c.done ? 'ticked' : 'open'}: "${c.text}".`;
  },
});

export const linkTasks = defineTool({
  name: 'link_tasks',
  title: 'Link two tasks',
  description:
    'sol2flow: link a task to another task of the same workspace. kind, seen from `task`: blocks, blocked_by, ' +
    'relates_to, duplicates, duplicated_by (the other task sees the inverse).',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'addTaskLink'],
  destructive: false,
  idempotent: false,
  params: { task_id: 'other_task' },
  input: { task: p.task, kind: z.enum(LINK_KINDS), other_task: p.task, workspace: p.workspace },
  async run(ctx, a) {
    const [from, to] = await Promise.all([
      resolveTask(ctx, a.task, a.workspace),
      resolveTask(ctx, a.other_task, a.workspace),
    ]);
    const l = await ctx.api.call<TaskLink>('addTaskLink', {
      params: { taskId: from.id },
      body: { kind: a.kind, task_id: to.id },
    });
    return `Linked: ${a.task} ${a.kind.replace('_', ' ')} ${l.task.key}.`;
  },
});

export const unlinkTasks = defineTool({
  name: 'unlink_tasks',
  title: 'Remove a link between tasks',
  description: 'sol2flow: remove the link(s) between two tasks; with `kind` only that kind of link.',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'listTaskLinks', 'removeTaskLink'],
  destructive: true,
  idempotent: true,
  input: { task: p.task, other_task: p.task, kind: z.enum(LINK_KINDS).optional(), workspace: p.workspace },
  async run(ctx, a) {
    const [from, to] = await Promise.all([
      resolveTask(ctx, a.task, a.workspace),
      resolveTask(ctx, a.other_task, a.workspace),
    ]);
    const { data } = await ctx.api.call<{ data: TaskLink[] }>('listTaskLinks', { params: { taskId: from.id } });
    const hits = data.filter((l) => l.task.id === to.id && (!a.kind || l.kind === a.kind));
    if (!hits.length)
      return `${a.task} and ${a.other_task} aren't linked${a.kind ? ` as ${a.kind}` : ''}: nothing to do.`;
    for (const l of hits) await ctx.api.call('removeTaskLink', { params: { taskId: from.id, linkId: l.id } });
    return `Removed ${hits.length} link(s) between ${a.task} and ${a.other_task}.`;
  },
});
