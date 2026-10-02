import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient, type CallRecord } from './api/client.js';
import { log } from './log.js';
import { registerPrompts } from './prompts.js';
import { fingerprint, refCache } from './resolve/cache.js';
import { TOOLS } from './tools/index.js';
import { registerTools } from './tools/registry.js';
import { USER_AGENT, VERSION } from './version.js';

/*
 * One MCP server for one API key (README.md → How it works): stdio builds it once at start, the HTTP transport once per
 * request with that request's key. tools/list never calls the API.
 */

export const INSTRUCTIONS = `This server works with sol2flow (kanban boards and tasks) through its REST API, as the owner of the API key: the same permissions as in the app.

- Refer to tasks by key (PRD-12), app URL or id; boards by key (PRD), name or URL; people as "me", @username or name; lists and labels by name.
- The workspace is the \`workspace\` parameter, else the configured default, else your only workspace. whoami shows which.
- Descriptions and comments are Markdown. Results are compact Markdown; response_format "json" gives the raw data.
- Writes are never retried automatically. If one reports that it may or may not have been applied, check (e.g. get_task) before repeating it.
- Deleting is not offered: archive_task hides a task and unarchive_task brings it back.`;

export type ServerOptions = {
  apiBase: string;
  appUrl: string;
  /** undefined: no key configured (every tool says how to set one) */
  apiKey: string | undefined;
  defaultWorkspace: string | undefined;
  readOnly: boolean;
  /** a problem found at start (stdio: the key was refused); every tool returns it */
  unavailable?: () => string | undefined;
  clientIp?: string;
  /** the API refused the key during a call */
  onRefused?: () => void;
  logFields?: Record<string, unknown>;
  fetch?: typeof fetch;
};

export const keyPrefix = (key: string | undefined) => /^sf_([0-9A-Za-z]{8})_/.exec(key ?? '')?.[1];

export function createServer(o: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'sol2flow', title: 'sol2flow', version: VERSION, websiteUrl: 'https://sol2flow.com' },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
  );
  const fp = o.apiKey ? fingerprint(o.apiKey) : 'none';
  const logFields = { ...o.logFields, key: undefined, key_prefix: keyPrefix(o.apiKey) };
  registerTools(server, TOOLS, {
    readOnly: o.readOnly,
    logFields,
    unavailable: () =>
      o.apiKey
        ? o.unavailable?.()
        : 'No sol2flow API key is configured. Create one in sol2flow → Settings → API keys and set SOL2FLOW_API_KEY ' +
          'in this MCP server\'s configuration (or send "Authorization: Bearer <key>" to the HTTP endpoint).',
    context: (tool, signal) => ({
      tool,
      appUrl: o.appUrl,
      defaultWorkspace: o.defaultWorkspace,
      fp,
      cache: refCache,
      api: new ApiClient({
        apiBase: o.apiBase,
        apiKey: o.apiKey ?? '',
        userAgent: USER_AGENT,
        clientIp: o.clientIp,
        signal,
        fetch: o.fetch,
        onRefused: o.onRefused,
        onCall: (r: CallRecord) => log.debug({ ...logFields, tool, ...r }, 'api call'),
      }),
    }),
  });
  registerPrompts(server);
  return server;
}
