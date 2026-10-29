import type { PoolClient } from 'pg';

export interface AudienceSnapshot {
  version: number;
  memberCount: number;
  created: boolean;
}

/**
 * Returns the campaign's finalized audience snapshot, creating version 1 (or the next version) if
 * the campaign has none. Must run inside a transaction that already holds the campaign row lock.
 *
 * The copy is one INSERT ... SELECT, so it is a single consistent snapshot of membership and never
 * passes through application memory. Once finalized, triggers reject any change to it; targeting
 * a different audience needs a new campaign revision.
 */
export async function ensureAudienceSnapshot(client: PoolClient, campaignId: number): Promise<AudienceSnapshot> {
  const { rows: current } = await client.query<{ version: number; member_count: number }>(
    `SELECT v.version, v.member_count FROM campaigns c
       JOIN campaign_audience_versions v ON v.campaign_id = c.id AND v.version = c.audience_version
      WHERE c.id = $1`,
    [campaignId],
  );
  if (current[0]) return { version: current[0].version, memberCount: current[0].member_count, created: false };

  const { rows: next } = await client.query<{ version: number }>(
    `INSERT INTO campaign_audience_versions (campaign_id, version)
     SELECT $1, COALESCE(max(version), 0) + 1 FROM campaign_audience_versions WHERE campaign_id = $1
     RETURNING version`,
    [campaignId],
  );
  const version = next[0].version;
  const copied = await client.query(
    `INSERT INTO campaign_audience_members (campaign_id, audience_version, branch_id, member_id, time_zone, opted_out_at_plan)
     SELECT cb.campaign_id, $2, m.branch_id, m.id, b.time_zone, m.sms_opt_out
       FROM campaign_branches cb
       JOIN branches b ON b.id = cb.branch_id
       JOIN members m ON m.branch_id = b.id
      WHERE cb.campaign_id = $1`,
    [campaignId, version],
  );
  const memberCount = copied.rowCount ?? 0;
  await client.query(
    `UPDATE campaign_audience_versions SET finalized_at = now(), member_count = $3 WHERE campaign_id = $1 AND version = $2`,
    [campaignId, version, memberCount],
  );
  await client.query(`UPDATE campaigns SET audience_version = $2 WHERE id = $1`, [campaignId, version]);
  return { version, memberCount, created: true };
}
