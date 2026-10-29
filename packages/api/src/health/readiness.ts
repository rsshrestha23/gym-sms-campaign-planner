import { Router } from 'express';
import type { Pool } from 'pg';

export type ReadinessCheck = { name: string; check: () => Promise<unknown> };

/**
 * /health/live: the process is up (never fails because a dependency or the SMS provider is down,
 * so the orchestrator doesn't restart healthy pods during an outage).
 * /health/ready: PostgreSQL and (when configured) Redis answer within the timeout; failing this
 * only takes the instance out of load balancing.
 * /health: kept from v1 for compatibility (database check).
 */
export function healthRoutes(pool: Pool, extra: ReadinessCheck[] = [], timeoutMs = 2_000): Router {
  const router = Router();
  const checks: ReadinessCheck[] = [{ name: 'postgres', check: () => pool.query('SELECT 1') }, ...extra];
  const withTimeout = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);

  router.get('/health/live', (_req, res) => res.json({ status: 'ok' }));

  router.get('/health/ready', async (_req, res) => {
    const results = await Promise.all(
      checks.map(async (c) => {
        try {
          await withTimeout(c.check());
          return [c.name, 'ok'] as const;
        } catch (err) {
          return [c.name, (err as Error).message] as const;
        }
      }),
    );
    const ok = results.every(([, r]) => r === 'ok');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable', checks: Object.fromEntries(results) });
  });

  router.get('/health', async (_req, res) => {
    try {
      await withTimeout(pool.query('SELECT 1'));
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}
