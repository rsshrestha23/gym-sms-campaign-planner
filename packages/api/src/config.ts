import fs from 'node:fs';

/** Reads `NAME`, or the file at `NAME_FILE` (how secret managers / Kubernetes secrets mount values). */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return env[name] || undefined;
}

const flag = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : !/^(0|false|no|off)$/i.test(v));

export const config = {
  databaseUrl: readSecret('DATABASE_URL') ?? 'postgres://gym:gym@localhost:5433/gym',
  redisUrl: readSecret('REDIS_URL'),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  production: process.env.NODE_ENV === 'production',
  /** Production runs migrations as a separate pre-deploy job; the demo migrates on start. */
  runMigrations: flag(process.env.RUN_MIGRATIONS, true),
  /** Loads the fixed three-branch demo dataset; never enabled in production. */
  seedDemoData: flag(process.env.SEED_DEMO_DATA, true),
  webhookToleranceSec: Number(process.env.WEBHOOK_TOLERANCE_SEC ?? 300),
  webhookRateLimit: process.env.WEBHOOK_RATE_LIMIT_PER_SECOND
    ? {
        ratePerSecond: Number(process.env.WEBHOOK_RATE_LIMIT_PER_SECOND),
        burst: Number(process.env.WEBHOOK_RATE_LIMIT_BURST ?? Number(process.env.WEBHOOK_RATE_LIMIT_PER_SECOND) * 2),
      }
    : undefined,
  /** Explicit opt-out of signature verification (local demo only). */
  webhookSignaturesDisabled: process.env.WEBHOOK_SIGNATURES === 'disabled',
  smsProviderAccount: process.env.SMS_PROVIDER_ACCOUNT ?? 'default',
};
