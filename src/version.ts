declare const __VERSION__: string | undefined;

/** The package version (scripts/build.mjs defines it; the tests run the sources and see "dev"). */
export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
export const USER_AGENT = `sol2flow-mcp/${VERSION}`;
