import { readFileSync } from 'node:fs';

/*
 * Settings from the environment and the command line (README.md → Configuration). Pure: the environment and argv are
 * passed in, so the unit tests need no process state.
 *
 * The API key comes only from SOL2FLOW_API_KEY or SOL2FLOW_API_KEY_FILE, never from a flag: a flag would show in `ps`.
 * In HTTP mode the key comes from each request's Authorization header and SOL2FLOW_API_KEY is ignored.
 */

export type Transport = 'stdio' | 'http';

export type Config = {
  transport: Transport;
  /** the sol2flow instance, normalised to …/api/v1 (no trailing slash) */
  apiBase: string;
  /** the instance's origin, for messages ("Settings → API keys at …") */
  appUrl: string;
  /** stdio only */
  apiKey: string | undefined;
  /** the default workspace slug (SOL2FLOW_WORKSPACE) */
  workspace: string | undefined;
  /** hide the write tools */
  readOnly: boolean;
  http: {
    host: string;
    port: number;
    /** Host header values accepted (host or host:port); empty = any (only sensible behind a proxy that checks it) */
    allowedHosts: string[];
    /** Origin header values accepted; empty = only localhost origins; '*' = any */
    allowedOrigins: string[];
    trustProxyHops: number;
    forwardClientIp: boolean;
    maxInFlight: number;
  };
  log: { level: string };
};

export class ConfigError extends Error {}

export const DEFAULT_URL = 'https://app.sol2flow.com';

/** Variables that may come from a file (Docker secrets): X_FILE names a file whose content is X. */
export const SECRET_VARS = Object.freeze(['SOL2FLOW_API_KEY', 'SENTRY_DSN']);

/**
 * `*_FILE` variables, as in the app and the official postgres image: one trailing newline is stripped; X and X_FILE
 * both set, or an unreadable file, is an error naming the variable and the path, never the value.
 */
export function resolveFileEnv(
  env: Record<string, string | undefined>,
  names: readonly string[] = SECRET_VARS,
  read: (file: string) => string = (f) => readFileSync(f, 'utf8'),
) {
  for (const name of names) {
    const fileVar = `${name}_FILE`;
    const file = env[fileVar];
    if (!file) continue;
    if (env[name]) throw new ConfigError(`both ${name} and ${fileVar} are set; set only one of them`);
    let value: string;
    try {
      value = read(file);
    } catch (e) {
      throw new ConfigError(`${fileVar}: cannot read ${file} (${(e as NodeJS.ErrnoException)?.code ?? 'error'})`);
    }
    env[name] = value.replace(/\r?\n$/, '');
    delete env[fileVar];
  }
  return env;
}

const TRUE = /^(1|true|yes|on)$/i;
const list = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** `https://app.example.com`, `…/api`, `…/api/v1/` → `https://app.example.com/api/v1`. */
export function normaliseBaseUrl(raw: string): { apiBase: string; appUrl: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError(`SOL2FLOW_URL is not a URL: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new ConfigError(`SOL2FLOW_URL must be http(s): ${u.protocol}`);
  if (u.username || u.password) throw new ConfigError('SOL2FLOW_URL must not contain credentials');
  u.search = '';
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
  const appUrl = u.origin + path;
  return { apiBase: appUrl + '/api/v1', appUrl };
}

export type Cli = {
  help: boolean;
  version: boolean;
  transport?: Transport;
  readOnly: boolean;
  port?: number;
  host?: string;
};

export function parseArgs(argv: string[]): Cli {
  const cli: Cli = { help: false, version: false, readOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] =
      a.startsWith('--') && a.includes('=')
        ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
        : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new ConfigError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        cli.help = true;
        break;
      case '-v':
      case '--version':
        cli.version = true;
        break;
      case '--stdio':
        cli.transport = 'stdio';
        break;
      case '--http':
        cli.transport = 'http';
        break;
      case '--read-only':
        cli.readOnly = true;
        break;
      case '--port':
        cli.port = port(value(), '--port');
        break;
      case '--host':
        cli.host = value();
        break;
      case '--api-key':
        throw new ConfigError('there is no --api-key flag (it would show in the process list): set SOL2FLOW_API_KEY');
      default:
        throw new ConfigError(`unknown argument: ${a} (see --help)`);
    }
  }
  return cli;
}

function port(raw: string, name: string) {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n < 1 || n > 65535) throw new ConfigError(`${name} must be a port number: ${raw}`);
  return n;
}

function nonNegativeInt(raw: string | undefined, name: string, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be a whole number: ${raw}`);
  return Number(raw);
}

export function loadConfig(env: Record<string, string | undefined>, cli: Cli): Config {
  const rawTransport = (cli.transport ?? env.MCP_TRANSPORT?.trim() ?? 'stdio').toLowerCase();
  if (rawTransport !== 'stdio' && rawTransport !== 'http')
    throw new ConfigError(`MCP_TRANSPORT must be stdio or http: ${rawTransport}`);
  const transport = rawTransport as Transport;
  const { apiBase, appUrl } = normaliseBaseUrl(env.SOL2FLOW_URL?.trim() || DEFAULT_URL);
  const host = cli.host ?? (env.HOST?.trim() || '127.0.0.1');
  return {
    transport,
    apiBase,
    appUrl,
    apiKey: transport === 'stdio' ? env.SOL2FLOW_API_KEY?.trim() || undefined : undefined,
    workspace: env.SOL2FLOW_WORKSPACE?.trim() || undefined,
    readOnly: cli.readOnly || TRUE.test(env.READ_ONLY?.trim() ?? ''),
    http: {
      host,
      port: cli.port ?? (env.PORT?.trim() ? port(env.PORT, 'PORT') : 3000),
      allowedHosts: list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase()),
      allowedOrigins: list(env.ALLOWED_ORIGINS),
      trustProxyHops: nonNegativeInt(env.TRUST_PROXY_HOPS, 'TRUST_PROXY_HOPS', 0),
      forwardClientIp: TRUE.test(env.FORWARD_CLIENT_IP?.trim() ?? ''),
      maxInFlight: nonNegativeInt(env.MAX_IN_FLIGHT, 'MAX_IN_FLIGHT', 100) || 100,
    },
    log: { level: env.LOG_LEVEL?.trim() || 'info' },
  };
}

export const HELP = `sol2flow-mcp: an MCP server for sol2flow (https://sol2flow.com)

Usage: sol2flow-mcp [--stdio | --http] [--read-only] [--host <addr>] [--port <n>]

  --stdio        talk MCP over stdin/stdout (default; for Claude Desktop, Claude Code, Cursor, VS Code)
  --http         serve Streamable HTTP on --host/--port (default 127.0.0.1:3000); each request brings its own key
                 in "Authorization: Bearer sf_…"
  --read-only    hide the tools that change anything
  --version      print the version
  --help         this text

Environment:
  SOL2FLOW_URL          your sol2flow, e.g. https://app.sol2flow.com (default) or your own instance
  SOL2FLOW_API_KEY      an API key from Settings → API keys (stdio only); or SOL2FLOW_API_KEY_FILE
  SOL2FLOW_WORKSPACE    the default workspace slug
  READ_ONLY=true        same as --read-only
  MCP_TRANSPORT         stdio | http
  HOST, PORT, ALLOWED_HOSTS, ALLOWED_ORIGINS, TRUST_PROXY_HOPS, FORWARD_CLIENT_IP   (HTTP mode)
  LOG_LEVEL, LOG_FILE, SENTRY_DSN

Docs: https://docs.sol2flow.com/docs/integrations/mcp
`;
