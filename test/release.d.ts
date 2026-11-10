// Types for the release plugins test/unit/release-notes.test.ts runs (neither ships its own): the plugin step signature.
declare module '@semantic-release/release-notes-generator' {
  export function generateNotes(pluginConfig: Record<string, unknown>, context: object): Promise<string>;
}
declare module '*/scripts/release-commit-analyzer.mjs' {
  export function analyzeCommits(pluginConfig: Record<string, unknown>, context: object): Promise<string | null>;
}
