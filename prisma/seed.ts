// Seeds the public plans. Safe to re-run: existing rows keep the limits an
// admin may have edited; only missing plans are created.
import { getPrisma } from "../src/db/client.js";
import { PUBLIC_PLANS } from "../src/config/plans.js";

const prisma = getPrisma();

try {
  for (const plan of PUBLIC_PLANS) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      create: { ...plan, isPublic: true },
      update: {},
    });
  }
  console.log(`Seeded ${PUBLIC_PLANS.length} plans.`);
} finally {
  await prisma.$disconnect();
}
