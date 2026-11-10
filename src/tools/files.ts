import { z } from 'zod';
import { ToolError } from '../api/errors.js';
import type { Attachment, Page } from '../api/types.js';
import { dateTime, fileSize, lines, render } from '../format/text.js';
import { resolveTask } from '../resolve/refs.js';
import { defineTool, p, RESOLVE_OPS, type ToolContent } from './registry.js';

/*
 * Files (README.md → Tools): a task's attachments, and one file by id or URL, so a model can read a text file or look
 * at a screenshot. Images in a description or comment aren't attachments: they come with get_task's Markdown as
 * `<instance>/api/v1/files/<id>` (older instances write `/api/files/<id>`), and get_file opens both.
 */

/** Images a model can look at, and how large (Claude's limit for one image is 5 MB, base64 makes it a third larger). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Text files returned as text, up to this size (the rest of the answer stays within the usual 25,000 characters). */
export const MAX_TEXT_BYTES = 24 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|csv|javascript|x-ndjson|ld\+json|x-sh)$)/;

const FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
/** A file id, or a URL ending in /files/<id> (the API's download URL or the app's own, with or without the host). */
export function fileId(ref: string): string {
  const m =
    new RegExp(`^${FILE_ID.source}$`, 'i').exec(ref) ??
    new RegExp(`/files/${FILE_ID.source}/?(?:[?#].*)?$`, 'i').exec(ref);
  if (!m)
    throw new ToolError(
      `"${ref}" isn't a file: give a file id (from list_attachments) or a URL ending in /files/<id>.`,
    );
  return m[1]!.toLowerCase();
}

/** Storage that didn't keep the upload's type answers with one of these: the first bytes then tell an image. */
const UNTYPED = ['application/octet-stream', 'binary/octet-stream'];
/** The image type from a file's first bytes (PNG, JPEG, GIF, WebP), or null. */
export function sniffImage(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  return null;
}

/** How much of a file get_file reads: what it can show, nothing of a type it can't. */
const readUpTo = (type: string) =>
  IMAGE_TYPES.includes(type) || UNTYPED.includes(type) ? MAX_IMAGE_BYTES : TEXT_TYPES.test(type) ? MAX_TEXT_BYTES : 0;

export const listAttachments = defineTool({
  name: 'list_attachments',
  title: 'List a task’s attachments',
  description:
    'sol2flow: the files attached to a task (name, type, size, id). get_file opens one: images as images, text files ' +
    'as text. Images inside the description are not attachments: get_task shows them as links, get_file opens those too.',
  scope: 'read',
  ops: [...RESOLVE_OPS, 'listAttachments'],
  input: { task: p.task, workspace: p.workspace, response_format: p.responseFormat },
  async run(ctx, a) {
    const t = await resolveTask(ctx, a.task, a.workspace);
    const page = await ctx.api.call<Page<Attachment>>('listAttachments', { params: { taskId: t.id } });
    return render(a.response_format, page, () =>
      [
        `# Attachments of ${t.key ?? a.task} (${page.data.length})`,
        lines(
          page.data.map(
            (f) => `- **${f.name}** · ${f.mime_type} · ${fileSize(f.size)} · ${dateTime(f.created_at)} · id ${f.id}`,
          ),
          '_(none)_',
        ),
      ].join('\n'),
    );
  },
});

export const getFile = defineTool({
  name: 'get_file',
  title: 'Open a file',
  description:
    'sol2flow: one file, by its id (from list_attachments) or its URL (an image link in a description or comment, ' +
    `…/files/<id>). PNG, JPEG, GIF and WebP images up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB come back as an image ` +
    `you can look at, text files up to ${MAX_TEXT_BYTES / 1024} KB as text; anything else as its name, type and size.`,
  scope: 'read',
  ops: ['downloadFile'],
  input: {
    file: z.string().trim().min(1).max(2000).describe('The file id, or its URL (…/api/v1/files/<id>, /api/files/<id>)'),
  },
  async run(ctx, a): Promise<string | ToolContent> {
    const id = fileId(a.file);
    const f = await ctx.api.download('downloadFile', { params: { fileId: id } }, readUpTo);
    const type = f.bytes && UNTYPED.includes(f.type) ? (sniffImage(f.bytes) ?? f.type) : f.type;
    const what = `${f.name ?? id} · ${type} · ${f.atLeast ? 'at least ' : ''}${fileSize(f.size)}`;
    if (f.bytes && IMAGE_TYPES.includes(type))
      return [
        { type: 'text', text: what },
        { type: 'image', data: f.bytes.toString('base64'), mimeType: type },
      ];
    if (f.bytes && TEXT_TYPES.test(type))
      return `# ${what}\n\n\`\`\`\n${f.bytes.toString('utf8').replace(/```/g, '`\u200b``')}\n\`\`\``;
    const why = IMAGE_TYPES.includes(type)
      ? `larger than ${fileSize(MAX_IMAGE_BYTES)}, too large to show`
      : TEXT_TYPES.test(type)
        ? `larger than ${fileSize(MAX_TEXT_BYTES)}, too long to show`
        : UNTYPED.includes(type) && !f.bytes
          ? `no file type and larger than ${fileSize(MAX_IMAGE_BYTES)}, so it can’t be shown here`
          : 'not an image or text file, so it can’t be shown here';
    return `${what}: ${why}. Open it in the app: ${ctx.appUrl.replace(/\/$/, '')}/api/files/${id}`;
  },
});
