import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient } from '../api/client.js';
import { ApiError, describeError } from '../api/errors.js';
import type { Me } from '../api/types.js';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { createServer, keyPrefix } from '../server.js';
import { USER_AGENT } from '../version.js';

/*
 * stdio (README.md → Local setup): for Claude Desktop, Claude Code, Cursor, VS Code. stdout carries only JSON-RPC;
 * logs go to stderr (src/log.ts). At start, one `GET /me` checks the key and reads the API version and the key's scope
 * (API 1.8+): a read-only key hides the write tools. If the key is refused, the server still starts and every tool
 * answers with the reason; a network problem at start only logs a warning (the tools try again).
 */

const STARTUP_TIMEOUT_MS = 10_000;

export type StartupCheck = { readOnly: boolean; unavailable?: string; apiVersion: string | null };

export async function checkKey(config: Config, fetchImpl?: typeof fetch): Promise<StartupCheck> {
  if (!config.apiKey) {
    log.warn('SOL2FLOW_API_KEY is not set: every tool will say how to set it');
    return { readOnly: config.readOnly, apiVersion: null };
  }
  const api = new ApiClient({
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    userAgent: USER_AGENT,
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
    fetch: fetchImpl,
  });
  try {
    const me = await api.call<Me>('getMe');
    const scope = me.api_key?.scope;
    log.info(
      {
        url: config.appUrl,
        api_version: api.apiVersion ?? 'unknown (1.7 or older)',
        key_prefix: keyPrefix(config.apiKey),
        scope: scope ?? 'unknown',
      },
      'connected to sol2flow',
    );
    if (scope === 'read' && !config.readOnly) log.info('read-only API key: the write tools are hidden');
    return { readOnly: config.readOnly || scope === 'read', apiVersion: api.apiVersion };
  } catch (e) {
    const fatal = e instanceof ApiError && (e.status === 401 || e.status === 403);
    const message = describeError(e, {
      tool: 'sol2flow',
      appUrl: config.appUrl,
      apiVersion: api.apiVersion,
      write: false,
    });
    log.warn(
      {
        url: config.appUrl,
        status: e instanceof ApiError ? e.status : undefined,
        code: e instanceof ApiError ? e.code : undefined,
      },
      fatal ? 'the API key was refused' : 'could not check the API key at start; continuing',
    );
    return { readOnly: config.readOnly, unavailable: fatal ? message : undefined, apiVersion: api.apiVersion };
  }
}

export async function runStdio(config: Config) {
  // stdout is the protocol channel: anything printed by mistake must not corrupt it
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => console.error(...args);
  // the client went away (stdout closed): stop quietly. A closed stdin ends the process once pending calls finish.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
  });
  const check = await checkKey(config);
  const server = createServer({
    apiBase: config.apiBase,
    appUrl: config.appUrl,
    apiKey: config.apiKey,
    defaultWorkspace: config.workspace,
    readOnly: check.readOnly,
    unavailable: () => check.unavailable,
  });
  await server.connect(new StdioServerTransport());
  log.info({ transport: 'stdio', read_only: check.readOnly }, 'MCP server ready');
}
