import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/*
 * Prompts: ready-made requests a client can offer (e.g. as slash commands). They only produce text; the model then
 * calls the tools. No API calls here.
 */

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'plan_my_day',
    {
      title: 'Plan my day',
      description: 'sol2flow: a plan for today from your assigned tasks, due dates, running timer and notifications.',
      argsSchema: {
        workspace: z.string().optional().describe('Workspace slug (default: the configured one)'),
      },
    },
    ({ workspace }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Help me plan my day in sol2flow.',
              `1. Call whoami to see who I am, my time zone and today's date there${workspace ? ` (workspace ${workspace})` : ''}.`,
              '2. Call list_tasks with assignee ["me"] (and due_before a week from today) to see my open work; ' +
                'also get_timer and list_notifications with unread_only.',
              '3. Propose a short, realistic plan for today: what is overdue or due soon first, then the rest, with ' +
                'task keys. Mention anything waiting on me from the notifications.',
              "4. Don't change anything until I confirm; then you may move tasks, start a timer or update due dates.",
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'board_standup',
    {
      title: 'Board stand-up',
      description:
        'sol2flow: a stand-up summary of a board: what moved, what is in progress, what is blocked or overdue.',
      argsSchema: {
        board: z.string().describe('The board: key (PRD), name or URL'),
        since: z
          .string()
          .optional()
          .describe('Since when, e.g. "yesterday" or 2026-10-01 (default: the last 24 hours)'),
      },
    },
    ({ board, since }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Prepare a stand-up summary for the sol2flow board ${board}.`,
              '1. Call get_board for the lists and their tasks.',
              `2. Call list_tasks with board "${board}" and updated_since ${since ? `"${since}" (as an ISO timestamp)` : 'the last 24 hours'} for what changed.`,
              '3. For tasks that look blocked or are overdue, get_task shows links and the latest comments.',
              '4. Summarise per person: done, in progress, next, blocked; then overdue tasks. Use task keys. Change nothing.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
