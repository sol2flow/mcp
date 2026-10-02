import type {
  Board,
  BoardDetail,
  ChecklistItem,
  Comment,
  Label,
  Notification,
  SearchResult,
  Task,
  TaskLink,
  TaskSummary,
  TimeEntry,
  Workspace,
} from '../api/types.js';
import { date, dateTime, duration, people } from './text.js';

/* Compact Markdown for each kind of thing. Keys (PRD-12) lead, because the model refers to tasks by key. */

const labels = (ls: { name: string }[] | undefined) => (ls?.length ? ' ' + ls.map((l) => `[${l.name}]`).join(' ') : '');

/** `- **PRD-12** Title · due 2026-10-05 · @ana [bug]` */
export function taskLine(t: TaskSummary, o: { list?: string } = {}): string {
  const bits = [`- **${t.key}** ${t.title}`];
  if (o.list) bits.push(`in ${o.list}`);
  if (t.start_date) bits.push(`start ${t.start_date}`);
  if (t.due_date) bits.push(`due ${t.due_date}`);
  if (t.assignees.length) bits.push(people(t.assignees));
  if (t.estimate_display) bits.push(`est. ${t.estimate_display}`);
  if (t.archived) bits.push('(archived)');
  return bits.join(' · ') + labels(t.labels);
}

export function workspaceLine(w: Workspace): string {
  return `- **${w.slug}**: ${w.name} (you: ${w.role.toLowerCase()}${w.is_private ? ', private' : ''}${
    w.organization ? `, organization ${w.organization.name}` : ''
  })`;
}

export function boardLine(b: Board): string {
  return `- **${b.key}** ${b.name} · ${b.task_count} tasks · you: ${b.role.toLowerCase()}${b.archived ? ' · archived' : ''}`;
}

/** A board with its lists, each with its tasks in board order. */
export function boardView(b: BoardDetail, tasks: TaskSummary[] | null, moreTasks: boolean): string {
  const out = [
    `# ${b.name} (${b.key})`,
    `Board id ${b.id} · ${b.task_count} tasks · access ${b.access.toLowerCase()} · you: ${b.role.toLowerCase()}` +
      `${b.archived ? ' · archived (read-only)' : ''}`,
    b.url,
  ];
  for (const l of b.lists) {
    out.push('', `## ${l.name} (${l.task_count})`);
    if (!tasks) continue;
    const mine = tasks.filter((t) => t.list_id === l.id).sort((x, y) => (x.position < y.position ? -1 : 1));
    out.push(mine.length ? mine.map((t) => taskLine(t)).join('\n') : '_(empty)_');
  }
  if (!b.lists.length) out.push('', '_No lists yet: create_list adds one._');
  if (moreTasks) out.push('', '_Not every task is shown: list_tasks with `board` and `list` pages through the rest._');
  return out.join('\n');
}

function checklistLines(items: ChecklistItem[]) {
  return [...items]
    .sort((a, b) => (a.position < b.position ? -1 : 1))
    .map((c, i) => `${i + 1}. [${c.done ? 'x' : ' '}] ${c.text} <!-- id ${c.id} -->`);
}

function commentBlock(c: Comment | NonNullable<Comment['replies']>[number], indent = ''): string {
  const who = c.author?.name ?? 'someone';
  const text = c.deleted ? '_(deleted)_' : ((c as { markdown?: string | null }).markdown ?? c.text ?? '').trim();
  const body = text
    .split('\n')
    .map((l) => indent + '  ' + l)
    .join('\n');
  return `${indent}- ${who}, ${dateTime(c.created_at)}${c.edited_at ? ' (edited)' : ''} <!-- id ${c.id} -->\n${body}`;
}

