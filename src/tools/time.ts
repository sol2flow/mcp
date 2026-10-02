import { z } from 'zod';
import { ToolError } from '../api/errors.js';
import type { GetTimer, Page, StartTimerResponse, StopTimerResponse, TimeEntry } from '../api/types.js';
import { notificationLine, timeEntryLine } from '../format/entities.js';
import { dateTime, duration, lines, more, render } from '../format/text.js';
import {
  getBoard,
  resolveBoard,
  resolveTask,
  resolveUser,
  UUID,
  workspaceSlug,
  workspaceSlugById,
} from '../resolve/refs.js';
import type { Notification } from '../api/types.js';
import { defineTool, p, RESOLVE_OPS, RESOLVE_PEOPLE_OPS } from './registry.js';

/** "1h30m", "1.5h", "90m", "45 min", "2 hours"; a bare number is minutes. Seconds, or null when unreadable. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60);
  const re = /(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)(?![a-z])/g;
  let total = 0,
    matched = '';
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * (m[2]!.startsWith('h') ? 3600 : 60);
    matched += m[0];
  }
  if (!matched || s.replace(re, '').replace(/[\s,and]+/g, '') !== '') return null;
  return Math.round(total);
}

const durationParam = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe('How long: "1h30m", "1.5h", "45m"; a bare number is minutes (1 min to 24 h)');

function seconds(raw: string) {
  const s = parseDuration(raw);
  if (s === null) throw new ToolError(`Can't read the duration "${raw}": use e.g. "1h30m", "90m" or "1.5h".`);
  if (s < 60 || s > 86_400) throw new ToolError('The duration must be between 1 minute and 24 hours.');
  return s;
}

const instant = z.iso.datetime({ offset: true }).describe('ISO 8601 timestamp, e.g. 2026-10-02T09:00:00Z');
const dayOrInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'a day (YYYY-MM-DD) or an ISO 8601 timestamp')
  .describe('A day (YYYY-MM-DD, UTC) or an ISO 8601 timestamp');
const toInstant = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);

export const listTimeEntries = defineTool({
  name: 'list_time_entries',
  title: 'List time entries',
  description:
    'sol2flow: logged time in a workspace, newest first, optionally for one board, task or person, and a period. You ' +
    'see your own entries; board and workspace admins see more.',
  scope: 'read',
  ops: [...RESOLVE_OPS, ...RESOLVE_PEOPLE_OPS, 'getBoard', 'listTimeEntries'],
  params: { user_id: 'user', task_id: 'task', board_id: 'board' },
  input: {
    workspace: p.workspace,
    board: p.board.optional(),
    task: p.task.optional(),
    user: z.string().max(200).optional().describe('"me", a username or name (others need an admin role)'),
    from: dayOrInstant.optional().describe('Started at or after (a day or a timestamp)'),
    to: dayOrInstant.optional().describe('Started before (a day or a timestamp)'),
    cursor: p.cursor,
    limit: p.limit(50),
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    const boardId = a.board ? await resolveBoard(ctx, a.board, a.workspace) : undefined;
    const slug = boardId
      ? await workspaceSlugById(ctx, (await getBoard(ctx, boardId)).workspace_id)
      : await workspaceSlug(ctx, a.workspace);
    const [task, user] = await Promise.all([
      a.task ? resolveTask(ctx, a.task, slug) : undefined,
      a.user ? resolveUser(ctx, a.user, slug) : undefined,
    ]);
    const r = await ctx.api.call<Page<TimeEntry>>('listTimeEntries', {
      query: {
        workspace: slug,
        board_id: boardId,
        task_id: task?.id,
        user_id: user,
        from: toInstant(a.from),
        to: toInstant(a.to),
        cursor: a.cursor,
        limit: a.limit ?? 50,
      },
    });
    const total = r.data.reduce((s, e) => s + e.duration_sec, 0);
    return render(
      a.response_format,
      r,
      () =>
        lines(r.data.map(timeEntryLine), 'No time entries.') +
        (r.data.length ? `\n\nTotal on this page: ${duration(total)}` : '') +
        more(r.next_cursor),
    );
  },
});

export const getTimer = defineTool({
  name: 'get_timer',
  title: 'Running timer',
  description: 'sol2flow: your running timer, if any (task and start time).',
  scope: 'read',
  ops: ['getTimer'],
  input: { response_format: p.responseFormat },
  async run(ctx, a) {
    const r = await ctx.api.call<GetTimer>('getTimer');
    return render(a.response_format, r, () =>
      r.timer
        ? `Timer running on **${r.timer.task_key}** "${r.timer.title}" since ${dateTime(r.timer.started_at)} ` +
          `(${duration((Date.now() - Date.parse(r.timer.started_at)) / 1000)}).`
        : 'No timer is running.',
    );
  },
});

export const logTime = defineTool({
  name: 'log_time',
  title: 'Log time',
  description:
    'sol2flow: log time spent on a task (1 minute to 24 hours), with an optional note. Without `started_at` the entry ' +
    'ends now.',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'logTime'],
  destructive: false,
  idempotent: false,
  params: { duration_sec: 'duration', started_at: 'started_at', note: 'note', task_id: 'task' },
  input: {
    task: p.task,
    workspace: p.workspace,
    duration: durationParam,
    started_at: instant.optional(),
    note: z.string().max(500).optional(),
  },
  async run(ctx, a) {
    const sec = seconds(a.duration);
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const startedAt = a.started_at ?? new Date(Date.now() - sec * 1000).toISOString();
    const e = await ctx.api.call<TimeEntry>('logTime', {
      body: { task_id: id, started_at: startedAt, duration_sec: sec, note: a.note },
    });
    return `Logged ${duration(e.duration_sec)} on ${e.task_key} from ${dateTime(e.started_at)} (entry id ${e.id}).`;
  },
});

export const startTimer = defineTool({
  name: 'start_timer',
  title: 'Start a timer',
  description:
    'sol2flow: start your timer on a task. One timer at a time: a timer running on another task is stopped and its ' +
    'time logged.',
  scope: 'full',
  ops: [...RESOLVE_OPS, 'startTimer'],
  destructive: true,
  idempotent: false,
  input: { task: p.task, workspace: p.workspace },
  async run(ctx, a) {
    const { id } = await resolveTask(ctx, a.task, a.workspace);
    const r = await ctx.api.call<StartTimerResponse>('startTimer', { body: { task_id: id } });
    return (
      `Timer started on ${r.timer.task_key} "${r.timer.title}".` +
      (r.stopped ? ` Stopped the timer on ${r.stopped.task_key} (${duration(r.stopped.duration_sec)} logged).` : '')
    );
  },
});

export const stopTimer = defineTool({
  name: 'stop_timer',
  title: 'Stop the timer',
  description: 'sol2flow: stop your running timer; its time is logged on the task.',
  scope: 'full',
  ops: ['stopTimer'],
  destructive: false,
  idempotent: true,
  input: {},
  async run(ctx) {
    const r = await ctx.api.call<StopTimerResponse>('stopTimer');
    return r.stopped
      ? `Stopped the timer on ${r.stopped.task_key}: ${duration(r.stopped.duration_sec)} logged (entry id ${r.stopped.id}).`
      : 'No timer was running.';
  },
});

export const updateTimeEntry = defineTool({
  name: 'update_time_entry',
  title: 'Change a time entry',
  description:
    'sol2flow: change one of your time entries (id from list_time_entries): start, duration or note (null clears ' +
    'it). A running timer only takes a note.',
  scope: 'full',
  ops: ['updateTimeEntry'],
  destructive: true,
  idempotent: true,
  params: { duration_sec: 'duration' },
  input: {
    entry_id: z.string().trim(),
    started_at: instant.optional(),
    duration: durationParam.optional(),
    note: z.union([z.string().max(500), z.null()]).optional(),
  },
  async run(ctx, a) {
    if (!UUID.test(a.entry_id)) throw new ToolError('entry_id must be the id from list_time_entries.');
    if (a.started_at === undefined && a.duration === undefined && a.note === undefined)
      throw new ToolError('Nothing to change: pass started_at, duration or note.');
    const e = await ctx.api.call<TimeEntry>('updateTimeEntry', {
      params: { entryId: a.entry_id },
      body: { started_at: a.started_at, duration_sec: a.duration ? seconds(a.duration) : undefined, note: a.note },
    });
    return `Updated: ${timeEntryLine(e).slice(2)}`;
  },
});

/* ───────────── notifications ───────────── */

