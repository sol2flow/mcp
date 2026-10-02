import { ToolError } from '../api/errors.js';
import type {
  BoardDetail,
  Board,
  Label,
  List,
  MemberOrInvitation,
  Page,
  SearchResult,
  TaskSummary,
} from '../api/types.js';
import { me, workspaces, type ToolContext } from '../tools/context.js';

/*
 * References the model may use instead of UUIDs (README.md → References). Task paths in the API take UUIDs only; keys
 * like PRD-12 go through `GET /workspaces/{slug}/search`, which matches exact keys and the old key of a moved task.
 * Results are cached for 10 minutes per API key (src/resolve/cache.ts).
 *
 * - task: UUID, key (`PRD-12`), or an app URL (`https://…/w/acme/b/PRD/t/12`)
 * - board: UUID, key (`PRD`), name, or an app URL (`…/w/acme/b/PRD`)
 * - list, label: name or UUID (within the board)
 * - user: `me`, username (with or without @), name, or UUID
 * - workspace: slug; default the parameter, then SOL2FLOW_WORKSPACE / `?workspace=`, then the only workspace
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_KEY = /^([\p{L}\p{N}]+)-(\d+)$/u;
const MAX_WORKSPACE_FANOUT = 10;

export type AppPath = { workspace: string; boardKey: string; number?: number };

/** `/w/<slug>/b/<KEY>[/t/<n>]` in an app URL (any origin, an optional language prefix), else null. */
export function parseAppUrl(ref: string): AppPath | null {
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    return null;
  }
  const m = /^(?:\/[a-z]{2})?\/w\/([^/]+)\/b\/([^/]+)(?:\/t\/(\d+))?\/?$/i.exec(u.pathname);
  if (!m) return null;
  return {
    workspace: decodeURIComponent(m[1]!),
    boardKey: decodeURIComponent(m[2]!),
    number: m[3] ? Number(m[3]) : undefined,
  };
}

const norm = (s: string) => s.trim().toLowerCase();

/** The one workspace to use, or the candidates to try when none is chosen and there are several. */
async function workspaceCandidates(ctx: ToolContext, explicit?: string): Promise<string[]> {
  const chosen = explicit?.trim() || ctx.defaultWorkspace;
  if (chosen) return [chosen];
  const all = await workspaces(ctx);
  if (!all.length) throw new ToolError("This account isn't in any workspace yet.");
  return all.map((w) => w.slug);
}

/** The workspace slug: the parameter, the default, or the only workspace. Several and none chosen: an error naming them. */
export async function workspaceSlug(ctx: ToolContext, explicit?: string): Promise<string> {
  const c = await workspaceCandidates(ctx, explicit);
  if (c.length === 1) return c[0]!;
  throw new ToolError(
    `You are in ${c.length} workspaces (${c.slice(0, 20).join(', ')}${c.length > 20 ? ', …' : ''}): pass \`workspace\` ` +
      `(the slug), or set SOL2FLOW_WORKSPACE.`,
  );
}

/** The slug of a workspace by id (boards and tasks name their workspace by id). */
export async function workspaceSlugById(ctx: ToolContext, id: string): Promise<string> {
  const w = (await workspaces(ctx)).find((x) => x.id === id);
  if (!w) throw new ToolError('That workspace is not among the ones you can open.');
  return w.slug;
}

async function search(ctx: ToolContext, slug: string, q: string) {
  return ctx.api.call<SearchResult>('search', { params: { slug }, query: { q } });
}

async function cached<T>(ctx: ToolContext, key: string, f: () => Promise<T | null>): Promise<T | null> {
  const k = `${ctx.fp}:${key}`;
  const hit = ctx.cache.get(k) as T | undefined;
  if (hit !== undefined) return hit;
  const v = await f();
  if (v !== null) ctx.cache.set(k, v);
  return v;
}

/** In each candidate workspace (in parallel), the first non-null answer; several workspaces answering: ambiguous. */
async function acrossWorkspaces<T>(
  ctx: ToolContext,
  explicit: string | undefined,
  what: string,
  f: (slug: string) => Promise<T | null>,
): Promise<{ slug: string; value: T }> {
  const slugs = await workspaceCandidates(ctx, explicit);
  if (slugs.length > MAX_WORKSPACE_FANOUT) await workspaceSlug(ctx, explicit); // throws: too many to search
  const found: { slug: string; value: T }[] = [];
  for (const r of await Promise.all(slugs.map(async (slug) => ({ slug, value: await f(slug) }))))
    if (r.value !== null) found.push({ slug: r.slug, value: r.value });
  if (found.length === 1) return found[0]!;
  if (!found.length)
    throw new ToolError(
      `No ${what}${slugs.length === 1 ? ` in workspace ${slugs[0]}` : ' in your workspaces'}, or you have no access to it. ` +
        `Use search to find it.`,
    );
  throw new ToolError(
    `${what} exists in several workspaces (${found.map((r) => r.slug).join(', ')}): pass \`workspace\`.`,
  );
}

