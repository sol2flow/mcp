// The integration suite's helper inside the app container (its Prisma client, its APP_ENCRYPTION_KEY), started detached
// by run.sh (or by hand next to an app that is already running, README.md → Tests):
//
// 1. seeds people, organizations, workspaces, plans and API keys straight into the database — only what the REST API
//    can't create (accounts, keys, plans); boards, tasks and sharing are made through the API by setup.ts;
// 2. serves, on CONTROL_PORT (default 4555, reachable only on the compose network):
//    GET  /world → the seeded names, ids and keys (JSON);
//    POST /sql   → {sql, params?, exec?}: runs one statement on the test database (switching things the API can't:
//                  instance and workspace API access, key revocation, …) and answers {rows} or {count}.
//
// It refuses to touch any database whose name doesn't end in _test, so it can never seed a development or production
// database. API keys are stored as the app stores them (src/server/auth/api-key.ts): HMAC-SHA-256 over "api-key:" + key,
// keyed with SHA-256("sol2flow:api-keys:" + APP_ENCRYPTION_KEY) (src/server/core/crypto.ts).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/client';

const dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname.slice(1));
if (!dbName.endsWith('_test')) {
  process.stderr.write(`control: refusing to seed the database "${dbName}" (its name must end in _test)\n`);
  process.exit(2);
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const b62 = (n) => Array.from(randomBytes(n), (b) => B62[b % 62]).join('');
const pepper = createHash('sha256')
  .update('sol2flow:api-keys:' + process.env.APP_ENCRYPTION_KEY)
  .digest();
const run = Array.from(randomBytes(4), (b) => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');

const db = new PrismaClient();

const people = {
  ada: 'Ada Admin', // admin of w1, w2, w3: the main account
  bob: 'Bob Member', // member of w1 only: the default workspace
  vera: 'Vera Viewer', // member of w1, Viewer on the restricted board
  gus: 'Gus Guest', // guest of w1, Viewer on the restricted board
  nina: 'Nina Outside', // member of w1, not on the restricted board
  cleo: 'Cleo Invitee', // in no workspace: invitations
  pia: 'Pia Noapi', // admin of a workspace whose plan has no API
  cap: 'Cal Capped', // admin of a workspace whose plan allows 5 API requests a day
  rod: 'Rod Readonly', // admin of a workspace whose plan is past due (read-only)
};
const users = {};
for (const [k, name] of Object.entries(people)) {
  const u = await db.user.create({
    data: {
      email: `${k}-${run}@example.com`,
      emailVerifiedAt: new Date(),
      username: `${k}${run}`,
      name,
      timeZone: 'UTC',
    },
  });
  users[k] = { id: u.id, username: u.username, name, email: u.email };
}

async function workspace(slug, owner, members, orgId) {
  const org =
    orgId ?? (await db.organization.create({ data: { slug, name: `Org ${slug}`, createdById: users[owner].id } })).id;
  if (!orgId)
    await db.organizationMember.create({ data: { organizationId: org, userId: users[owner].id, role: 'OWNER' } });
  const ws = await db.workspace.create({
    data: { slug, name: `Workspace ${slug}`, organizationId: org, createdById: users[owner].id },
  });
  await db.workspaceMember.createMany({
    data: Object.entries(members).map(([k, role]) => ({ workspaceId: ws.id, userId: users[k].id, role })),
  });
  return { id: ws.id, slug, orgId: org };
}

const w1 = await workspace(`it-${run}`, 'ada', {
  ada: 'ADMIN',
  bob: 'MEMBER',
  vera: 'MEMBER',
  gus: 'GUEST',
  nina: 'MEMBER',
});
const w2 = await workspace(`it2-${run}`, 'ada', { ada: 'ADMIN' }, w1.orgId);
const w3 = await workspace(`it3-${run}`, 'ada', { ada: 'ADMIN' }, w1.orgId);
const wNoApi = await workspace(`noapi-${run}`, 'pia', { pia: 'ADMIN' });
const wCap = await workspace(`cap-${run}`, 'cap', { cap: 'ADMIN' });
const wRo = await workspace(`ro-${run}`, 'rod', { rod: 'ADMIN' });

// plans (docs/features/plans.md): on for this instance; organizations without a subscription stay unlimited
await db.instanceSettings.update({ where: { id: 1 }, data: { plansEnabled: true, apiKeys: true } });
async function subscribe(orgId, key, plan, status = 'ACTIVE') {
  const p = await db.plan.create({ data: { key: `${key}-${run}`, name: `Plan ${key}`, ...plan } });
  await db.subscription.create({ data: { organizationId: orgId, planId: p.id, status, source: 'MANUAL' } });
}
await subscribe(wNoApi.orgId, 'noapi', { features: { api: false } });
await subscribe(wCap.orgId, 'cap', { limits: { apiPerDay: 5 } });
await subscribe(wRo.orgId, 'ro', {}, 'PAST_DUE');

async function key(user, name, o = {}) {
  const prefix = b62(8);
  const k = `sf_${prefix}_${b62(43)}`;
  const row = await db.apiKey.create({
    data: {
      userId: users[user].id,
      name,
      prefix,
      keyHash: createHmac('sha256', pepper)
        .update('api-key:' + k)
        .digest('hex'),
      last4: k.slice(-4),
      scope: o.scope ?? 'FULL',
      expiresAt: o.expiresAt ?? null,
      revokedAt: o.revokedAt ?? null,
    },
  });
  return { key: k, id: row.id, prefix };
}

// one key per purpose, so each test file stays within the per-key rate limits (600 requests / 120 writes per 10 min)
const keys = {
  seed: await key('ada', 'it seed'),
  flows: await key('ada', 'it flows'),
  tools: await key('ada', 'it tools'),
  refs: await key('ada', 'it refs'),
  perm: await key('ada', 'it permissions'),
  http: await key('ada', 'it http'),
  stdio: await key('ada', 'it stdio'),
  limits: await key('ada', 'it limits'),
  read: await key('ada', 'it read', { scope: 'READ' }),
  revoked: await key('ada', 'it revoked', { revokedAt: new Date(Date.now() - 60_000) }),
  expired: await key('ada', 'it expired', { expiresAt: new Date(Date.now() - 60_000) }),
  expiring: await key('ada', 'it expiring', { expiresAt: new Date('2099-01-01T00:00:00Z') }),
  bob: await key('bob', 'it bob'),
  vera: await key('vera', 'it vera'),
  gus: await key('gus', 'it gus'),
  nina: await key('nina', 'it nina'),
  cleo: await key('cleo', 'it cleo'),
  pia: await key('pia', 'it pia'),
  cap: await key('cap', 'it cap'),
  rod: await key('rod', 'it rod'),
};

const world = {
  run,
  database: dbName,
  testHooks: /^(1|true)$/i.test(process.env.E2E_TEST_HOOKS ?? ''),
  users,
  workspaces: { w1, w2, w3, noapi: wNoApi, cap: wCap, ro: wRo },
  keys,
};

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const port = Number(process.env.CONTROL_PORT ?? 4555);
createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json(body));
  };
  try {
    if (req.method === 'GET' && req.url === '/world') return send(200, world);
    if (req.method === 'POST' && req.url === '/sql') {
      let raw = '';
      for await (const c of req) raw += c;
      const { sql, params = [], exec = false } = JSON.parse(raw);
      if (exec) return send(200, { count: await db.$executeRawUnsafe(sql, ...params) });
      return send(200, { rows: await db.$queryRawUnsafe(sql, ...params) });
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(port, '0.0.0.0', () => process.stdout.write(`control: run ${run} on :${port} (${dbName})\n`));
