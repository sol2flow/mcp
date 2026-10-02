import * as Sentry from '@sentry/node';

/*
 * The error-tracking SDK, bundled on its own into dist/sentry-sdk.js (scripts/build.mjs): the image ships it, the npm
 * package doesn't. src/sentry.ts imports it only when SENTRY_DSN is set. No default integrations (no HTTP
 * instrumentation, no breadcrumbs of requests): only the errors src/sentry.ts passes, and every event is stripped of
 * request data, user, breadcrumbs and extra context before it leaves.
 */

export type SentryInit = { dsn: string; environment: string; release: string | undefined };

export function init(o: SentryInit) {
  Sentry.initWithoutDefaultIntegrations({
    dsn: o.dsn,
    environment: o.environment,
    release: o.release,
    tracesSampleRate: 0,
    // the SDK's own data collection, all off (as in the app and the website)
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    integrations: [
      Sentry.linkedErrorsIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      if (event.contexts) event.contexts = { runtime: event.contexts.runtime, os: event.contexts.os };
      return event;
    },
  });
}

export function capture(e: unknown, tags: Record<string, string | number>) {
  Sentry.captureException(e, { tags });
}

export async function flush(ms: number) {
  await Sentry.flush(ms);
}
