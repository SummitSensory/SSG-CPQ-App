/**
 * Freeze a PriceSnapshot for every RELEASED/ACCEPTED proposal version that
 * predates the release-time snapshot (added after this backfill was written).
 * Without one, `createAcceptedOrder` and `verifyIntegrity` have nothing to
 * pin the price to. Idempotent: only versions with priceSnapshotId null are
 * selected, and each update is conditioned on it still being null, so a
 * second run finds nothing left to do.
 *
 * Run with:  pnpm db:backfill:snapshots
 */
import { PrismaClient } from '@prisma/client';
import { snapshotAcceptedContent } from '../src/handoff/service.js';

const prisma = new PrismaClient();

async function main() {
  const versions = await prisma.proposalVersion.findMany({
    where: { priceSnapshotId: null, status: { in: ['RELEASED', 'ACCEPTED'] } },
    select: {
      id: true, sections: true, items: true,
      proposal: { select: { number: true, createdById: true } },
    },
  });

  console.log(`Found ${versions.length} version${versions.length === 1 ? '' : 's'} with no price snapshot.`);

  let done = 0;
  for (const v of versions) {
    const snap = await snapshotAcceptedContent(v.id, v.sections, v.items, v.proposal.createdById);
    const { count } = await prisma.proposalVersion.updateMany({
      where: { id: v.id, priceSnapshotId: null },
      data: { priceSnapshotId: snap.id },
    });
    if (count > 0) done++;
    console.log(`[${done}/${versions.length}] ${v.proposal.number}`);
  }

  console.log(`Done. Snapshotted ${done} version${done === 1 ? '' : 's'}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
