import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, normaliseBaseUrl, parseArgs, resolveFileEnv } from '../../src/config.js';

describe('config', () => {
  it('normalises the instance URL to …/api/v1', () => {
    for (const u of [
      'https://app.example.com',
      'https://app.example.com/',
      'https://app.example.com/api',
      'https://app.example.com/api/v1/',
    ])
      expect(normaliseBaseUrl(u)).toEqual({
        apiBase: 'https://app.example.com/api/v1',
        appUrl: 'https://app.example.com',
      });
    expect(normaliseBaseUrl('http://host:8080/sol2flow/api/v1?x=1').apiBase).toBe('http://host:8080/sol2flow/api/v1');
    expect(() => normaliseBaseUrl('ftp://x')).toThrow(ConfigError);
    expect(() => normaliseBaseUrl('https://u:p@x')).toThrow(/credentials/);
  });

  it('has no --api-key flag', () => {
    expect(() => parseArgs(['--api-key', 'sf_x'])).toThrow(/SOL2FLOW_API_KEY/);
    expect(parseArgs(['--http', '--port=8080', '--read-only'])).toMatchObject({
      transport: 'http',
      port: 8080,
      readOnly: true,
    });
    expect(() => parseArgs(['--port', 'x'])).toThrow(ConfigError);
  });

  it('stdio uses the env key; HTTP ignores it', () => {
    const env = { SOL2FLOW_API_KEY: 'sf_k', SOL2FLOW_URL: 'https://a.example' };
    expect(loadConfig(env, parseArgs([])).apiKey).toBe('sf_k');
    const http = loadConfig({ ...env, MCP_TRANSPORT: 'http' }, parseArgs([]));
    expect(http.apiKey).toBeUndefined();
    expect(http.http).toMatchObject({ host: '127.0.0.1', port: 3000, trustProxyHops: 0, forwardClientIp: false });
    expect(loadConfig({ READ_ONLY: 'true' }, parseArgs([])).readOnly).toBe(true);
    expect(loadConfig({}, parseArgs([])).apiBase).toBe('https://app.sol2flow.com/api/v1');
  });

  it('reads *_FILE secrets without echoing them', () => {
    const env: Record<string, string | undefined> = { SOL2FLOW_API_KEY_FILE: '/run/secrets/k' };
    resolveFileEnv(env, undefined, () => 'sf_secret\n');
    expect(env).toEqual({ SOL2FLOW_API_KEY: 'sf_secret' });
    expect(() => resolveFileEnv({ SOL2FLOW_API_KEY: 'a', SOL2FLOW_API_KEY_FILE: '/f' })).toThrow(/both/);
    const e = (() => {
      try {
        resolveFileEnv({ SENTRY_DSN_FILE: '/nope' }, undefined, () => {
          throw Object.assign(new Error('x'), { code: 'ENOENT' });
        });
      } catch (err) {
        return err as Error;
      }
    })();
    expect(e?.message).toBe('SENTRY_DSN_FILE: cannot read /nope (ENOENT)');
  });
});
