import { config } from '../config';
import { migrate } from './migrate';
import { createPool } from './pool';

async function main() {
  const pool = createPool(config.databaseUrl, 1);
  try {
    const ran = await migrate(pool);
    console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Schema is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
