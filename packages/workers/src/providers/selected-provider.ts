import fs from 'node:fs';
import { HttpSmsProvider } from './http-provider';
import type { SmsProvider } from './provider';
import { SimulatedProvider } from './simulated-provider';
import { TwilioSmsProvider } from './twilio-provider';

/** Reads `NAME` or, preferably, the secret-manager-mounted file at `NAME_FILE`. */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return env[name];
}

/**
 * Provider selection: `twilio` in production (the selected vendor), `http` for the generic HTTPS
 * adapter (used with the bundled mock provider locally), `simulated` for tests and dry runs.
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
  if (kind === 'twilio') {
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = readSecret(env, 'TWILIO_API_KEY_SECRET') ?? readSecret(env, 'TWILIO_AUTH_TOKEN');
    if (!accountSid || !authToken) throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN(_FILE) or TWILIO_API_KEY_SECRET(_FILE)');
    return new TwilioSmsProvider({
      accountSid,
      authToken,
      apiKeySid: env.TWILIO_API_KEY_SID,
      from: env.TWILIO_FROM,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      statusCallbackUrl: env.TWILIO_STATUS_CALLBACK_URL,
      timeoutMs: Number(env.SMS_PROVIDER_TIMEOUT_MS ?? 10_000),
    });
  }
  throw new Error(`Unknown SMS_PROVIDER ${kind}`);
}
