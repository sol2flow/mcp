import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  Buffer: 'readonly',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/api/openapi.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // build, release and maintenance scripts, the integration seed (plain Node)
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', '*.mjs'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // stdout is the JSON-RPC channel in stdio mode: log through src/log.ts (stderr), never console.log
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    files: ['scripts/**', 'test/**'],
    rules: { 'no-console': 'off' },
  },
];
