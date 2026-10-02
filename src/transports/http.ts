import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { fingerprint, TtlCache } from '../resolve/cache.js';
import { createServer, keyPrefix } from '../server.js';
import { VERSION } from '../version.js';

/*
 * Streamable HTTP, stateless (README.md → Hosting): each `POST /mcp` builds a new MCP server and transport around that
 * request's key (`Authorization: Bearer sf_…`) and answers with JSON (no SSE streams, no sessions). Nothing is stored
 * but a short list of refused key fingerprints and per-IP counters.
 *
 *   GET /healthz          {status, version}
 *   POST /mcp             MCP (JSON-RPC); ?workspace=<slug> sets the default workspace, ?read_only=1 hides the writes
 *   GET, DELETE /mcp      405 (no SSE stream, no sessions to end)
 *
 * Protections: Host and Origin checks (DNS rebinding), 1 MB bodies, header and request timeouts, at most
 * MAX_IN_FLIGHT requests at once, at most 30 rejected keys per IP per 10 minutes, and a key sol2flow refused isn't sent
 * upstream again for 5 minutes. SOL2FLOW_URL is fixed by the operator: clients can't point the server elsewhere.
 */

export const MAX_BODY = 1024 * 1024;
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const REFUSED_TTL_MS = 5 * 60_000;
const REJECT_WINDOW_MS = 10 * 60_000;
const MAX_REJECTS = 30;
const KEY_RE = /^sf_[0-9A-Za-z]{8}_[0-9A-Za-z]{20,64}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type HttpDeps = { fetch?: typeof fetch; now?: () => number };

const hostOnly = (h: string) => h.replace(/:\d+$/, '').toLowerCase();

export function isLoopbackBind(host: string) {
  return LOOPBACK.has(host) || host.startsWith('127.');
}

/** The Host header is acceptable: listed in ALLOWED_HOSTS (host or host:port); unset: loopback hosts when bound locally. */
export function hostAllowed(host: string | undefined, c: Config['http']) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (c.allowedHosts.length) return c.allowedHosts.some((a) => a === h || (!a.includes(':') && a === hostOnly(h)));
  return isLoopbackBind(c.host) ? LOOPBACK.has(hostOnly(h)) : true;
}

