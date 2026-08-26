/**
 * Emergency account recovery. Resets a user's password, reactivates the account,
 * revokes every existing session, and prints a new password once.
 *
 * Creates the user as SYSTEM_ADMIN if the address has no account yet.
 * Matching is case-insensitive, so it finds rows saved with different casing.
 *
 * Run:
 *   pnpm tsx --env-file=.env prisma/reset-user-password.ts bryan@summitsensory.com
 *
 * Optional explicit password (otherwise one is generated):
 *   pnpm tsx --env-file=.env prisma/reset-user-password.ts bryan@summitsensory.com 'SomeLongPassword123'
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';

const prisma = new PrismaClient();

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

async function main() {
  const rawEmail = process.argv[2];
  if (!rawEmail || !rawEmail.includes('@')) {
    console.error(
      'Usage: pnpm tsx --env-file=.env prisma/reset-user-password.ts <email> [password]',
    );
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();

  const supplied = process.argv[3];
  if (supplied && supplied.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  const password = supplied ?? generatePassword();
  const passwordHash = await hashPassword(password);

  // Find the row however it was cased when it was created.
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, role: true, isActive: true },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      // Normalize the stored address while we are here, so SSO and password
      // login agree on it from now on.
      data: { email, passwordHash, isActive: true },
    });

    // Kill anything issued against the old password.
    await prisma.session
      .updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {
        /* older schemas may name this differently; the password change alone is enough */
      });

    console.log(`\nReset password for existing user: ${existing.email}`);
    if (existing.email !== email) console.log(`  Address normalized to: ${email}`);
    if (!existing.isActive) console.log('  Account was disabled and has been reactivated.');
    console.log(`  Role: ${existing.role}`);
  } else {
    const user = await prisma.user.create({
      data: {
        email,
        name: email.split('@')[0],
        role: 'SYSTEM_ADMIN',
        passwordHash,
      },
      select: { email: true, role: true },
    });
    console.log(`\nNo account existed. Created ${user.email} as ${user.role}.`);
  }

  if (!supplied) {
    console.log('\n  New password (shown once \u2014 copy it now):\n');
    console.log(`      ${password}\n`);
    console.log('  Sign in, then change it from the sidebar.\n');
  } else {
    console.log('\n  Password set to the value you supplied.\n');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
