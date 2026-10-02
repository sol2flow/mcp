import type { ApiClient } from '../api/client.js';
import type { Me, Workspace } from '../api/types.js';
import type { TtlCache } from '../resolve/cache.js';

/** What a tool's handler gets: a client bound to the caller's key and this call's deadline, and the shared cache. */
export type ToolContext = {
  tool: string;
  api: ApiClient;
  /** the instance's origin, for messages */
  appUrl: string;
  /** SOL2FLOW_WORKSPACE, or `?workspace=` on the HTTP endpoint */
  defaultWorkspace: string | undefined;
  /** the API key's fingerprint: the cache's namespace */
  fp: string;
  cache: TtlCache<unknown>;
};

const ME_TTL_MS = 60_000;

/** `GET /me`, cached for a minute per key. */
export async function me(ctx: ToolContext): Promise<Me> {
  const k = `${ctx.fp}:me`;
  const hit = ctx.cache.get(k) as Me | undefined;
  if (hit) return hit;
  const m = await ctx.api.call<Me>('getMe');
  ctx.cache.set(k, m, ME_TTL_MS);
  return m;
}

/** The workspaces the key can open (at most 500), cached for a minute per key. */
export async function workspaces(ctx: ToolContext): Promise<Workspace[]> {
  const k = `${ctx.fp}:workspaces`;
  const hit = ctx.cache.get(k) as Workspace[] | undefined;
  if (hit) return hit;
  const { items } = await ctx.api.all<Workspace>('listWorkspaces', { maxItems: 500 });
  ctx.cache.set(k, items, ME_TTL_MS);
  return items;
}
