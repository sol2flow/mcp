// Bundles the server into one ESM file, dist/index.js, with a shebang and no runtime dependencies (the MCP SDK, zod
// and pino are inlined), so `npx -y @sol2flow/mcp` starts without installing anything else. dist/sentry-sdk.js is the
// error-tracking SDK, bundled separately: the image ships it, the npm package doesn't (package.json → files), and
// dist/index.js loads it only when SENTRY_DSN is set (src/sentry.ts).
//
//   node scripts/build.mjs           build once
//   node scripts/build.mjs --watch   rebuild on change and restart the server (make dev)
//
// The version baked in: APP_VERSION when it is a release version (the image build passes it), else package.json's
// (set by semantic-release before `npm publish`, which runs this through `prepack`).
import { build, context } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fromEnv = process.env.APP_VERSION?.trim();
const version = fromEnv && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(fromEnv) ? fromEnv : pkg.version;
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'warning',
  // CommonJS dependencies bundled into ESM still call require() for Node built-ins
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
};

/** @type {import('esbuild').BuildOptions} */
const main = {
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  banner: { js: '#!/usr/bin/env node\n' + common.banner.js },
  define: { __VERSION__: JSON.stringify(version) },
  // loaded at runtime only when error tracking is on (src/sentry.ts)
  external: ['./sentry-sdk.js'],
  // smaller and faster to load; names stay readable in stack traces
  minifySyntax: true,
  minifyWhitespace: true,
};

/** @type {import('esbuild').BuildOptions} */
const sentry = { ...common, entryPoints: ['src/sentry-sdk.ts'], outfile: 'dist/sentry-sdk.js', minify: true };

if (!watch) {
  rmSync('dist', { recursive: true, force: true });
  await Promise.all([build(main), build(sentry)]);
  console.error(`built dist/index.js and dist/sentry-sdk.js (version ${version})`);
} else {
  // make dev: rebuild on change, restart the server after each successful build
  let child;
  const restart = () => {
    child?.kill();
    child = spawn(process.execPath, ['dist/index.js', ...process.argv.slice(3)], { stdio: 'inherit' });
  };
  const ctx = await context({
    ...main,
    plugins: [
      {
        name: 'restart',
        setup(b) {
          b.onEnd((r) => {
            if (!r.errors.length) restart();
          });
        },
      },
    ],
  });
  await build(sentry);
  await ctx.watch();
}
