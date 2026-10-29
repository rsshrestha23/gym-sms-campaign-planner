import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { signRequest } from '../../../api/src/webhooks/signature-verifier';

/**
 * Local stand-in for an SMS vendor (no vendor has been selected). Speaks the generic HTTP
 * contract HttpSmsProvider uses, honours Idempotency-Key like a real provider must, can inject
 * failures, and sends signed delivery callbacks (sent + final, 85/10/5) to the API webhook,
 * retrying them like a real provider would.
 *
 * Env: PORT, MOCK_PROVIDER_API_KEY, WEBHOOK_URL, WEBHOOK_SIGNING_SECRET,
 *      MOCK_FAIL_RATE (503), MOCK_RATE_LIMIT_RATE (429), MOCK_TIMEOUT_RATE (accept, never respond),
 *      MOCK_CALLBACK_DELAY_MS.
 */
const env = process.env;
const port = Number(env.PORT ?? 4010);
const apiKey = env.MOCK_PROVIDER_API_KEY ?? 'mock-provider-key';
const webhookUrl = env.WEBHOOK_URL;
const secret = env.WEBHOOK_SIGNING_SECRET;
const rate = (name: string) => Number(env[name] ?? 0);
const callbackDelayMs = Number(env.MOCK_CALLBACK_DELAY_MS ?? 2000);

const messages = new Map<string, { id: string; sendId: number | null }>();
let accepted = 0;
let deduped = 0;

async function postWebhook(payload: object, attempt = 1): Promise<void> {
  if (!webhookUrl) return;
  const raw = JSON.stringify(payload);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? signRequest(raw, secret) : {}) },
      body: raw,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) throw new Error(`HTTP ${res.status}`);
  } catch {
    if (attempt < 6) setTimeout(() => void postWebhook(payload, attempt + 1), 500 * 2 ** attempt);
  }
}

function scheduleCallbacks(id: string, sendId: number) {
  const roll = Math.random();
  const final = roll < 0.85 ? 'delivered' : roll < 0.95 ? 'undelivered' : 'failed';
  const now = Date.now();
  setTimeout(() => void postWebhook({ eventId: `${id}:sent`, sendId, status: 'sent', occurredAt: new Date(now).toISOString() }), callbackDelayMs / 4);
  setTimeout(
    () => void postWebhook({ eventId: `${id}:final`, sendId, status: final, occurredAt: new Date(now + callbackDelayMs).toISOString() }),
    callbackDelayMs,
  );
}

const server = http.createServer((req, res) => {
  const reply = (status: number, body: object, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': randomUUID(), ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/stats') return reply(200, { accepted, deduped, messages: messages.size });
  if (req.method !== 'POST' || req.url !== '/messages') return reply(404, { error: 'not_found' });
  if (req.headers.authorization !== `Bearer ${apiKey}`) return reply(401, { error: 'unauthorized' });

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const key = req.headers['idempotency-key'];
    let body: { to?: string; body?: string; clientReference?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: 'invalid_json' });
    }
    if (typeof key !== 'string' || !body.to || !body.body) return reply(422, { error: 'missing_fields' });

    const existing = messages.get(key);
    if (existing) {
      deduped++;
      return reply(200, { id: existing.id, idempotent_replay: true });
    }
    const r = Math.random();
    if (r < rate('MOCK_RATE_LIMIT_RATE')) return reply(429, { error: 'rate_limited' }, { 'retry-after': '1' });
    if (r < rate('MOCK_RATE_LIMIT_RATE') + rate('MOCK_FAIL_RATE')) return reply(503, { error: 'unavailable' });

    const id = `msg_${randomUUID()}`;
    const sendId = Number(/^campaign-send:(\d+)$/.exec(body.clientReference ?? key)?.[1]) || null;
    messages.set(key, { id, sendId });
    accepted++;
    if (sendId) scheduleCallbacks(id, sendId);
    if (r > 1 - rate('MOCK_TIMEOUT_RATE')) return; // accepted, but the response is "lost"
    reply(202, { id });
  });
});

server.listen(port, () => console.log(JSON.stringify({ msg: 'mock-provider.listening', port, webhookUrl })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
