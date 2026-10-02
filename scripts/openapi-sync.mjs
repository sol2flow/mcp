// make openapi-sync: fetches the app's OpenAPI document (default: the dev stack's), stores it as
// openapi/openapi-<info.version>.json (replacing the previous snapshot) and regenerates src/api/openapi.d.ts. The
// contract test (test/contract) then checks that every operation the server uses still exists with the same scope.
// The snapshot is the oldest API version the server supports fully; newer features are detected at runtime.
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const url = process.argv[2] || 'http://app:3000/api/v1/openapi.json';
const res = await fetch(url);
if (!res.ok)
  throw new Error(`${url}: HTTP ${res.status} (is the API documentation switched on? Admin → General → API)`);
const doc = await res.json();
const version = doc?.info?.version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`${url}: no info.version`);
// instance-independent: the dev stack's server URL isn't part of the contract
doc.servers = [{ url: '/api/v1' }];
for (const f of readdirSync('openapi')) if (/^openapi-.*\.json$/.test(f)) rmSync(`openapi/${f}`);
writeFileSync(`openapi/openapi-${version}.json`, JSON.stringify(doc, null, 2) + '\n');
console.error(`openapi/openapi-${version}.json ← ${url}`);
execFileSync(process.execPath, ['scripts/openapi-types.mjs'], { stdio: 'inherit' });
