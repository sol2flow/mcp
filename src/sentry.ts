import { log } from './log.js';

/*
 * Error tracking (README.md → Error tracking): off unless SENTRY_DSN (or SENTRY_DSN_FILE) is set, and only in the image
 * (the npm package doesn't ship the SDK). Only 5xx answers from sol2flow and unexpected errors are sent — never
 * requests, headers, bodies, tool arguments or results (src/sentry-sdk.ts strips events before they leave).
 */

type Sdk = typeof import('./sentry-sdk.js');
let sdk: Sdk | null = null;

export async function initSentry(env: Record<string, string | undefined>, version: string) {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  try {
    // a separate file next to dist/index.js (scripts/build.mjs): present in the image, not in the npm package
    sdk = await import('./sentry-sdk.js');
  } catch {
    log.warn('SENTRY_DSN is set, but this build has no error-tracking SDK (only the Docker image includes it)');
    return false;
  }
  sdk.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
    release: env.SENTRY_RELEASE?.trim() || version,
  });
  log.info({ environment: env.SENTRY_ENVIRONMENT?.trim() || 'production' }, 'error tracking on (SENTRY_DSN)');
  return true;
}

export function captureException(e: unknown, tags: Record<string, string | number>) {
  try {
    sdk?.capture(e, tags);
  } catch {
    /* error tracking never breaks a tool call */
  }
}

export async function flushSentry(ms = 2000) {
  await sdk?.flush(ms).catch(() => undefined);
}