export const listNotifications = defineTool({
  name: 'list_notifications',
  title: 'List notifications',
  description: 'sol2flow: your notifications, newest change first (assignments, mentions, comments, due dates, …).',
  scope: 'read',
  ops: ['listNotifications'],
  input: {
    unread_only: z.boolean().optional(),
    cursor: p.cursor,
    limit: p.limit(30),
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    const r = await ctx.api.call<Page<Notification>>('listNotifications', {
      query: { unread: a.unread_only ? 'true' : undefined, cursor: a.cursor, limit: a.limit ?? 30 },
    });
    return render(
      a.response_format,
      r,
      () =>
        lines(r.data.map(notificationLine), a.unread_only ? 'No unread notifications.' : 'No notifications.') +
        more(r.next_cursor),
    );
  },
});

export const markNotificationsRead = defineTool({
  name: 'mark_notifications_read',
  title: 'Mark notifications read',
  description: 'sol2flow: mark notifications read: the given ids (from list_notifications), or all of them.',
  scope: 'full',
  ops: ['markNotification', 'markAllNotificationsRead'],
  destructive: false,
  idempotent: true,
  input: {
    ids: z.array(z.string().trim()).max(50).optional(),
    all: z.boolean().optional().describe('true: mark every notification read'),
  },
  async run(ctx, a) {
    if (a.all) {
      await ctx.api.call('markAllNotificationsRead');
      return 'All notifications marked read.';
    }
    if (!a.ids?.length) throw new ToolError('Pass `ids` or `all: true`.');
    const bad = a.ids.filter((i) => !UUID.test(i));
    if (bad.length) throw new ToolError(`Not notification ids: ${bad.join(', ')}.`);
    for (const id of a.ids)
      await ctx.api.call('markNotification', { params: { notificationId: id }, body: { read: true } });
    return `Marked ${a.ids.length} notification(s) read.`;
  },
});