/** A task key in one workspace → its id, or null. */
async function taskIdByKey(ctx: ToolContext, slug: string, key: string): Promise<string | null> {
  return cached(ctx, `task:${slug}:${key.toUpperCase()}`, async () => {
    const r = await search(ctx, slug, key);
    const exact = r.tasks.find((t) => norm(t.key) === norm(key));
    if (exact) return exact.id;
    // the old key of a moved task: a hit whose current key and title don't contain what was searched
    const redirected = r.tasks.filter((t) => !norm(t.title).includes(norm(key)) && norm(t.key) !== norm(key));
    if (redirected.length === 1 && r.tasks.length === 1) return redirected[0]!.id;
    // archived tasks, and the tasks of archived boards, aren't in search: look on the board (by its exact key, archived
    // boards included) through its tasks with the archived ones (the first 300 by last change)
    const boardKey = TASK_KEY.exec(key)![1]!;
    const board =
      exactBoard(r.boards, boardKey) ??
      exactBoard((await search(ctx, slug, boardKey)).boards, boardKey) ??
      exactBoard((await archivedBoards(ctx, slug)).data, boardKey);
    if (!board) return null;
    const { items } = await ctx.api.all<TaskSummary>('listTasks', {
      query: { board_id: board.id, archived: 'true' },
      maxItems: 300,
    });
    return items.find((t) => norm(t.key) === norm(key))?.id ?? null;
  });
}

const exactBoard = <B extends { key: string }>(boards: B[], key: string) =>
  boards.find((b) => norm(b.key) === norm(key));

/** A workspace's archived boards (search leaves them out). Not filtered by `q`: it matches names, not keys. */
const archivedBoards = (ctx: ToolContext, slug: string) =>
  ctx.api.call<Page<Board>>('listBoards', { params: { slug }, query: { archived: 'true', limit: 100 } });

export type TaskRef = { id: string; key?: string };

/** A task reference → its id. */
export async function resolveTask(ctx: ToolContext, ref: string, workspace?: string): Promise<TaskRef> {
  const r = ref.trim();
  if (UUID.test(r)) return { id: r.toLowerCase() };
  const url = parseAppUrl(r);
  if (url) {
    if (url.number === undefined) throw new ToolError(`${r} is a board URL, not a task URL.`);
    const key = `${url.boardKey}-${url.number}`;
    const id = await taskIdByKey(ctx, url.workspace, key);
    if (!id) throw new ToolError(`No task ${key} in workspace ${url.workspace}, or you have no access to it.`);
    return { id, key };
  }
  if (!TASK_KEY.test(r))
    throw new ToolError(
      `"${r}" isn't a task reference: use the task's key (like PRD-12), its URL or its id. search finds tasks by title.`,
    );
  const { value } = await acrossWorkspaces(ctx, workspace, `task ${r.toUpperCase()}`, (slug) =>
    taskIdByKey(ctx, slug, r),
  );
  return { id: value, key: r.toUpperCase() };
}

type BoardHit = { id: string; key: string; name: string };

async function boardInWorkspace(ctx: ToolContext, slug: string, ref: string): Promise<BoardHit | null> {
  return cached(ctx, `board:${slug}:${norm(ref)}`, async () => {
    const r = await search(ctx, slug, ref);
    const exact = r.boards.find((b) => norm(b.key) === norm(ref)) ?? r.boards.find((b) => norm(b.name) === norm(ref));
    if (exact) return { id: exact.id, key: exact.key, name: exact.name };
    // archived boards aren't in search: an exact key or name there wins over a live board that merely contains the
    // text (archived "AS" must not resolve to a live "Bulk tasks")
    const archived = await archivedBoards(ctx, slug);
    const a =
      archived.data.find((b) => norm(b.key) === norm(ref)) ?? archived.data.find((b) => norm(b.name) === norm(ref));
    if (a) return { id: a.id, key: a.key, name: a.name };
    if (r.boards.length === 1) return { id: r.boards[0]!.id, key: r.boards[0]!.key, name: r.boards[0]!.name };
    if (r.boards.length > 1)
      throw new ToolError(
        `"${ref}" matches several boards in ${slug}: ${r.boards.map((b) => `${b.name} (${b.key})`).join(', ')}. ` +
          `Use the board's key.`,
      );
    return null;
  });
}

