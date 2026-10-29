import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import IORedis from 'ioredis';
import request from 'supertest';
import { createApp } from '../src/app';
import { CampaignRepository } from '../src/campaigns/repository';
import { RedisStatusFanout, RedisStatusSubscriber } from '../src/live/redis-publisher';
import { SseHub } from '../src/live/sse-hub';
import { reconcileStatusCounts } from '../src/live/status-projection';
import { freshSeed, testPool } from './helpers';

const pool = testPool(60);
afterAll(() => pool.end());
beforeEach(async () => {
  await freshSeed(pool);
  await new CampaignRepository(pool).plan(1);
});

const projected = async () =>
  Object.fromEntries(
    (await pool.query(`SELECT branch_id, status, count::int FROM campaign_branch_status_counts WHERE campaign_id = 1 AND count <> 0`)).rows.map(
      (r) => [`${r.branch_id}:${r.status}`, r.count],
    ),
  );
const actual = async () =>
  Object.fromEntries(
    (await pool.query(`SELECT branch_id, status, count(*)::int AS n FROM sends WHERE campaign_id = 1 GROUP BY 1, 2`)).rows.map(
      (r) => [`${r.branch_id}:${r.status}`, r.n],
    ),
  );

describe('branch/status count projection', () => {
  it('matches the canonical sends after planning', async () => {
    expect(await projected()).toEqual(await actual());
    expect(await projected()).toMatchObject({ '1:planned': 1980, '1:not_scheduled': 120, '1:skipped_opt_out': 100, '2:planned': 1330 });
  });

  it('stays exact under concurrent duplicate and out-of-order webhook traffic', async () => {
    const app = createApp({ pool });
    const ids = (await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 60`)).rows.map((r) => r.id);
    const events = ids.flatMap((id, i) => [
      { eventId: `s-${id}`, sendId: id, status: 'sent', occurredAt: '2026-10-23T08:00:00Z' },
      { eventId: `f-${id}`, sendId: id, status: ['delivered', 'undelivered', 'failed'][i % 3], occurredAt: '2026-10-23T08:01:00Z' },
    ]);
    const traffic = [...events, ...events, ...events].sort(() => Math.random() - 0.5);
    await Promise.all(
      traffic.map((e) => request(app).post('/v1/webhooks/provider').set('content-type', 'application/json').send(JSON.stringify(e)).expect(200)),
    );
    expect(await projected()).toEqual(await actual());
    expect((await reconcileStatusCounts(pool, 1))).toEqual([]);
  });

  it('serves the summary from the projection', async () => {
    await pool.query(`UPDATE sends SET status = 'delivered' WHERE id IN (SELECT id FROM sends WHERE branch_id = 2 AND status = 'planned' ORDER BY id LIMIT 7)`);
    const res = await request(createApp({ pool })).get('/v1/campaigns/1/summary').expect(200);
    expect(res.body.branches[1].counts).toMatchObject({ planned: 1323, delivered: 7 });
  });

  it('detects and repairs drift against canonical sends', async () => {
    await pool.query(`UPDATE campaign_branch_status_counts SET count = count + 5 WHERE campaign_id = 1 AND branch_id = 3 AND status = 'planned'`);
    await pool.query(`DELETE FROM campaign_branch_status_counts WHERE campaign_id = 1 AND branch_id = 1 AND status = 'skipped_opt_out'`);
    const drift = await reconcileStatusCounts(pool, 1);
    expect(drift.sort((a, b) => a.branchId - b.branchId)).toEqual([
      { branchId: 1, status: 'skipped_opt_out', projected: 0, actual: 100 },
      { branchId: 3, status: 'planned', projected: 1335, actual: 1330 },
    ]);
    expect(await projected()).toEqual(await actual());
    expect(await reconcileStatusCounts(pool, 1)).toEqual([]);
  });

  it('replays deterministically: counts depend only on committed transitions', async () => {
    await pool.query(`UPDATE sends SET status = 'sent' WHERE campaign_id = 1 AND branch_id = 1 AND status = 'planned' AND member_id <= 50`);
    await pool.query(`UPDATE sends SET status = 'sent' WHERE campaign_id = 1 AND branch_id = 1 AND member_id <= 50 AND status = 'sent'`); // no-op replay
    await pool.query(`UPDATE sends SET status = 'failed' WHERE campaign_id = 1 AND branch_id = 1 AND member_id <= 10 AND status = 'sent'`);
    expect(await projected()).toEqual(await actual());
  });
});

describe('Redis fan-out across API instances', () => {
  it('delivers a change committed on instance A to an SSE client connected to instance B', async () => {
    const url = process.env.REDIS_URL!;
    const publisherConn = new IORedis(url);
    const subA = new IORedis(url);
    const subB = new IORedis(url);
    const hubA = new SseHub(60_000);
    const hubB = new SseHub(60_000);
    const fanout = new RedisStatusFanout(publisherConn);
    const appA = createApp({ pool, hub: hubA, fanout });
    const appB = createApp({ pool, hub: hubB, fanout });
    const subscribers = [new RedisStatusSubscriber(subA, hubA), new RedisStatusSubscriber(subB, hubB)];
    await Promise.all(subscribers.map((s) => s.start()));
    const serverB = http.createServer(appB);
    await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', r));
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${(serverB.address() as AddressInfo).port}/v1/campaigns/1/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!buffer.includes('event: ready')) buffer += decoder.decode((await reader.read()).value);

      const { rows } = await pool.query(`SELECT id FROM sends WHERE status = 'planned' ORDER BY id LIMIT 1`);
      await request(appA)
        .post('/v1/webhooks/provider')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ eventId: 'cross-1', sendId: rows[0].id, status: 'delivered', occurredAt: '2026-10-23T08:01:00Z' }))
        .expect(200);

      while (!buffer.includes('send.updated')) buffer += decoder.decode((await reader.read()).value);
      const data = JSON.parse(buffer.split('event: send.updated\ndata: ')[1].split('\n')[0]);
      expect(data).toMatchObject({ sendId: rows[0].id, status: 'delivered', statusVersion: 2 });
    } finally {
      controller.abort();
      await new Promise((r) => serverB.close(r));
      await Promise.all(subscribers.map((s) => s.stop()));
      hubA.close();
      hubB.close();
      await publisherConn.quit();
    }
  });

  it('drops a slow SSE consumer instead of buffering without bound', async () => {
    const hub = new SseHub(60_000, 10);
    const writes: string[] = [];
    let ended = false;
    const res = { writableLength: 0, write: (f: string) => { writes.push(f); res.writableLength += f.length; return true; }, end: () => { ended = true; } } as any;
    hub.subscribe(1, res);
    const update = { campaignId: 1, sendId: 1, branchId: 1, status: 'sent' as const, scheduledAt: null, updatedAt: '', statusVersion: 2 };
    hub.publish(update);
    hub.publish(update);
    expect(writes).toHaveLength(1);
    expect(ended).toBe(true);
    hub.close();
  });
});
