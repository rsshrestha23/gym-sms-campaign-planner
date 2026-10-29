import { config } from '../config';
import { migrate } from '../db/migrate';
import { createPool } from '../db/pool';
import { seed } from './seed';

async function main() {
  const pool = createPool(config.databaseUrl, 2);
  try {
    await migrate(pool);
    const result = await seed(pool);
    console.log(`Seeded ${result.branches} branches, ${result.members} members, campaign ${result.campaignId}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