export function taskView(t: Task, links: TaskLink[] | null, comments: Comment[] | null, moreComments: boolean): string {
  const out = [`# ${t.key}: ${t.title}`];
  const facts = [
    `List: ${t.list.name}`,
    t.archived ? `Archived ${date(t.archived_at)} (read-only: unarchive_task first)` : '',
    t.assignees.length ? `Assignees: ${people(t.assignees)}` : 'Assignees: none',
    t.members.length ? `Members: ${people(t.members)}` : '',
    t.labels.length ? `Labels: ${t.labels.map((l) => l.name).join(', ')}` : '',
    t.start_date ? `Start: ${t.start_date}` : '',
    t.due_date ? `Due: ${t.due_date}` : '',
    t.estimate_display ? `Estimate: ${t.estimate_display}` : '',
    t.logged_sec ? `Time logged: ${duration(t.logged_sec)}` : '',
    `Created ${dateTime(t.created_at)}${t.creator ? ` by ${t.creator.name}` : ''} · updated ${dateTime(t.updated_at)}`,
    `Id ${t.id} · ${t.url}`,
  ].filter(Boolean);
  out.push(facts.map((f) => `- ${f}`).join('\n'));
  const description = (t.description_markdown ?? t.description_text ?? '').trim();
  out.push('', '## Description', description || '_(none)_');
  if (t.checklist.length)
    out.push('', `## Checklist (${t.counts.checklist_done}/${t.counts.checklist})`, ...checklistLines(t.checklist));
  if (links?.length)
    out.push(
      '',
      '## Links',
      ...links.map(
        (l) =>
          `- ${l.kind.replace('_', ' ')} **${l.task.key}** ${l.task.title} (${l.task.list}${l.task.open ? '' : ', done'}${
            l.task.archived ? ', archived' : ''
          })`,
      ),
    );
  if (comments)
    out.push(
      '',
      `## Comments (${t.counts.comments}${moreComments ? `, newest ${comments.length} shown` : ''})`,
      comments.length
        ? comments
            .map((c) => [commentBlock(c), ...(c.replies ?? []).map((r) => commentBlock(r, '  '))].join('\n'))
            .join('\n')
        : '_(none)_',
    );
  if (t.counts.attachments) out.push('', `_${t.counts.attachments} attachment(s): open the task in the app._`);
  return out.join('\n');
}

export function labelLine(l: Label): string {
  return `- ${l.name} (${l.color}${l.scope === 'board' ? ', board label' : ', workspace label'}) <!-- id ${l.id} -->`;
}

export function searchView(r: SearchResult, q: string): string {
  const out: string[] = [];
  if (r.boards.length)
    out.push('## Boards', ...r.boards.map((b) => `- **${b.key}** ${b.name} · ${b.tasks} tasks in ${b.lists} lists`));
  if (r.tasks.length) out.push('## Tasks', ...r.tasks.map((t) => `- **${t.key}** ${t.title} · ${t.where}`));
  if (!out.length) return `Nothing found for "${q}". Archived boards and tasks aren't searched.`;
  if (r.more) out.push(`\n_${r.more} more tasks match: refine the query._`);
  return out.join('\n');
}

export function timeEntryLine(e: TimeEntry): string {
  return (
    `- ${dateTime(e.started_at)} · **${e.task_key}** · ${e.running ? 'running' : duration(e.duration_sec)} · ${e.user_name}` +
    `${e.note ? ` · "${e.note}"` : ''} <!-- id ${e.id} -->`
  );
}

export function notificationLine(n: Notification): string {
  const what = n.type.replace(/_/g, ' ');
  const task = n.task ? ` **${n.task.key}** ${n.task.title}${n.task.deleted ? ' (deleted)' : ''}` : '';
  const where = n.board ? ` on ${n.board}` : '';
  return (
    `- ${n.read ? '' : '**unread** · '}${what}${task}${where}${n.actor ? ` by ${n.actor.name}` : ''}` +
    `${n.count > 1 ? ` (${n.count}×)` : ''} · ${dateTime(n.updated_at)} <!-- id ${n.id} -->`
  );
}
