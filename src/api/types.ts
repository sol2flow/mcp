import type { components } from './openapi.js';

/** The API's response shapes (src/api/openapi.d.ts, generated from the vendored OpenAPI snapshot). */
type S = components['schemas'];

/** The key used for the request: `GET /me` → `api_key` since API 1.8.0 (absent before). */
export type ApiKeyInfo = { name: string; prefix: string; scope: 'full' | 'read'; expires_at: string | null };
export type Me = S['Me'] & { api_key?: ApiKeyInfo };
export type Workspace = S['Workspace'];
export type Board = S['Board'];
export type BoardDetail = S['BoardDetail'];
export type List = S['List'];
export type Label = S['Label'];
export type Task = S['Task'];
export type TaskSummary = S['TaskSummary'];
export type TaskLink = S['TaskLink'];
export type ChecklistItem = S['ChecklistItem'];
export type Comment = S['Comment'];
export type TimeEntry = S['TimeEntry'];
export type Timer = S['Timer'];
export type Notification = S['Notification'];
export type SearchResult = S['SearchResult'];
export type Member = S['Member'];
export type MemberOrInvitation = S['MemberOrInvitation'];
export type MyInvitation = S['MyInvitation'];
export type UserRef = S['UserRef'];
export type Page<T> = { data: T[]; next_cursor: string | null };
export type StartTimerResponse = S['StartTimerResponse'];
export type StopTimerResponse = S['StopTimerResponse'];
export type GetTimer = S['GetTimerResponse'];
