/*
 * Errors, and how they reach the model: every failure becomes a tool result with `isError: true` and a text the model
 * (and the person) can act on — what happened, and what to do about it. docs: MCP server → Troubleshooting.
 */

/** The API answered with an error body: `{ "error": { "code", "message", "field"?, … } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly retryAfter?: number;
  readonly kind?: string;
  readonly feature?: string;
  readonly limit?: number;
  readonly used?: number;
  readonly max?: number;
  readonly op: string;

  constructor(op: string, status: number, body: unknown, retryAfterHeader?: string | null) {
    const e = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    super(str(e.message) ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.op = op;
    this.status = status;
    this.code = str(e.code) ?? (status >= 500 ? 'internal' : `http_${status}`);
    this.field = str(e.field);
    const header = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    this.retryAfter = num(e.retry_after) ?? (header !== undefined && Number.isFinite(header) ? header : undefined);
    this.kind = str(e.kind);
    this.feature = str(e.feature);
    this.limit = num(e.limit);
    this.used = num(e.used);
    this.max = num(e.max);
  }

  /** The app's answer for a path it doesn't know (an older instance). */
  get unknownEndpoint() {
    return this.status === 404 && /^No such endpoint/i.test(this.message);
  }
}

/** No answer: network error or timeout. For a write, the outcome is unknown. */
export class TransportError extends Error {
  constructor(
    readonly op: string,
    readonly write: boolean,
    readonly timeout: boolean,
    readonly reason: string,
  ) {
    super(`${op}: ${reason}`);
    this.name = 'TransportError';
  }
}

/** Something the server itself refuses or can't resolve (a reference that matches nothing, ambiguous names, …). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export type ErrorContext = {
  tool: string;
  /** the instance, for links */
  appUrl: string;
  /** the API version seen, if any */
  apiVersion: string | null;
  /** maps an API request field (`label_ids`) to the tool parameter the model sent (`labels`) */
  params?: Record<string, string>;
  /** a write tool: an unknown outcome needs a "check first" */
  write: boolean;
};

function minutes(sec: number) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The text a failed tool call returns. */
export function describeError(e: unknown, c: ErrorContext): string {
  if (e instanceof ToolError) return e.message;
  if (e instanceof TransportError) {
    if (c.write)
      return (
        `No answer from sol2flow (${e.reason}). ${c.tool} may or may not have been applied: check first ` +
        `(e.g. with get_task) before trying again.`
      );
    return `Couldn't reach sol2flow at ${c.appUrl} (${e.reason}). Try again in a moment; if it persists, check SOL2FLOW_URL and the network.`;
  }
  if (!(e instanceof ApiError)) return `Unexpected error in ${c.tool}. Try again; if it persists, report it.`;

  const keys = `${c.appUrl}/settings/api-keys`;
  const param = e.field ? (c.params?.[e.field.split('.')[0]!] ?? e.field) : undefined;
  if (e.unknownEndpoint)
    return (
      `This sol2flow instance (API ${c.apiVersion ?? 'older than 1.8'}) is too old for ${c.tool}. ` +
      `Ask its admin to update sol2flow.`
    );
  switch (e.code) {
    case 'unauthenticated':
      return (
        `sol2flow refused the API key: it is unknown, expired or revoked, or its account can't sign in. ` +
        `Create a key in sol2flow → Settings → API keys (${keys}) and update it where this MCP server is configured ` +
        `(SOL2FLOW_API_KEY, or the "Authorization: Bearer" header in your MCP client).`
      );
    case 'api_disabled':
      return 'API keys are switched off on this sol2flow instance (Admin → General → API → "Allow API keys"). Ask the instance admin.';
    case 'api_disabled_workspace':
      return 'API access is switched off for this workspace (Workspace settings → API access). Ask a workspace admin to switch it on.';
    case 'plan_feature':
      return e.feature === 'api' || !e.feature
        ? "The organization's plan doesn't include the REST API, which this MCP server uses. An owner or admin of the organization can upgrade the plan in sol2flow (Organization settings → Plan)."
        : `The organization's plan doesn't include ${e.feature}. An owner or admin can upgrade the plan.`;
    case 'plan_read_only':
      return "The organization's workspaces are read-only: its subscription is past due or has ended. Reading still works; changes need an owner to renew the plan.";
    case 'plan_limit':
      if (e.kind === 'apiCalls')
        return (
          `The organization's plan allows ${e.limit ?? 'a limited number of'} API requests per day and they are used up; ` +
          `the limit resets at midnight UTC${e.retryAfter ? ` (in ${minutes(e.retryAfter)})` : ''}.`
        );
      return `The plan limit for ${e.kind ?? 'this'} is reached (${e.used ?? '?'} of ${e.limit ?? '?'}). Upgrade the plan or remove some first.`;
    case 'insufficient_scope':
      return (
        `This API key is read-only, so ${c.tool} can't change anything. Use a key with full access ` +
        `(Settings → API keys, ${keys}), or start the server with --read-only to hide the tools that write.`
      );
    case 'guest_viewer_only':
      return 'Guests can only be viewers: they can read but not change this. Ask a workspace admin.';
    case 'support_read_only':
    case 'reauth_required':
      return `${e.message} This can't be done with an API key; use the app.`;
    case 'forbidden':
      return `You don't have permission for this (${e.message.replace(/\.$/, '')}): your role on the board or workspace doesn't allow it (viewers and guests can read but not edit).`;
    case 'not_found':
      return "Not found, or you don't have access to it (sol2flow doesn't say which). Check the reference; search finds tasks and boards by name or key.";
    case 'task_archived':
      return 'The task is archived and read-only. Call unarchive_task first, then try again.';
    case 'board_archived':
      return 'The board is archived and read-only. Restore it in the app first.';
    case 'link_exists':
      return 'These tasks are already linked (one link per pair and type, whatever the direction).';
    case 'label_scope':
      return "That label belongs to another board: a task can carry only the workspace's labels and its own board's.";
    case 'file_too_large':
      return `The request is too large${e.max ? ` (at most ${e.max} MB)` : ''}. Shorten the text and try again.`;
    case 'rate_limited':
      return (
        `sol2flow's rate limit is reached (per key: 600 requests per 10 minutes, at most 120 of them changes). ` +
        `Try again in ${minutes(e.retryAfter ?? 60)}.`
      );
  }
  if (e.status === 422 || e.status === 400)
    return param ? `Invalid ${param}: ${e.message}` : `sol2flow refused the input: ${e.message}`;
  if (e.status === 409) return `Conflict: ${e.message}`;
  if (e.status === 413) return 'The request is too large. Shorten the text and try again.';
  if (e.status === 405) return `This sol2flow instance doesn't allow ${e.op}; it may be too old for ${c.tool}.`;
  if (e.status >= 500)
    return (
      `sol2flow had a server error (HTTP ${e.status}).` +
      (c.write
        ? ` ${c.tool} may or may not have been applied: check first before trying again.`
        : ' Try again later.') +
      ' If it persists, tell the instance admin.'
    );
  return `sol2flow answered HTTP ${e.status} ${e.code}: ${e.message}`;
}
