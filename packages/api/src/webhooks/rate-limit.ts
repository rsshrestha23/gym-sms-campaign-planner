import type { RequestHandler } from 'express';

/**
 * Per-instance token bucket keyed by client IP, applied before any database work so a flood of
 * (possibly unauthenticated) webhook requests cannot exhaust PostgreSQL. Edge rate limiting at the
 * load balancer/WAF is the global layer; this protects each replica.
 */
export function tokenBucket({
  ratePerSecond,
  burst,
  onLimited,
  maxKeys = 10_000,
}: {
  ratePerSecond: number;
  burst: number;
  onLimited?: () => void;
  maxKeys?: number;
}): RequestHandler {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value!);
      b = { tokens: burst, at: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSecond);
    b.at = now;
    if (b.tokens < 1) {
      onLimited?.();
      res.setHeader('Retry-After', String(Math.ceil((1 - b.tokens) / ratePerSecond)));
      return res.status(429).json({ error: 'rate_limited', retryable: true });
    }
    b.tokens -= 1;
    next();
  };
}
