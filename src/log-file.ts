import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

/*
 * The optional log file (LOG_FILE, README.md → Logging): the same JSON lines as the console, written to date-stamped
 * files. With LOG_FILE=/data/logs/mcp.log:
 *
 *   daily (default)  mcp-2026-09-30.log, then mcp-2026-09-30.1.log, .2.log … once LOG_FILE_MAX_SIZE is reached;
 *                    mcp-2026-10-01.log from UTC midnight on
 *   hourly           mcp-2026-09-30-14.log (mcp-2026-09-30-14.1.log …)
 *   none             mcp.log; with a size limit a full mcp.log is renamed to mcp.1.log, mcp.2.log … (higher = newer)
 *
 * mcp.log itself is a symlink to the current file (relative, replaced atomically on every switch), so `tail -F mcp.log`
 * keeps following; with `none` it is the real file. LOG_FILE_MAX_FILES keeps the newest N files of this base name
 * (never other files in the directory). A restart continues the current period's newest file.
 *
 * A small synchronous writer in the server's own thread, no library, no pino transport or worker. A port of the
 * website's (sol2flow/landing: src/lib/log-file.ts), which is the same as the app's. One process per LOG_FILE: two
 * processes writing one base name would rotate over each other.
 */

export type LogFileFrequency = 'daily' | 'hourly' | 'none';
/** maxSize in bytes, null = no size limit; maxFiles 0 = keep every file. */
export type LogFileOptions = { file: string; maxSize: number | null; maxFiles: number; frequency: LogFileFrequency };
export type LogFileStream = { write(line: string): void };

export const LOG_FILE_DEFAULTS = { maxSize: null, maxFiles: 10, frequency: 'daily' as LogFileFrequency };

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** '20m' → bytes (units b, k, m, g, an optional trailing b; a bare number is megabytes). Null: not a size. */
export function parseLogSize(raw: string): number | null {
  const m = /^(\d+)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!m || Number(m[1]) <= 0) return null;
  return Number(m[1]) * UNITS[(m[2] ?? 'm').toLowerCase()]!;
}

/**
 * LOG_FILE and its rotation settings from the environment; null when LOG_FILE is unset (stdout only). An empty or unset
 * LOG_FILE_MAX_SIZE means no size limit. Invalid values fall back to the defaults (for the size: no limit) and are listed
 * in `invalid`, for one warning when the logger starts.
 */
export function logFileOptions(
  env: Record<string, string | undefined> = process.env,
): (LogFileOptions & { invalid: string[] }) | null {
  const file = env.LOG_FILE?.trim();
  if (!file) return null;
  const invalid: string[] = [];
  const rawSize = env.LOG_FILE_MAX_SIZE?.trim();
  let maxSize: number | null = LOG_FILE_DEFAULTS.maxSize;
  if (rawSize) {
    maxSize = parseLogSize(rawSize);
    if (maxSize === null) invalid.push(`LOG_FILE_MAX_SIZE=${rawSize}`);
  }
  const rawFiles = env.LOG_FILE_MAX_FILES?.trim() || String(LOG_FILE_DEFAULTS.maxFiles);
  let maxFiles = Number(rawFiles);
  if (!/^\d+$/.test(rawFiles) || !Number.isSafeInteger(maxFiles)) {
    invalid.push(`LOG_FILE_MAX_FILES=${rawFiles}`);
    maxFiles = LOG_FILE_DEFAULTS.maxFiles;
  }
  const rawFrequency = (env.LOG_FILE_FREQUENCY?.trim() || LOG_FILE_DEFAULTS.frequency).toLowerCase();
  let frequency = rawFrequency as LogFileFrequency;
  if (!['daily', 'hourly', 'none'].includes(rawFrequency)) {
    invalid.push(`LOG_FILE_FREQUENCY=${rawFrequency}`);
    frequency = LOG_FILE_DEFAULTS.frequency;
  }
  return { file: path.resolve(file), maxSize, maxFiles, frequency, invalid };
}

