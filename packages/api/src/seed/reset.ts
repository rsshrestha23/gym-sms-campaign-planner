import { config } from '../config';
import { migrate } from '../db/migrate';
import { createPool } from '../db/pool';
import { resetDatabase, seed } from './seed';

/** `npm run reset`: clears campaign sends, provider events, raw receipts, and seed rows, then reseeds. */
async function main() {
  const pool = createPool(config.databaseUrl, 2);
  try {
    await migrate(pool);
    await resetDatabase(pool);
    const result = await seed(pool);
    console.log(
      `Reset complete: cleared sends/events/receipts and reseeded ${result.members} members. ` +
        `Campaign ${result.campaignId} is unplanned; call POST /campaigns/${result.campaignId}/plan.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
