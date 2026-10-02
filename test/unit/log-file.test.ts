// LOG_FILE (README.md → Logging): src/log-file.ts, a port of the webmcp's (the same tests).
import assert from 'node:assert/strict';
import { afterAll, describe, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogFileWriter, logFileOptions, openLogFile, parseLogSize } from '../../src/log-file.js';

const root = mkdtempSync(path.join(tmpdir(), 'mcp-log-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dirs = 0;
const newDir = () => path.join(root, `d${++dirs}`);
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const list = (dir: string) => readdirSync(dir).sort();
const line = (i: number, pad = 0) => `${JSON.stringify({ i, pad: 'x'.repeat(pad) })}\n`;

/** A writer on a fake clock: `at(iso)` moves it. */
function writer(file: string, env: Record<string, string> = {}, start = '2026-09-30T10:00:00Z') {
  let t = Date.parse(start);
  const errors: Error[] = [];
  const stream = createLogFileWriter(logFileOptions({ LOG_FILE: file, ...env })!, {
    now: () => t,
    onError: (e) => errors.push(e),
  });
  return { stream, errors, at: (iso: string) => void (t = Date.parse(iso)) };
}

describe('log file settings', () => {
  it('is off without LOG_FILE', () => {
    assert.equal(logFileOptions({}), null);
  });
  it('has no size limit by default or when empty; an invalid size is named and means no limit', () => {
    assert.deepEqual(logFileOptions({ LOG_FILE: '/data/logs/app.log' }), {
      file: '/data/logs/app.log',
      maxSize: null,
      maxFiles: 10,
      frequency: 'daily',
      invalid: [],
    });
    assert.equal(logFileOptions({ LOG_FILE: '/x/a.log', LOG_FILE_MAX_SIZE: '' })!.maxSize, null);
    const o = logFileOptions({
      LOG_FILE: '/x/a.log',
      LOG_FILE_MAX_SIZE: 'big',
      LOG_FILE_MAX_FILES: 'x',
      LOG_FILE_FREQUENCY: 'hourly',
    })!;
    assert.deepEqual(
      [o.maxSize, o.maxFiles, o.frequency, o.invalid],
      [null, 10, 'hourly', ['LOG_FILE_MAX_SIZE=big', 'LOG_FILE_MAX_FILES=x']],
    );
    assert.equal(logFileOptions({ LOG_FILE: '/x/a.log', LOG_FILE_MAX_FILES: '0' })!.maxFiles, 0);
    assert.equal(parseLogSize('10k'), 10240);
    assert.equal(parseLogSize('20m'), 20 * 1024 ** 2);
    assert.equal(parseLogSize('nope'), null);
  });
});

describe('log file', () => {
  it('writes mcp-YYYY-MM-DD.log (UTC days) behind a mcp.log symlink', () => {
    const dir = newDir();
    const file = path.join(dir, 'mcp.log');
    const w = writer(file);
    w.stream.write(line(1));
    assert.equal(readlinkSync(file), 'mcp-2026-09-30.log');
    w.at('2026-10-01T00:00:00Z');
    w.stream.write(line(2));
    assert.deepEqual(list(dir), ['mcp-2026-09-30.log', 'mcp-2026-10-01.log', 'mcp.log']);
    assert.equal(readlinkSync(file), 'mcp-2026-10-01.log');
    assert.equal(read(file), line(2));
  });

  it('writes mcp-YYYY-MM-DD-HH.log hourly', () => {
    const dir = newDir();
    const w = writer(path.join(dir, 'mcp.log'), { LOG_FILE_FREQUENCY: 'hourly' }, '2026-09-30T09:30:00Z');
    w.stream.write(line(1));
    assert.equal(readlinkSync(path.join(dir, 'mcp.log')), 'mcp-2026-09-30-09.log');
  });

  it('has no size limit without LOG_FILE_MAX_SIZE; with one continues in .1, .2 of the same day', () => {
    const unlimited = newDir();
    const u = writer(path.join(unlimited, 'mcp.log'));
    for (let i = 0; i < 100; i++) u.stream.write(line(i, 1000));
    assert.deepEqual(list(unlimited), ['mcp-2026-09-30.log', 'mcp.log']);

    const dir = newDir();
    const file = path.join(dir, 'mcp.log');
    const w = writer(file, { LOG_FILE_MAX_SIZE: '1k' });
    const targets = new Set();
    for (let i = 0; i < 24; i++) {
      w.stream.write(line(i, 100));
      targets.add(readlinkSync(file));
      assert.ok(read(file).endsWith(line(i, 100)));
    }
    assert.deepEqual([...targets], ['mcp-2026-09-30.log', 'mcp-2026-09-30.1.log', 'mcp-2026-09-30.2.log']);
  });

  it('keeps the newest LOG_FILE_MAX_FILES files and never deletes other base names', () => {
    const dir = newDir();
    mkdirSync(dir);
    const others = ['app.log', 'app-2026-09-01.log', 'mcp.log.1'];
    for (const f of others) writeFileSync(path.join(dir, f), 'keep');
    writeFileSync(path.join(dir, 'mcp-2026-09-01.log'), 'old');
    const w = writer(path.join(dir, 'mcp.log'), { LOG_FILE_MAX_SIZE: '1k', LOG_FILE_MAX_FILES: '2' });
    for (let i = 0; i < 40; i++) w.stream.write(line(i, 100));
    assert.deepEqual(list(dir), [...others, 'mcp-2026-09-30.3.log', 'mcp-2026-09-30.4.log', 'mcp.log'].sort());
  });

  it('continues the newest file of today after a restart', () => {
    const dir = newDir();
    const file = path.join(dir, 'mcp.log');
    const first = writer(file, { LOG_FILE_MAX_SIZE: '1k' });
    for (let i = 0; i < 12; i++) first.stream.write(line(i, 100));
    const before = read(file);
    writer(file, { LOG_FILE_MAX_SIZE: '1k' }, '2026-09-30T20:00:00Z').stream.write(line(100));
    assert.equal(readlinkSync(file), 'mcp-2026-09-30.1.log');
    assert.equal(read(file), before + line(100));
  });

  it('with frequency none: one growing mcp.log, or mcp.1.log, mcp.2.log … with a size', () => {
    const plain = newDir();
    const p = writer(path.join(plain, 'mcp.log'), { LOG_FILE_FREQUENCY: 'none' });
    for (let i = 0; i < 40; i++) p.stream.write(line(i, 100));
    assert.deepEqual(list(plain), ['mcp.log']);
    assert.ok(lstatSync(path.join(plain, 'mcp.log')).isFile());

    const sized = newDir();
    const s = writer(path.join(sized, 'mcp.log'), { LOG_FILE_FREQUENCY: 'none', LOG_FILE_MAX_SIZE: '1k' });
    for (let i = 0; i < 24; i++) s.stream.write(line(i, 100));
    assert.deepEqual(list(sized), ['mcp.1.log', 'mcp.2.log', 'mcp.log']);
  });

  it('reports a path that cannot be written instead of throwing', () => {
    const plain = path.join(root, 'plain-file');
    writeFileSync(plain, '');
    const opened = openLogFile(logFileOptions({ LOG_FILE: path.join(plain, 'app.log') })!, { onError: () => {} });
    assert.match('error' in opened ? opened.error : '', /^E[A-Z]+$/);
  });
});