/** No Origin (not a browser): fine. Else listed in ALLOWED_ORIGINS ('*' = any); unset: localhost origins only. */
export function originAllowed(origin: string | undefined, c: Config['http']) {
  if (!origin) return true;
  if (c.allowedOrigins.includes('*') || c.allowedOrigins.includes(origin)) return true;
  if (c.allowedOrigins.length) return false;
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** The client's address: the socket's, or with TRUST_PROXY_HOPS the n-th X-Forwarded-For entry from the right. */
export function clientIp(req: IncomingMessage, hops: number): string {
  const socket = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  if (!hops) return socket;
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return xff.length ? xff[Math.max(0, xff.length - hops)]! : socket;
}

class Rejections {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  private recent(ip: string) {
    const t = this.now() - REJECT_WINDOW_MS;
    const list = (this.hits.get(ip) ?? []).filter((x) => x > t);
    if (list.length) this.hits.set(ip, list);
    else this.hits.delete(ip);
    return list;
  }
  blocked(ip: string) {
    const r = this.recent(ip);
    return r.length >= MAX_REJECTS ? Math.ceil((r[0]! + REJECT_WINDOW_MS - this.now()) / 1000) : 0;
  }
  add(ip: string) {
    if (this.hits.size > 50_000) this.hits.clear(); // a flood of addresses: start over rather than grow without bound
    this.hits.set(ip, [...this.recent(ip), this.now()]);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

const UNAUTHORIZED =
  'A sol2flow API key is required: send "Authorization: Bearer sf_…" (Settings → API keys in sol2flow).';

function readBody(req: IncomingMessage): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > MAX_BODY) {
      req.resume();
      return resolve('too_large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.removeAllListeners('data');
        req.resume();
        resolve('too_large');
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cors(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    Vary: 'Origin',
  };
}

export function createHttpHandler(config: Config, deps: HttpDeps = {}) {
  const now = deps.now ?? Date.now;
  const refused = new TtlCache<true>(REFUSED_TTL_MS, 100_000, now);
  const rejections = new Rejections(now);
  let inFlight = 0;
  const c = config.http;

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const ip = clientIp(req, c.trustProxyHops);
    const done = (status: number, extra: Record<string, unknown> = {}) =>
      log.info({ method: req.method, path: url.pathname, status, ms: now() - started, ip, ...extra }, 'http request');

    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      return send(res, 200, { status: 'ok', version: VERSION });
    }
    if (!hostAllowed(req.headers.host, c)) {
      done(403, { reason: 'host' });
      return send(res, 403, rpcError(-32000, 'Host not allowed (ALLOWED_HOSTS)'));
    }
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not_found' });
    if (!originAllowed(origin, c)) {
      done(403, { reason: 'origin' });
      return send(res, 403, rpcError(-32000, 'Origin not allowed (ALLOWED_ORIGINS)'));
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors(origin),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    if (req.method !== 'POST') {
      done(405);
      return send(
        res,
        405,
        rpcError(-32000, 'Method not allowed: this server is stateless (POST only, no SSE stream)'),
        {
          Allow: 'POST, OPTIONS',
          ...cors(origin),
        },
      );
    }
    if (inFlight >= c.maxInFlight) {
      done(503, { reason: 'busy' });
      return send(res, 503, rpcError(-32000, 'Too many requests at once; try again shortly'), {
        'Retry-After': '5',
        ...cors(origin),
      });
    }
    const wait = rejections.blocked(ip);
    if (wait) {
      done(429, { reason: 'rejected_keys' });
      return send(res, 429, rpcError(-32000, 'Too many requests with invalid API keys from this address'), {
        'Retry-After': String(wait),
        ...cors(origin),
      });
    }
    const auth = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''));
    const key = auth?.[1];
    const authHeaders = {
      'WWW-Authenticate': 'Bearer realm="sol2flow", error="invalid_token"',
      ...cors(origin),
    };
    if (!key || !KEY_RE.test(key)) {
      rejections.add(ip);
      done(401, { reason: key ? 'malformed_key' : 'no_key' });
      return send(res, 401, rpcError(-32001, UNAUTHORIZED), authHeaders);
    }
    const fp = fingerprint(key);
    if (refused.get(fp)) {
      rejections.add(ip);
      done(401, { reason: 'refused_key', key_prefix: keyPrefix(key) });
      return send(res, 401, rpcError(-32001, 'sol2flow refused this API key. ' + UNAUTHORIZED), authHeaders);
    }

    inFlight++;
    try {
      const raw = await readBody(req);
      if (raw === 'too_large') {
        done(413);
        return send(res, 413, rpcError(-32600, 'Request body too large (1 MB at most)'), cors(origin));
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        done(400);
        return send(res, 400, rpcError(-32700, 'Parse error: the body is not JSON'), cors(origin));
      }
      const workspace = url.searchParams.get('workspace')?.trim() || config.workspace;
      const readOnly = config.readOnly || /^(1|true|yes)$/i.test(url.searchParams.get('read_only') ?? '');
      const server = createServer({
        apiBase: config.apiBase,
        appUrl: config.appUrl,
        apiKey: key,
        defaultWorkspace: workspace,
        readOnly,
        clientIp: c.forwardClientIp ? ip : undefined,
        fetch: deps.fetch,
        logFields: { ip },
        onRefused: () => {
          refused.set(fp, true);
          rejections.add(ip);
        },
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      for (const [k, v] of Object.entries(cors(origin))) res.setHeader(k, v);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      const methods = (Array.isArray(body) ? body : [body])
        .map((m) => (m && typeof m === 'object' && 'method' in m ? String((m as { method: unknown }).method) : null))
        .filter(Boolean);
      done(res.statusCode, { rpc: methods.join(','), key_prefix: keyPrefix(key) });
    } catch (e) {
      log.error(
        { err: e instanceof Error ? { type: e.name, message: e.message, stack: e.stack } : String(e) },
        'http request failed',
      );
      send(res, 500, rpcError(-32603, 'Internal error'));
    } finally {
      inFlight--;
    }
  };
}

export function startHttp(config: Config, deps: HttpDeps = {}): Promise<Server> {
  const handler = createHttpHandler(config, deps);
  const server = createHttpServer((req, res) => void handler(req, res));
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function runHttp(config: Config) {
  const c = config.http;
  if (!c.allowedHosts.length && !isLoopbackBind(c.host))
    log.warn(
      { host: c.host },
      'ALLOWED_HOSTS is not set: any Host header is accepted (set it to the public host name)',
    );
  const server = await startHttp(config);
  const addr = server.address();
  log.info(
    {
      transport: 'http',
      listen: typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : addr,
      upstream: config.appUrl,
      read_only: config.readOnly,
    },
    'MCP server ready',
  );
  const stop = (signal: string) => {
    log.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}
