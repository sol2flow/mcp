import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from '../../src/tools/files.js';
import { FakeApi } from '../fake-api/server.js';
import { clearCache, connect } from '../helpers.js';

// list_attachments and get_file (src/tools/files.ts) against the fake API: images come back as images, text as text,
// S3's redirect is followed without the key.
const fake = new FakeApi();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const file = (o: Partial<FakeApi['files'][number]> & { name: string; type: string; bytes: Buffer }) => {
  const f = { id: randomUUID(), task_id: fake.tasks[0]!.id, ...o };
  fake.files.push(f);
  return f;
};
const callRaw = async (c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) =>
  (await c.client.callTool({ name, arguments: args })) as CallToolResult;

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  clearCache();
  fake.requests = [];
  fake.files = [];
});

describe('list_attachments', () => {
  it("a task's attachments, without the images inside its description", async () => {
    file({ name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('hello') });
    file({ name: 'pasted.png', type: 'image/png', bytes: PNG, inline: true });
    const c = await connect(fake);
    const r = await c.call('list_attachments', { task: fake.tasks[0]!.id });
    await c.close();
    expect(r.isError).toBe(false);
    expect(r.text).toContain('(1)');
    expect(r.text).toMatch(/\*\*notes\.txt\*\* · text\/plain · 5 B · .* · id [0-9a-f-]{36}/);
    expect(r.text).not.toContain('pasted.png');
  });
});

describe('get_file', () => {
  it('an image comes back as an image, by id or by the URL in a description', async () => {
    const f = file({ name: 'shot.png', type: 'image/png', bytes: PNG, inline: true });
    const c = await connect(fake);
    for (const ref of [f.id, `${fake.url}/api/v1/files/${f.id}`, `/api/files/${f.id}`]) {
      const r = await callRaw(c, 'get_file', { file: ref });
      expect(r.isError).toBeFalsy();
      expect(r.content[0]).toMatchObject({ type: 'text', text: 'shot.png · image/png · 70 B' });
      expect(r.content[1]).toEqual({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
    }
    await c.close();
  });

  it('S3: the redirect to the signed URL is followed without the key', async () => {
    const f = file({ name: 'shot.png', type: 'image/png', bytes: PNG, s3: true });
    const c = await connect(fake);
    const r = await callRaw(c, 'get_file', { file: f.id });
    await c.close();
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(fake.requests.find((q) => q.path === `/files/${f.id}`)?.key).toBeTruthy();
    const s3 = fake.requests.find((q) => q.path === `/s3/${f.id}`);
    expect(s3).toBeDefined();
    expect(s3!.headers.authorization).toBeUndefined();
  });

  it('a text file comes back as text; ``` inside cannot close the block', async () => {
    const f = file({ name: 'log.md', type: 'text/markdown', bytes: Buffer.from('# Log\n```\nend') });
    const c = await connect(fake);
    const r = await c.call('get_file', { file: f.id });
    await c.close();
    expect(r.text).toContain('# log.md · text/markdown');
    expect(r.text).toContain('# Log');
    expect(r.text.match(/^```$/gm)).toHaveLength(2);
  });

  it('too large or another type: name, type and size, and where to open it', async () => {
    const big = file({ name: 'big.png', type: 'image/png', bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) });
    const long = file({ name: 'long.txt', type: 'text/plain', bytes: Buffer.alloc(MAX_TEXT_BYTES + 1, 'a') });
    const zip = file({ name: 'a.zip', type: 'application/zip', bytes: Buffer.from('PK') });
    const c = await connect(fake);
    expect((await c.call('get_file', { file: big.id })).text).toMatch(/big\.png · image\/png · 3\.0 MB: larger than/);
    expect((await c.call('get_file', { file: long.id })).text).toContain('too long to show');
    const z = await c.call('get_file', { file: zip.id });
    await c.close();
    expect(z.text).toContain('not an image or text file');
    expect(z.text).toContain(`${fake.url}/api/files/${zip.id}`);
  });

  it('without Content-Length: read only up to the cap; a type it cannot show is not read at all', async () => {
    const big = file({
      name: 'big.txt',
      type: 'text/plain',
      bytes: Buffer.alloc(MAX_TEXT_BYTES * 4, 'a'),
      chunked: true,
    });
    const zip = file({ name: 'a.zip', type: 'application/zip', bytes: Buffer.alloc(1000), chunked: true });
    const c = await connect(fake);
    expect((await c.call('get_file', { file: big.id })).text).toMatch(
      /big\.txt · text\/plain · at least \d+\.\d KB: larger/,
    );
    expect((await c.call('get_file', { file: zip.id })).text).toContain('not an image or text file');
    await c.close();
  });

  it('an image stored without its type (octet-stream) is still shown as an image', async () => {
    const f = file({ name: 'shot', type: 'application/octet-stream', bytes: PNG });
    const c = await connect(fake);
    const r = await callRaw(c, 'get_file', { file: `${fake.url}/api/v1/files/${f.id}?w=800#x` });
    await c.close();
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('a file without a type that is too large to look into says so', async () => {
    const big = file({ name: 'blob', type: 'application/octet-stream', bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) });
    const small = file({ name: 'tiny', type: 'application/octet-stream', bytes: Buffer.alloc(10) });
    const c = await connect(fake);
    expect((await c.call('get_file', { file: big.id })).text).toContain('no file type and larger than');
    expect((await c.call('get_file', { file: small.id })).text).toContain('not an image or text file');
    await c.close();
  });

  it("a storage error behind S3's redirect is the storage's, not a refused key or missing access", async () => {
    const f = file({ name: 'shot.png', type: 'image/png', bytes: PNG, s3: true, s3Status: 401 });
    const c = await connect(fake);
    const r = await c.call('get_file', { file: f.id });
    const after = await c.call('whoami');
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('file storage answered 401');
    expect(after.isError).toBe(false);
  });

  it('not a file reference, or no such file: an error the model can act on', async () => {
    const c = await connect(fake);
    const bad = await c.call('get_file', { file: 'screenshot' });
    const gone = await c.call('get_file', { file: randomUUID() });
    await c.close();
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toContain("isn't a file");
    expect(gone.isError).toBe(true);
  });
});
