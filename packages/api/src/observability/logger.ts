import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request context (correlation id) carried across async calls. */
export const requestContext = new AsyncLocalStorage<{ correlationId: string }>();

const REDACT_KEYS = /^(phone|to|authorization|apiKey|api_key|secret|password|signature|token|body|rawBody)$/i;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;

/** Strips secrets and phone numbers from log fields; member PII must never reach log storage. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') return value.replace(PHONE, '[phone]');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** One-line JSON logs with level, service fields, correlation id, and redaction. */
export function createLogger(base: Record<string, unknown> = {}, minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info'): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel] || process.env.LOG_LEVEL === 'silent') return;
    const correlationId = requestContext.getStore()?.correlationId;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(base) as object),
      ...(correlationId ? { correlationId } : {}),
      ...(redact(fields ?? {}) as object),
    });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger({ ...base, ...fields }, minLevel),
  };
}

export const logger = createLogger();
