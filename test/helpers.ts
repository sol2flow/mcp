import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { refCache } from '../src/resolve/cache.js';
import { createServer, type ServerOptions } from '../src/server.js';
import { KEYS } from './fake-api/server.js';

/** An MCP client connected in memory to a server against `upstream` (the fake API, or a real app). */
export async function connect(upstream: { url: string }, o: Partial<ServerOptions> = {}) {
  const server = createServer({
    apiBase: upstream.url + '/api/v1',
    appUrl: upstream.url,
    apiKey: KEYS.full,
    defaultWorkspace: undefined,
    readOnly: false,
    ...o,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { text, isError: Boolean(r.isError) };
  };
  return { client, server, call, close: () => Promise.all([client.close(), server.close()]) };
}

/** Forget cached references between tests (the cache is process-wide, like in the HTTP server). */
export const clearCache = () => refCache.clear();
