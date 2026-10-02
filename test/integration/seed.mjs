// The integration test's world, created inside the app container (its Prisma client, its APP_ENCRYPTION_KEY):
// a verified user, an organization and a workspace ("it") they administer, and two API keys — full access and
// read-only. API keys are stored as the app stores them (src/server/auth/api-key.ts): HMAC-SHA-256 over
// "api-key:" + key, keyed with SHA-256("sol2flow:api-keys:" + APP_ENCRYPTION_KEY) (src/server/core/crypto.ts).
// Prints {"full": "sf_…", "read": "sf_…"} on stdout.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const b62 = (n) => Array.from(randomBytes(n), (b) => B62[b % 62]).join('');
const pepper = createHash('sha256')
  .update('sol2flow:api-keys:' + process.env.APP_ENCRYPTION_KEY)
  .digest();

const db = new PrismaClient();
const user = await db.user.create({
  data: {
    email: 'mcp-it@example.com',
    emailVerifiedAt: new Date(),
    username: 'mcpit',
    name: 'MCP Tester',
    timeZone: 'UTC',
  },
});
const org = await db.organization.create({ data: { slug: 'it', name: 'Integration', createdById: user.id } });
await db.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER' } });
const ws = await db.workspace.create({
  data: { slug: 'it', name: 'Integration', organizationId: org.id, createdById: user.id },
});
await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'ADMIN' } });

const keys = {};
for (const scope of ['FULL', 'READ']) {
  const prefix = b62(8);
  const key = `sf_${prefix}_${b62(43)}`;
  await db.apiKey.create({
    data: {
      userId: user.id,
      name: `integration ${scope.toLowerCase()}`,
      prefix,
      keyHash: createHmac('sha256', pepper)
        .update('api-key:' + key)
        .digest('hex'),
      last4: key.slice(-4),
      scope,
    },
  });
  keys[scope.toLowerCase()] = key;
}
await db.$disconnect();
process.stdout.write(JSON.stringify(keys));
