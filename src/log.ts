import pino, { type DestinationStream, type Logger } from 'pino';
import { logFileOptions, openLogFile } from './log-file.js';

/*
 * The server's log (README.md → Logging): JSON lines at LOG_LEVEL (default info), with LOG_FILE also into date-stamped
 * files. In stdio mode the console stream is **stderr**: stdout carries only JSON-RPC.
 *
 * What is logged: tool name, upstream operation, status, duration, client IP and the key's public 8-character prefix.
 * Never the key, tool arguments or results. Two safety nets on top of not passing them: pino's redaction of the usual
 * field names, and every finished line scrubbed of anything shaped like an API key (`sf_<prefix>_<secret>` keeps only
 * `sf_<prefix>_…`) or a Bearer token.
 */

export const REDACT_PATHS = [
  'key',
  'apiKey',
  'api_key',
  'secret',
  'token',
  'password',
  'authorization',
  'Authorization',
  'headers',
  'args',
  'arguments',
  'input',
  'result',
  'body',
  '*.key',
  '*.apiKey',
  '*.authorization',
  '*.Authorization',
  '*.headers',
  '*.args',
  '*.arguments',
  '*.body',
];

const KEY_SHAPE = /\bsf_([0-9A-Za-z]{8})_[0-9A-Za-z]{8,}/g;
const BEARER = /(Bearer\s+)[^\s"'\\]+/gi;

/** A log line (or any text) without API keys or bearer tokens. */
export const scrubSecrets = (s: string) => s.replace(KEY_SHAPE, 'sf_$1_…').replace(BEARER, '$1[redacted]');

export type LogOptions = {
  level: string;
  /** 1 = stdout (HTTP mode), 2 = stderr (stdio mode: stdout is the protocol) */
  fd: 1 | 2;
  env?: Record<string, string | undefined>;
  /** tests: write here instead of the fd */
  stream?: DestinationStream;
};

export function createLogger(o: LogOptions): Logger {
  const env = o.env ?? process.env;
  const options: pino.LoggerOptions = {
    level: o.level,
    base: { app: 'sol2flow-mcp' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    hooks: { streamWrite: scrubSecrets },
  };
  const consoleStream = o.stream ?? pino.destination({ fd: o.fd, sync: true });
  const fileOptions = logFileOptions(env);
  if (!fileOptions) return pino(options, consoleStream);

  // every stream at the lowest level: the logger's level filters (a multistream's default level is info)
  const streams = pino.multistream([{ level: 'trace', stream: consoleStream }]);
  const log = pino(options, streams);
  const file = openLogFile(fileOptions, {
    onError: (err) =>
      log.warn(
        { file: fileOptions.file, code: (err as NodeJS.ErrnoException).code ?? err.message },
        'log file failed; logging to the console only',
      ),
    onWarn: (msg, fields) => log.warn(fields, msg),
  });
  if ('error' in file) {
    log.warn({ file: fileOptions.file, code: file.error }, 'LOG_FILE cannot be written; logging to the console only');
    return log;
  }
  streams.add({ level: 'trace', stream: file.stream });
  if (fileOptions.invalid.length)
    log.warn(
      { invalid: fileOptions.invalid },
      'invalid log file settings; using the defaults for them (LOG_FILE_MAX_SIZE: no limit)',
    );
  return log;
}

/** The process's logger; replaced once at start (src/index.ts). Silent until then (tests). */
export let log: Logger = pino({ level: 'silent' });

export function setLogger(l: Logger) {
  log = l;
}
