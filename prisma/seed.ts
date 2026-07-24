/**
 * Idempotent seed: (1) a first SYSTEM_ADMIN login, (2) the Adventure Series SKU
 * master (prices/weights) into the Sku table. Safe to run repeatedly.
 *
 * Run with:  pnpm db:seed
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password.js';
import skus from '../src/proposals/adventure-skus.json' with { type: 'json' };

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@summitsensory.com';
// No hardcoded fallback: a password committed to the repo is a published password.
// Set SEED_ADMIN_PASSWORD, or let the seed generate a strong one and print it once.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? generatePassword();
const GENERATED = !process.env.SEED_ADMIN_PASSWORD;

function generatePassword(): string {
  // 24 url-safe chars ≈ 143 bits of entropy.
  return randomBytes(18).toString('base64url');
}

interface SeedSku {
  part: string;
  description: string;
  unitPriceMinor: number;
  weightLbs: number;
  category: string;
}

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!existing) {
    const user = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: 'Summit Admin',
        role: 'SYSTEM_ADMIN',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
      },
      select: { email: true },
    });
    console.log(`Created first admin user: ${user.email}`);
    if (GENERATED) {
      console.log('\n  Generated password (shown once \u2014 copy it now):\n');
      console.log(`      ${ADMIN_PASSWORD}\n`);
      console.log('  Sign in, then change it from the sidebar.\n');
    }
  } else {
    console.log(`Admin user already exists: ${ADMIN_EMAIL}. No change.`);
  }

  // Seed SKUs only if the table is empty, so we never overwrite the user's edits.
  const count = await prisma.sku.count();
  if (count === 0) {
    for (const s of skus as SeedSku[]) {
      await prisma.sku
        .create({
          data: {
            part: s.part,
            description: s.description,
            unitPriceMinor: s.unitPriceMinor,
            weightLbs: s.weightLbs,
            category: s.category,
          },
        })
        .catch(() => {
          /* skip dup part */
        });
    }
    console.log(`Seeded ${(skus as SeedSku[]).length} SKUs into the pricing master.`);
  } else {
    console.log(`Sku table already has ${count} rows. Left untouched.`);
  }
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
