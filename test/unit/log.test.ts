import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, scrubSecrets, setLogger } from '../../src/log.js';
import { FakeApi, KEYS } from '../fake-api/server.js';
import { connect } from '../helpers.js';

const fake = new FakeApi();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'trace', fd: 2, env: {}, stream }) };
}

describe('logs', () => {
  it('scrub anything shaped like a key or a bearer token', () => {
    expect(scrubSecrets(`key ${KEYS.full} and Bearer abc.def`)).toBe('key sf_Full0001_… and Bearer [redacted]');
  });

  it('redact the usual fields', () => {
    const { lines, logger } = capture();
    logger.info({ authorization: 'Bearer x', args: { title: 'secret' }, headers: { a: 1 } }, 'm');
    expect(lines.join('')).not.toMatch(/secret|Bearer x/);
  });

  it('never contain the key, tool arguments or results', async () => {
    const { lines, logger } = capture();
    setLogger(logger);
    const c = await connect(fake);
    try {
      const created = await c.call('create_task', {
        board: 'PRD',
        title: 'Confidential merger plan',
        description: 'Talk to Initech about the price',
      });
      expect(created.isError, created.text).toBe(false);
      await c.call('get_task', { task: 'PRD-2' });
      await c.call('add_comment', { task: 'PRD-2', text: 'Private remark 42' });
    } finally {
      await c.close();
    }
    const out = lines.join('');
    expect(out).toContain('"tool":"create_task"');
    expect(out).toContain('"key_prefix":"Full0001"');
    expect(out).toContain('"op":"createTask"'); // the upstream operation (debug)
    for (const secret of [
      KEYS.full,
      'aaaaaaaaaaaaaaaaaaaa',
      'Confidential',
      'Initech',
      'Private remark',
      'Fix login redirect',
    ])
      expect(out).not.toContain(secret);
  });
});
