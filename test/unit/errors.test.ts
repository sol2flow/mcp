import { describe, expect, it } from 'vitest';
import { ApiError, describeError, ToolError, TransportError, type ErrorContext } from '../../src/api/errors.js';

const ctx: ErrorContext = {
  tool: 'update_task',
  appUrl: 'https://app.example.com',
  apiVersion: '1.8.0',
  write: true,
  params: { label_ids: 'labels' },
};
const api = (status: number, error: Record<string, unknown>, retryAfter?: string) =>
  new ApiError('PATCH /tasks/{taskId}', status, { error }, retryAfter);
const text = (e: unknown, c = ctx) => describeError(e, c);

describe('error mapping', () => {
  it.each([
    [
      api(401, { code: 'unauthenticated', message: 'x' }),
      /refused the API key.*Settings → API keys \(https:\/\/app\.example\.com\/settings\/api-keys\)/,
    ],
    [api(403, { code: 'api_disabled', message: 'x' }), /instance admin/],
    [api(403, { code: 'api_disabled_workspace', message: 'x' }), /Workspace settings → API access/],
    [api(403, { code: 'plan_feature', message: 'x', feature: 'api' }), /plan doesn't include the REST API.*upgrade/],
    [api(403, { code: 'plan_read_only', message: 'x' }), /read-only: its subscription/],
    [
      api(403, { code: 'insufficient_scope', message: 'x' }),
      /read-only, so update_task can't change anything.*--read-only/,
    ],
    [api(403, { code: 'forbidden', message: 'Viewers cannot edit.' }), /permission/],
    [api(403, { code: 'guest_viewer_only', message: 'x' }), /Guests can only be viewers/],
    [api(404, { code: 'not_found', message: 'Not found.' }), /Not found, or you don't have access/],
    [
      api(404, { code: 'not_found', message: 'No such endpoint. See /api/v1/openapi.json.' }),
      /too old for update_task/,
    ],
    [api(409, { code: 'task_archived', message: 'x' }), /unarchive_task first/],
    [api(409, { code: 'board_archived', message: 'x' }), /board is archived/],
    [api(413, { code: 'file_too_large', message: 'x', max: 1 }), /too large \(at most 1 MB\)/],
    [
      api(422, { code: 'invalid_input', message: 'label_ids.0: Invalid UUID', field: 'label_ids.0' }),
      /^Invalid labels: /,
    ],
    [api(429, { code: 'rate_limited', message: 'x', retry_after: 300 }), /Try again in 5 min/],
    [
      api(429, { code: 'plan_limit', message: 'x', kind: 'apiCalls', limit: 5000, retry_after: 7200 }),
      /5000 API requests per day.*midnight UTC \(in 2 h 0 min\)/,
    ],
    [
      api(409, { code: 'plan_limit', message: 'x', kind: 'boards', limit: 3, used: 3 }),
      /limit for boards is reached \(3 of 3\)/,
    ],
    [api(500, { code: 'internal', message: 'x' }), /server error \(HTTP 500\).*may or may not have been applied/],
  ])('%#: %s', (e, re) => {
    expect(text(e)).toMatch(re);
  });

  it('a write without an answer must be checked before it is repeated', () => {
    expect(text(new TransportError('POST /tasks', true, true, 'no answer within 15 s'))).toMatch(
      /may or may not have been applied: check first/,
    );
    expect(text(new TransportError('GET /tasks', false, false, 'ECONNREFUSED'), { ...ctx, write: false })).toMatch(
      /Couldn't reach sol2flow at https:\/\/app\.example\.com \(ECONNREFUSED\)/,
    );
  });

  it('an older instance without the version header', () => {
    expect(text(api(404, { code: 'not_found', message: 'No such endpoint.' }), { ...ctx, apiVersion: null })).toMatch(
      /API older than 1\.8\) is too old/,
    );
  });

  it('passes its own messages through, and hides unexpected errors', () => {
    expect(text(new ToolError('No list "x".'))).toBe('No list "x".');
    expect(text(new Error('secret internals'))).not.toMatch(/secret internals/);
  });
});
