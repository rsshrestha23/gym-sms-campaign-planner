import fs from 'node:fs';
import { HttpSmsProvider } from './http-provider';
import type { SmsProvider } from './provider';
import { SimulatedProvider } from './simulated-provider';

/** Reads `NAME` or, preferably, the secret-manager-mounted file at `NAME_FILE`. */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return env[name];
}

/**
 * Provider selection. No SMS vendor has been chosen yet, so production uses the generic HTTPS
 * adapter (pointed at the vendor, or at the bundled mock provider locally); `simulated` is the
 * in-process provider for tests and dry runs.
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): SmsProvider {
  const kind = env.SMS_PROVIDER ?? 'simulated';
  if (kind === 'simulated') return new SimulatedProvider();
  if (kind === 'http') {
    const url = env.SMS_PROVIDER_URL;
    const apiKey = readSecret(env, 'SMS_PROVIDER_API_KEY');
    if (!url || !apiKey) throw new Error('SMS_PROVIDER=http needs SMS_PROVIDER_URL and SMS_PROVIDER_API_KEY(_FILE)');
    return new HttpSmsProvider({ url, apiKey, timeoutMs: Number(env.SMS_PROVIDER_TIMEOUT_MS ?? 10_000) });
  }
  throw new Error(`Unknown SMS_PROVIDER ${kind}`);
}