/** The period part of a file name, in UTC: '2026-09-30' (daily), '2026-09-30-14' (hourly), '' (none). */
export function logPeriod(frequency: LogFileFrequency, time: number): string {
  if (frequency === 'none') return '';
  const iso = new Date(time).toISOString(); // 2026-09-30T14:05:00.000Z
  return frequency === 'hourly' ? `${iso.slice(0, 10)}-${iso.slice(11, 13)}` : iso.slice(0, 10);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The file names of one LOG_FILE: build one, or parse one (null: not one of ours, e.g. another app's log next to it). */
export function logFileNames(file: string) {
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  const pattern = new RegExp(`^${escape(stem)}(?:-(\\d{4}-\\d{2}-\\d{2}(?:-\\d{2})?))?(?:\\.(\\d+))?${escape(ext)}$`);
  return {
    name: (period: string, n: number) => `${stem}${period ? `-${period}` : ''}${n ? `.${n}` : ''}${ext}`,
    parse(name: string): { period: string; n: number } | null {
      const m = pattern.exec(name);
      return m ? { period: m[1] ?? '', n: m[2] ? Number(m[2]) : 0 } : null;
    },
  };
}

export type LogFileHooks = {
  /** A write or a rotation failed (disk full, the directory removed): the file is off from now on. Called once. */
  onError(err: Error): void;
  /** Something that doesn't stop the file, e.g. a symlink the filesystem won't take. Once per kind. */
  onWarn?(msg: string, fields: Record<string, unknown>): void;
  /** The clock (tests). */
  now?(): number;
};

/**
 * Opens LOG_FILE's current file for appending (creating the directory), or throws why it can't. Writes are synchronous,
 * like pino's stdout destination; the hooks are called on a microtask, never from inside a write (a warning logged from
 * there would re-enter the stream).
 */
export function createLogFileWriter(opts: LogFileOptions, hooks: LogFileHooks): LogFileStream {
  const now = hooks.now ?? (() => Date.now());
  const dir = path.dirname(opts.file);
  const link = path.basename(opts.file);
  const names = logFileNames(opts.file);
  const dated = opts.frequency !== 'none';
  const warned = new Set<string>();
  const warn = (kind: string, msg: string, fields: Record<string, unknown>) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    queueMicrotask(() => hooks.onWarn?.(msg, fields));
  };

  let fd = -1;
  let size = 0;
  let period = '';
  let n = 0;
  let failed = false;

  const ours = () =>
    readdirSync(dir).flatMap((name) => {
      const p = names.parse(name);
      if (!p) return [];
      try {
        if (!lstatSync(path.join(dir, name)).isFile()) return []; // the symlink
      } catch {
        return [];
      }
      return [{ name, ...p }];
    });

  /** The newest number of a period's files (0: its first file, which has no number), or -1 when it has none. */
  const newest = (p: string) =>
    Math.max(
      -1,
      ...ours()
        .filter((f) => f.period === p)
        .map((f) => f.n),
    );

  function openCurrent() {
    const name = names.name(period, n);
    fd = openSync(path.join(dir, name), 'a');
    size = fstatSync(fd).size;
    if (dated) pointLink(name);
  }

  /** mcp.log → the current file: a new symlink renamed over the old one, so a reader never sees it missing. */
  function pointLink(target: string) {
    const tmp = path.join(dir, `.${link}.${process.pid}.tmp`);
    const removeTmp = () => {
      try {
        unlinkSync(tmp);
      } catch {
        /* not there */
      }
    };
    try {
      removeTmp();
      symlinkSync(target, tmp);
      renameSync(tmp, opts.file);
    } catch (e) {
      removeTmp();
      const err = e as NodeJS.ErrnoException;
      warn('symlink', 'log file symlink cannot be created; the current file is the dated one', {
        file: opts.file,
        code: err.code ?? err.message,
      });
    }
  }

  /** Keeps the newest maxFiles files of this base name (the current one among them); deletes nothing else. */
  function prune() {
    if (!opts.maxFiles) return;
    const current = dated ? names.name(period, n) : link;
    const older = ours()
      .filter((f) => f.name !== current)
      .sort((a, b) => (a.period === b.period ? b.n - a.n : a.period < b.period ? 1 : -1));
    for (const f of older.slice(opts.maxFiles - 1)) {
      try {
        unlinkSync(path.join(dir, f.name));
      } catch {
        /* already gone */
      }
    }
  }

  function start() {
    mkdirSync(dir, { recursive: true });
    let existing: Stats | undefined;
    try {
      existing = lstatSync(opts.file);
    } catch {
      /* not there yet */
    }
    if (dated && existing?.isFile()) {
      // a real mcp.log from before (frequency none, or the old naming): keep it as the newest undated file
      renameSync(opts.file, path.join(dir, names.name('', newest('') + 1 || 1)));
    } else if (!dated && existing?.isSymbolicLink()) {
      unlinkSync(opts.file); // was dated before: mcp.log becomes the real file
    }
    period = logPeriod(opts.frequency, now());
    n = dated ? Math.max(0, newest(period)) : 0; // a restart continues the newest file of this period
    openCurrent();
    prune();
  }

  function rotate(nextPeriod: string) {
    closeSync(fd);
    fd = -1;
    if (!dated) {
      renameSync(opts.file, path.join(dir, names.name('', newest('') + 1 || 1)));
    } else if (nextPeriod !== period) {
      period = nextPeriod;
      n = Math.max(0, newest(period)); // normally 0; the newest file if the clock went back
    } else {
      n++;
    }
    openCurrent();
    prune();
  }

  function fail(e: unknown) {
    if (failed) return;
    failed = true;
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* nothing left to do */
      }
    }
    queueMicrotask(() => hooks.onError(e as Error));
  }

  start();

  return {
    write(line: string) {
      if (failed) return;
      try {
        const bytes = Buffer.byteLength(line);
        const nextPeriod = dated ? logPeriod(opts.frequency, now()) : '';
        if (nextPeriod !== period || (opts.maxSize !== null && size > 0 && size + bytes > opts.maxSize))
          rotate(nextPeriod);
        writeSync(fd, line);
        size += bytes;
      } catch (e) {
        fail(e);
      }
    },
  };
}

type Opened = { stream: LogFileStream } | { error: string };

/**
 * Opens the log file, or returns why it can't: then the caller logs one warning and keeps logging to the console only.
 * The check is synchronous, so a bad path or a missing permission shows at start; an error later on (disk full, the
 * directory removed) turns the file off with one call to `onError`.
 */
export function openLogFile(opts: LogFileOptions, hooks: LogFileHooks): Opened {
  try {
    return { stream: createLogFileWriter(opts, hooks) };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { error: err.code ?? err.message };
  }
}
