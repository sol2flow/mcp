/**
 * Every REST API operation the server calls, by its OpenAPI operationId. The client only calls operations listed here,
 * and the contract test (test/contract) checks each one against the vendored OpenAPI snapshot: the method and path
 * exist, and the scope each tool declares matches the operations' `x-required-scope`.
 */
export const OPS = {
  getMe: { method: 'GET', path: '/me' },
  listWorkspaces: { method: 'GET', path: '/workspaces' },
  listBoards: { method: 'GET', path: '/workspaces/{slug}/boards' },
  createBoard: { method: 'POST', path: '/workspaces/{slug}/boards' },
  getBoard: { method: 'GET', path: '/boards/{boardId}' },
  createList: { method: 'POST', path: '/boards/{boardId}/lists' },
  listWorkspaceLabels: { method: 'GET', path: '/workspaces/{slug}/labels' },
  listBoardLabels: { method: 'GET', path: '/boards/{boardId}/labels' },
  createBoardLabel: { method: 'POST', path: '/boards/{boardId}/labels' },
  search: { method: 'GET', path: '/workspaces/{slug}/search' },
  listTasks: { method: 'GET', path: '/tasks' },
  createTask: { method: 'POST', path: '/tasks' },
  getTask: { method: 'GET', path: '/tasks/{taskId}' },
  updateTask: { method: 'PATCH', path: '/tasks/{taskId}' },
  moveTask: { method: 'POST', path: '/tasks/{taskId}/move' },
  moveTaskToBoard: { method: 'POST', path: '/tasks/{taskId}/move-board' },
  archiveTask: { method: 'POST', path: '/tasks/{taskId}/archive' },
  unarchiveTask: { method: 'POST', path: '/tasks/{taskId}/unarchive' },
  setTaskLabels: { method: 'PUT', path: '/tasks/{taskId}/labels' },
  setTaskAssignees: { method: 'PUT', path: '/tasks/{taskId}/assignees' },
  listTaskLinks: { method: 'GET', path: '/tasks/{taskId}/links' },
  addTaskLink: { method: 'POST', path: '/tasks/{taskId}/links' },
  removeTaskLink: { method: 'DELETE', path: '/tasks/{taskId}/links/{linkId}' },
  addChecklistItem: { method: 'POST', path: '/tasks/{taskId}/checklist' },
  updateChecklistItem: { method: 'PATCH', path: '/checklist/{itemId}' },
  listComments: { method: 'GET', path: '/tasks/{taskId}/comments' },
  addComment: { method: 'POST', path: '/tasks/{taskId}/comments' },
  listTimeEntries: { method: 'GET', path: '/time-entries' },
  logTime: { method: 'POST', path: '/time-entries' },
  updateTimeEntry: { method: 'PATCH', path: '/time-entries/{entryId}' },
  getTimer: { method: 'GET', path: '/timer' },
  startTimer: { method: 'POST', path: '/timer/start' },
  stopTimer: { method: 'POST', path: '/timer/stop' },
  listNotifications: { method: 'GET', path: '/notifications' },
  markNotification: { method: 'PATCH', path: '/notifications/{notificationId}' },
  markAllNotificationsRead: { method: 'POST', path: '/notifications/read-all' },
  listMembers: { method: 'GET', path: '/workspaces/{slug}/members' },
  listMyInvitations: { method: 'GET', path: '/me/invitations' },
  acceptInvitation: { method: 'POST', path: '/me/invitations/{invitationId}/accept' },
  declineInvitation: { method: 'POST', path: '/me/invitations/{invitationId}/decline' },
} as const satisfies Record<string, { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string }>;

export type OpId = keyof typeof OPS;

/** The scope an operation needs (docs: REST API → Scopes): GET needs `read`, everything else `full`. */
export const opScope = (op: OpId): 'read' | 'full' => (OPS[op].method === 'GET' ? 'read' : 'full');
