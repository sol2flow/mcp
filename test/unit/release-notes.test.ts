// The release's analyzeCommits and generateNotes steps with the real .releaserc.json, so a dependency update that
// breaks them fails here, in the pull request, and not in the next release on main (e.g. a conventional-changelog
// preset that needs a newer changelog writer than semantic-release's plugins load).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateNotes } from '@semantic-release/release-notes-generator';
import { analyzeCommits } from '../../scripts/release-commit-analyzer.mjs';

type PluginEntry = [string, Record<string, unknown>];
const plugins = (JSON.parse(readFileSync('.releaserc.json', 'utf8')) as { plugins: PluginEntry[] }).plugins;
const config = (name: string) => plugins.find(([n]) => n === name)![1];

const commit = (message: string, hash: string) => ({
  message,
  hash,
  commit: { long: hash, short: hash.slice(0, 7) },
  committerDate: '2026-11-10T12:00:00Z',
});
const silent = { log() {}, error() {}, warn() {}, success() {} };
const context = {
  cwd: process.cwd(),
  env: {},
  logger: silent,
  options: { repositoryUrl: 'https://github.com/sol2flow/mcp.git' },
  lastRelease: { version: '0.1.1', gitTag: 'v0.1.1', gitHead: 'a'.repeat(40) },
  nextRelease: { version: '0.2.0', gitTag: 'v0.2.0', gitHead: 'f'.repeat(40) },
  commits: [
    commit('feat(tools): list_attachments and get_file', '1'.repeat(40)),
    commit('fix(tools): get_file on large untyped files', '2'.repeat(40)),
    commit('chore(deps): bump pino from 10.3.1 to 10.4.0', '3'.repeat(40)),
  ],
};

describe('release (.releaserc.json)', () => {
  it('a feat before 1.0 is a minor release', async () => {
    expect(await analyzeCommits(config('./scripts/release-commit-analyzer.mjs'), context)).toBe('minor');
  });

  it('renders the release notes: features and fixes, no chores', async () => {
    const notes: string = await generateNotes(config('@semantic-release/release-notes-generator'), context);
    expect(notes).toContain('0.2.0');
    expect(notes).toMatch(/### Features[\s\S]*list_attachments and get_file/);
    expect(notes).toMatch(/### Bug Fixes[\s\S]*get_file on large untyped files/);
    expect(notes).not.toContain('bump pino');
  });
});
