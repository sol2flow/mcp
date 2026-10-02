import { ConfigError, HELP, loadConfig, parseArgs, resolveFileEnv } from './config.js';
import { createLogger, log, setLogger } from './log.js';
import { flushSentry, initSentry, captureException } from './sentry.js';
import { runHttp } from './transports/http.js';
import { runStdio } from './transports/stdio.js';
import { VERSION } from './version.js';

/* The CLI: `sol2flow-mcp [--stdio | --http] [--read-only] …` (src/config.ts → HELP). */

async function main() {
  let config;
  try {
    const cli = parseArgs(process.argv.slice(2));
    if (cli.help) return void process.stdout.write(HELP);
    if (cli.version) return void process.stdout.write(VERSION + '\n');
    resolveFileEnv(process.env);
    config = loadConfig(process.env, cli);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`sol2flow-mcp: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  setLogger(createLogger({ level: config.log.level, fd: config.transport === 'stdio' ? 2 : 1 }));
  await initSentry(process.env, VERSION);
  process.on('unhandledRejection', (e) => {
    log.error(
      { err: e instanceof Error ? { type: e.name, message: e.message, stack: e.stack } : String(e) },
      'unhandled rejection',
    );
    captureException(e, { where: 'unhandledRejection' });
  });
  log.info({ version: VERSION, transport: config.transport, upstream: config.appUrl }, 'starting');
  if (config.transport === 'stdio') await runStdio(config);
  else await runHttp(config);
}

main().catch(async (e) => {
  log.fatal(
    { err: e instanceof Error ? { type: e.name, message: e.message, stack: e.stack } : String(e) },
    'failed to start',
  );
  process.stderr.write(`sol2flow-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  captureException(e, { where: 'start' });
  await flushSentry();
  process.exit(1);
});
