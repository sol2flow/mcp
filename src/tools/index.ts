import { listMyInvitations, listPeople, listWorkspaces, respondToInvitation, whoami } from './account.js';
import { createBoard, createLabel, createList, getBoardTool, listBoards, listLabels } from './boards.js';
import { addChecklistItems, addComment, linkTasks, unlinkTasks, updateChecklistItem } from './collaboration.js';
import type { ToolDef } from './registry.js';
import { archiveTask, createTask, getTask, listTasks, moveTask, search, unarchiveTask, updateTask } from './tasks.js';
import {
  getTimer,
  listNotifications,
  listTimeEntries,
  logTime,
  markNotificationsRead,
  startTimer,
  stopTimer,
  updateTimeEntry,
} from './time.js';

/** Every tool, read tools first (the order clients list them in). */
export const TOOLS: readonly ToolDef[] = [
  // read
  whoami,
  listWorkspaces,
  listBoards,
  getBoardTool,
  search,
  listTasks,
  getTask,
  listLabels,
  listPeople,
  listTimeEntries,
  getTimer,
  listNotifications,
  listMyInvitations,
  // write: tasks
  createTask,
  updateTask,
  moveTask,
  archiveTask,
  unarchiveTask,
  // comments, checklists, links
  addComment,
  addChecklistItems,
  updateChecklistItem,
  linkTasks,
  unlinkTasks,
  // time
  logTime,
  startTimer,
  stopTimer,
  updateTimeEntry,
  // notifications, invitations
  markNotificationsRead,
  respondToInvitation,
  // boards
  createBoard,
  createList,
  createLabel,
];
