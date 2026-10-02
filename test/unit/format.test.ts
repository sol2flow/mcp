import { describe, expect, it } from 'vitest';
import { renderJson, truncate } from '../../src/format/text.js';
import { parseDuration } from '../../src/tools/time.js';

describe('output limits', () => {
  it('cuts long text at a line with a notice', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const t = truncate(long, 1000);
    expect(t.length).toBeLessThanOrEqual(1000);
    expect(t).toMatch(/… truncated: \d+ more characters not shown/);
    expect(truncate('short', 1000)).toBe('short');
  });

  it('keeps JSON valid, dropping items from the end', () => {
    const data = Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(50) }));
    const out = JSON.parse(renderJson({ data, next_cursor: 'abc' }, 5000));
    expect(out.truncated.total).toBe(500);
    expect(out.data.length).toBe(out.truncated.shown);
    expect(out.next_cursor).toBe('abc');
  });

  it('cuts the largest array of an object without `data` (a board and its tasks), keeping it valid', () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({ key: `PRD-${i}`, title: 'x'.repeat(80) }));
    const board = { id: 'b', name: 'Board', lists: [{ id: 'l', name: 'To do' }], tasks, more_tasks: false };
    const out = JSON.parse(renderJson(board, 5000));
    expect(out.truncated).toEqual({ field: 'tasks', shown: out.tasks.length, total: 300 });
    expect(out.tasks.length).toBeGreaterThan(0);
    expect(out.lists).toEqual(board.lists);
    expect(out.name).toBe('Board');
  });
});

describe('durations', () => {
  it.each([
    ['90', 5400],
    ['45m', 2700],
    ['1h30m', 5400],
    ['1.5h', 5400],
    ['2 hours', 7200],
    ['1h 15 min', 4500],
  ])('%s', (s, sec) => expect(parseDuration(s)).toBe(sec));
  it('refuses what it cannot read', () => {
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('1h xyz')).toBeNull();
  });
});
