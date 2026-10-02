import { z } from 'zod';
import type { Me, MemberOrInvitation, MyInvitation, Page, Workspace } from '../api/types.js';
import { workspaceLine } from '../format/entities.js';
import { date, lines, more, render } from '../format/text.js';
import { UUID, workspaceSlug } from '../resolve/refs.js';
import { ToolError } from '../api/errors.js';
import { me, workspaces } from './context.js';
import { defineTool, p } from './registry.js';

export const whoami = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    'sol2flow: the account this API key belongs to (name, username, time zone), the key itself (name, scope, expiry; ' +
    'sol2flow 1.8+), the instance and its API version, and your workspaces with the default one. Start here.',
  scope: 'read',
  ops: ['getMe', 'listWorkspaces'],
  input: { response_format: p.responseFormat },
  async run(ctx, a) {
    const [m, ws] = await Promise.all([me(ctx), workspaces(ctx)]);
    const version = ctx.api.apiVersion;
    const def = ctx.defaultWorkspace ?? (ws.length === 1 ? ws[0]!.slug : undefined);
    return render(
      a.response_format,
      { me: m, workspaces: ws, api_version: version, default_workspace: def ?? null },
      () =>
        [
          `You are ${m.name} (@${m.username})${m.email ? ` · ${m.email}` : ''}${m.time_zone ? ` · time zone ${m.time_zone}` : ''}` +
            `${m.staff_role ? ` · instance ${m.staff_role.toLowerCase()}` : ''}.`,
          keyLine(m),
          `sol2flow at ${ctx.appUrl} · API ${version ?? '1.7 or older (no version header)'}.`,
          '',
          `Workspaces (${ws.length})${def ? `, default **${def}**` : ws.length > 1 ? ': pass `workspace` to tools, or set SOL2FLOW_WORKSPACE' : ''}:`,
          lines(ws.map(workspaceLine), '_none_'),
        ].join('\n'),
    );
  },
});

function keyLine(m: Me) {
  const k = m.api_key;
  if (!k) return 'API key: details need sol2flow 1.8 or later.';
  // the app sends `sf_<prefix>`; tolerate the bare prefix too
  const prefix = k.prefix.startsWith('sf_') ? k.prefix : `sf_${k.prefix}`;
  return (
    `API key "${k.name}" (${prefix}…): ${k.scope === 'read' ? 'read-only' : 'full access'}, ` +
    `${k.expires_at ? `expires ${date(k.expires_at)}` : 'never expires'}.`
  );
}

export const listWorkspaces = defineTool({
  name: 'list_workspaces',
  title: 'List workspaces',
  description:
    'sol2flow: the workspaces you can open, with their slugs (the `workspace` parameter of other tools) and your role.',
  scope: 'read',
  ops: ['listWorkspaces'],
  input: { response_format: p.responseFormat },
  async run(ctx, a) {
    const ws = await workspaces(ctx);
    return render(a.response_format, ws satisfies Workspace[], () =>
      lines(ws.map(workspaceLine), 'You are in no workspace.'),
    );
  },
});

export const listPeople = defineTool({
  name: 'list_people',
  title: 'List people',
  description:
    'sol2flow: members of a workspace (name, @username, role), e.g. to find whom to assign. Guests of a workspace ' +
    "can't list its members.",
  scope: 'read',
  ops: ['listWorkspaces', 'listMembers'],
  input: {
    workspace: p.workspace,
    query: z.string().max(200).optional().describe('Name or username contains'),
    role: z.enum(['ADMIN', 'MEMBER', 'GUEST']).optional().describe('Only this role'),
    cursor: p.cursor,
    limit: p.limit(50),
    response_format: p.responseFormat,
  },
  async run(ctx, a) {
    const slug = await workspaceSlug(ctx, a.workspace);
    const r = await ctx.api.call<Page<MemberOrInvitation>>('listMembers', {
      params: { slug },
      query: { q: a.query, role: a.role, cursor: a.cursor, limit: a.limit ?? 50 },
    });
    const members = r.data.flatMap((m) => (m.type === 'member' ? [m] : []));
    return render(
      a.response_format,
      r,
      () =>
        lines(
          members.map(
            (m) => `- ${m.user.name} (@${m.user.username}) · ${m.role.toLowerCase()}${m.email ? ` · ${m.email}` : ''}`,
          ),
          'Nobody matches.',
        ) + more(r.next_cursor),
    );
  },
});

export const listMyInvitations = defineTool({
  name: 'list_my_invitations',
  title: 'List my invitations',
  description:
    'sol2flow: pending invitations to your verified email address (workspace, board, role, who invited you). ' +
    'respond_to_invitation accepts or declines one.',
  scope: 'read',
  ops: ['listMyInvitations'],
  input: { response_format: p.responseFormat },
  async run(ctx, a) {
    const r = await ctx.api.call<Page<MyInvitation>>('listMyInvitations');
    return render(a.response_format, r, () =>
      lines(
        r.data.map(
          (i) =>
            `- ${i.workspace.name} (${i.workspace.slug})${i.board ? `, board ${i.board.name} as ${i.board_role?.toLowerCase()}` : ''}` +
            ` · as ${i.role.toLowerCase()}${i.invited_by ? ` · from ${i.invited_by}` : ''} · expires ${date(i.expires_at)}` +
            ` · id ${i.id}`,
        ),
        'No pending invitations (only invitations to a verified address are shown).',
      ),
    );
  },
});

export const respondToInvitation = defineTool({
  name: 'respond_to_invitation',
  title: 'Accept or decline an invitation',
  description:
    'sol2flow: accept or decline one invitation from list_my_invitations. Accepting joins the workspace (and the ' +
    "board, if it's a board invitation). Declining can't be undone.",
  scope: 'full',
  ops: ['acceptInvitation', 'declineInvitation'],
  destructive: true,
  idempotent: false,
  input: {
    invitation_id: z.string().trim().describe('The invitation id from list_my_invitations'),
    response: z.enum(['accept', 'decline']),
  },
  async run(ctx, a) {
    if (!UUID.test(a.invitation_id)) throw new ToolError('invitation_id must be the id from list_my_invitations.');
    if (a.response === 'decline') {
      await ctx.api.call('declineInvitation', { params: { invitationId: a.invitation_id } });
      return 'Invitation declined.';
    }
    const w = await ctx.api.call<Workspace>('acceptInvitation', { params: { invitationId: a.invitation_id } });
    ctx.cache.delete(`${ctx.fp}:workspaces`);
    return `Invitation accepted: you are in workspace ${w.name} (${w.slug}) as ${w.role.toLowerCase()}. ${w.url}`;
  },
});