/** A board reference → its id. */
export async function resolveBoard(ctx: ToolContext, ref: string, workspace?: string): Promise<string> {
  const r = ref.trim();
  if (UUID.test(r)) return r.toLowerCase();
  const url = parseAppUrl(r);
  if (url) {
    const b = await boardInWorkspace(ctx, url.workspace, url.boardKey);
    if (!b) throw new ToolError(`No board ${url.boardKey} in workspace ${url.workspace}, or you have no access to it.`);
    return b.id;
  }
  const { value } = await acrossWorkspaces(ctx, workspace, `board "${r}"`, (slug) => boardInWorkspace(ctx, slug, r));
  return value.id;
}

/** A list of the board, by id or name (exact, then the only one starting with / containing it). */
export function resolveList(board: BoardDetail, ref: string): List {
  const r = ref.trim();
  const names = () => board.lists.map((l) => `"${l.name}"`).join(', ');
  const byId = board.lists.find((l) => l.id === r.toLowerCase());
  if (byId) return byId;
  const exact = board.lists.filter((l) => norm(l.name) === norm(r));
  if (exact.length === 1) return exact[0]!;
  const loose = exact.length ? exact : board.lists.filter((l) => norm(l.name).includes(norm(r)));
  if (loose.length === 1) return loose[0]!;
  if (!loose.length) throw new ToolError(`No list "${r}" on board ${board.key}. Its lists: ${names() || 'none'}.`);
  throw new ToolError(
    `"${r}" matches several lists on board ${board.key}: ${loose.map((l) => `"${l.name}"`).join(', ')}.`,
  );
}

/** The board's lists (with the board), cached for the call. */
export async function getBoard(ctx: ToolContext, boardId: string): Promise<BoardDetail> {
  return ctx.api.call<BoardDetail>('getBoard', { params: { boardId } });
}

/** Label ids from names or ids, among the labels usable on the board. */
export async function resolveLabels(ctx: ToolContext, boardId: string, refs: string[]): Promise<string[]> {
  if (!refs.length) return [];
  const { data } = await ctx.api.call<Page<Label>>('listBoardLabels', { params: { boardId } });
  const ids: string[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const r = ref.trim();
    const l = data.find((x) => x.id === r.toLowerCase()) ?? data.find((x) => norm(x.name) === norm(r));
    if (l) ids.push(l.id);
    else missing.push(r);
  }
  if (missing.length)
    throw new ToolError(
      `Unknown label${missing.length > 1 ? 's' : ''} on this board: ${missing.map((m) => `"${m}"`).join(', ')}. ` +
        `Labels here: ${data.map((l) => `"${l.name}"`).join(', ') || 'none'}. create_label adds one.`,
    );
  return [...new Set(ids)];
}

async function userInWorkspace(ctx: ToolContext, slug: string, ref: string): Promise<string> {
  const hit = await cached(ctx, `user:${slug}:${norm(ref)}`, async () => {
    const q = ref.replace(/^@/, '');
    const r = await ctx.api.call<Page<MemberOrInvitation>>('listMembers', {
      params: { slug },
      query: { q, limit: 50 },
    });
    const users = r.data.flatMap((m) => ('user' in m && m.type === 'member' ? [m.user] : []));
    const match =
      users.filter((u) => norm(u.username) === norm(q)).at(0) ??
      (users.filter((u) => norm(u.name) === norm(q)).length === 1
        ? users.find((u) => norm(u.name) === norm(q))
        : undefined) ??
      (users.length === 1 ? users[0] : undefined);
    if (match) return match.id;
    if (users.length > 1)
      throw new ToolError(
        `"${ref}" matches several people in ${slug}: ${users
          .slice(0, 10)
          .map((u) => `${u.name} (@${u.username})`)
          .join(', ')}. Use the username.`,
      );
    return null;
  });
  if (!hit) throw new ToolError(`Nobody called "${ref}" in workspace ${slug}. list_people shows who is there.`);
  return hit;
}

/** A person → user id: `me`, a UUID, a username or a name (in the workspace). */
export async function resolveUser(ctx: ToolContext, ref: string, slug: string): Promise<string> {
  const r = ref.trim();
  if (norm(r) === 'me') return (await me(ctx)).id;
  if (UUID.test(r)) return r.toLowerCase();
  return userInWorkspace(ctx, slug, r);
}

export async function resolveUsers(ctx: ToolContext, refs: string[], slug: string): Promise<string[]> {
  const ids = await Promise.all(refs.map((r) => resolveUser(ctx, r, slug)));
  return [...new Set(ids)];
}
