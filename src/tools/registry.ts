import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describeError, ApiError, ToolError, TransportError } from '../api/errors.js';
import type { OpId } from '../api/operations.js';
import { log } from '../log.js';
import { captureException } from '../sentry.js';
import type { ToolContext } from './context.js';

/*
 * Tool definitions and their registration (README.md → Tools). Names are `verb_noun` without a prefix; descriptions
 * start with "sol2flow:". Each tool declares the scope it needs and every API operation it may call, so the contract
 * test can check both against the OpenAPI document. Read tools carry readOnlyHint; write tools declare whether they are
 * destructive and idempotent.
 */

export const TOOL_DEADLINE_MS = 45_000;

export type Scope = 'read' | 'full';

export type ToolDef<S extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  /** every API operation the tool may call (reference resolution included) */
  ops: readonly OpId[];
  input: S;
  /** write tools: MCP annotations (read tools are readOnlyHint) */
  destructive?: boolean;
  idempotent?: boolean;
  /** API request field → this tool's parameter, for validation messages ("Invalid due_date: …") */
  params?: Record<string, string>;
  run(ctx: ToolContext, args: z.output<z.ZodObject<S>>): Promise<string>;
};

export const defineTool = <S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef => d as unknown as ToolDef;

export type RegisterOptions = {
  readOnly: boolean;
  /** a client bound to the caller's key and the call's deadline */
  context(tool: string, signal: AbortSignal): ToolContext;
  /** a problem that makes every tool fail the same way (no key, a key refused at start) */
  unavailable?: () => string | undefined;
  /** for logs: the key's public prefix, the client IP */
  logFields?: Record<string, unknown>;
};

export function registerTools(server: McpServer, tools: readonly ToolDef[], o: RegisterOptions) {
  for (const t of tools) {
    if (o.readOnly && t.scope !== 'read') continue;
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations:
          t.scope === 'read'
            ? { title: t.title, readOnlyHint: true, openWorldHint: false }
            : {
                title: t.title,
                readOnlyHint: false,
                destructiveHint: t.destructive ?? false,
                idempotentHint: t.idempotent ?? false,
                openWorldHint: false,
              },
      },
      ((args: Record<string, unknown>, extra: { signal: AbortSignal }) => runTool(t, args, extra.signal, o)) as never,
    );
  }
}

async function runTool(
  t: ToolDef,
  args: Record<string, unknown>,
  clientSignal: AbortSignal,
  o: RegisterOptions,
): Promise<CallToolResult> {
  const started = Date.now();
  const unavailable = o.unavailable?.();
  if (unavailable) {
    log.info({ ...o.logFields, tool: t.name, outcome: 'unavailable' }, 'tool call');
    return { isError: true, content: [{ type: 'text', text: unavailable }] };
  }
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(TOOL_DEADLINE_MS)]);
  const ctx = o.context(t.name, signal);
  try {
    const text = await run(t, ctx, args);
    log.info(
      { ...o.logFields, tool: t.name, outcome: 'ok', ms: Date.now() - started, requests: ctx.api.requests },
      'tool call',
    );
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    const text = describeError(e, {
      tool: t.name,
      appUrl: ctx.appUrl,
      apiVersion: ctx.api.apiVersion,
      params: t.params,
      write: t.scope === 'full',
    });
    const fields = {
      ...o.logFields,
      tool: t.name,
      outcome: 'error',
      ms: Date.now() - started,
      requests: ctx.api.requests,
      ...(e instanceof ApiError ? { status: e.status, code: e.code, op: e.op } : {}),
      ...(e instanceof TransportError ? { op: e.op, transport: e.reason } : {}),
    };
    const expected = e instanceof ToolError || e instanceof TransportError || (e instanceof ApiError && e.status < 500);
    if (expected) log.info(fields, 'tool call');
    else {
      log.error({ ...fields, err: e instanceof ApiError ? undefined : errSummary(e) }, 'tool call failed');
      captureException(e, { tool: t.name, ...(e instanceof ApiError ? { status: e.status, code: e.code } : {}) });
    }
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

async function run(t: ToolDef, ctx: ToolContext, args: Record<string, unknown>) {
  return t.run(ctx, args as never);
}

/** An unexpected error for the log: type and message, the stack (no arguments, no results). */
const errSummary = (e: unknown) =>
  e instanceof Error ? { type: e.name, message: e.message, stack: e.stack } : { type: typeof e };

/* ───────────── shared parameters ───────────── */

export const p = {
  workspace: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Workspace slug (from list_workspaces). Default: the configured workspace, or your only one'),
  task: z.string().trim().min(1).max(500).describe('The task: its key (PRD-12), its URL in the app, or its id'),
  board: z.string().trim().min(1).max(500).describe('The board: its key (PRD), name, URL in the app, or id'),
  responseFormat: z
    .enum(['markdown', 'json'])
    .optional()
    .describe('markdown (default): compact text; json: the API data'),
  cursor: z.string().max(1000).optional().describe('From a previous answer, for the next page'),
  limit: (def: number) => z.number().int().min(1).max(100).optional().describe(`Items per page (default ${def})`),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a day as YYYY-MM-DD')
    .describe('A day, YYYY-MM-DD'),
};

/** Operations every reference may need: task keys and boards (search, archived fallbacks), workspaces, people. */
export const RESOLVE_OPS = ['listWorkspaces', 'search', 'listTasks', 'listBoards'] as const satisfies readonly OpId[];
export const RESOLVE_PEOPLE_OPS = ['getMe', 'listMembers'] as const satisfies readonly OpId[];
