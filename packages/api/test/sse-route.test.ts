import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import { SseHub } from '../src/live/sse-hub';
import { freshSeed, testPool } from './helpers';

const pool = testPool();
const hub = new SseHub(50);
const server = http.createServer(createApp({ pool, hub }));
let base: string;

beforeAll(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  hub.close();
  await new Promise((r) => server.close(r));
  await pool.end();
});

/** Minimal SSE reader collecting frames until `until` returns true. */
async function readFrames(campaignId: number, until: (frames: string[]) => boolean, onReady?: () => Promise<void>) {
  const controller = new AbortController();
  const res = await fetch(`${base}/campaigns/${campaignId}/events`, { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: string[] = [];
  let readyHandled = false;
  try {
    while (!until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        frames.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      if (!readyHandled && frames.some((f) => f.includes('event: ready'))) {
        readyHandled = true;
        await onReady?.();
      }
    }
  } finally {
    controller.abort();
  }
  return frames;
}

const parseUpdates = (frames: string[]) =>
  frames.filter((f) => f.startsWith('event: send.updated')).map((f) => JSON.parse(f.split('\ndata: ')[1]));

describe('GET /campaigns/:id/events', () => {
  it('streams committed webhook updates to subscribers of that campaign', async () => {
    const { rows } = await pool.query(`SELECT id, branch_id, scheduled_at FROM sends WHERE status = 'planned' ORDER BY id LIMIT 1`);
    const send = rows[0];
    const frames = await readFrames(
      1,
      (f) => parseUpdates(f).length >= 2,
      async () => {
        expect(hub.clientCount(1)).toBe(1);
        const app = server;
        for (const [eventId, status] of [['sse-1', 'sent'], ['sse-1', 'sent'], ['sse-2', 'delivered'], ['sse-3', 'sent']]) {
          await request(app)
            .post('/webhooks/provider')
            .set('content-type', 'application/json')
            .send(JSON.stringify({ eventId, sendId: send.id, status, occurredAt: '2026-10-23T08:00:10Z' }))
            .expect(200);
        }
      },
    );
    expect(frames[0]).toContain('retry: 2000');
    const updates = parseUpdates(frames);
    // Only the two real transitions are published: the duplicate and the stale `sent` are not.
    expect(updates).toEqual([
      expect.objectContaining({ campaignId: 1, sendId: send.id, branchId: send.branch_id, status: 'sent', statusVersion: 2, scheduledAt: send.scheduled_at.toISOString() }),
      expect.objectContaining({ sendId: send.id, status: 'delivered', statusVersion: 3 }),
    ]);
  });

  it('sends heartbeats and cleans up disconnected clients', async () => {
    const frames = await readFrames(1, (f) => f.some((x) => x.startsWith(': heartbeat')));
    expect(frames.some((f) => f.startsWith(': heartbeat'))).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.clientCount()).toBe(0);
  });

  it('does not publish updates from a rolled-back transaction', async () => {
    const published: unknown[] = [];
    const spyHub = new SseHub(60_000);
    spyHub.publish = (u) => void published.push(u);
    const app = createApp({ pool, hub: spyHub });
    await request(app)
      .post('/webhooks/provider')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ eventId: 'sse-unknown', sendId: 999999, status: 'sent', occurredAt: '2026-10-23T08:00:10Z' }))
      .expect(200);
    expect(published).toEqual([]);
    spyHub.close();
  });

  it('returns 404 for an unknown campaign', async () => {
    await request(server).get('/campaigns/77/events').expect(404);
  });
});
