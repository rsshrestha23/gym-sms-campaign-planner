-- Branch/status counters maintained in the same transaction as every send change, so the summary
-- endpoint reads O(branches × statuses) rows instead of aggregating millions of sends.
-- Statement-level triggers with transition tables: one counter upsert per affected
-- (campaign, branch, status) per statement, so a 10k-row planning chunk is not 10k counter writes.
-- sends remains canonical; reconcile_status_counts() repairs any drift.

CREATE TABLE campaign_branch_status_counts (
  campaign_id  integer NOT NULL,
  branch_id    integer NOT NULL,
  status       text    NOT NULL,
  -- No CHECK (count >= 0): Postgres checks it on the proposed INSERT row before ON CONFLICT
  -- resolves, which would reject every negative delta. Drift is caught by reconcile_status_counts().
  count        bigint  NOT NULL,
  PRIMARY KEY (campaign_id, branch_id, status)
);

CREATE FUNCTION status_counts_apply(p_delta jsonb) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO campaign_branch_status_counts AS c (campaign_id, branch_id, status, count)
  SELECT (d->>'campaign_id')::int, (d->>'branch_id')::int, d->>'status', (d->>'delta')::bigint
    FROM jsonb_array_elements(p_delta) d
   ORDER BY 1, 2, 3 -- fixed lock order across concurrent statements avoids deadlocks
  ON CONFLICT (campaign_id, branch_id, status) DO UPDATE SET count = c.count + EXCLUDED.count;
$$;

CREATE FUNCTION sends_status_counts_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM status_counts_apply(COALESCE((
    SELECT jsonb_agg(jsonb_build_object('campaign_id', campaign_id, 'branch_id', branch_id, 'status', status, 'delta', n))
      FROM (SELECT campaign_id, branch_id, status, count(*) AS n FROM new_rows GROUP BY 1, 2, 3) g), '[]'));
  RETURN NULL;
END;
$$;

CREATE FUNCTION sends_status_counts_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM status_counts_apply(COALESCE((
    SELECT jsonb_agg(jsonb_build_object('campaign_id', campaign_id, 'branch_id', branch_id, 'status', status, 'delta', n))
      FROM (
        SELECT campaign_id, branch_id, status, sum(d) AS n FROM (
          SELECT o.campaign_id, o.branch_id, o.status, -1 AS d
            FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE n.status <> o.status
          UNION ALL
          SELECT n.campaign_id, n.branch_id, n.status, 1
            FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE n.status <> o.status
        ) x GROUP BY 1, 2, 3 HAVING sum(d) <> 0) g), '[]'));
  RETURN NULL;
END;
$$;

CREATE FUNCTION sends_status_counts_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM status_counts_apply(COALESCE((
    SELECT jsonb_agg(jsonb_build_object('campaign_id', campaign_id, 'branch_id', branch_id, 'status', status, 'delta', -n))
      FROM (SELECT campaign_id, branch_id, status, count(*) AS n FROM old_rows GROUP BY 1, 2, 3) g), '[]'));
  RETURN NULL;
END;
$$;

CREATE TRIGGER sends_status_counts_insert AFTER INSERT ON sends
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sends_status_counts_insert();
CREATE TRIGGER sends_status_counts_update AFTER UPDATE ON sends
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION sends_status_counts_update();
CREATE TRIGGER sends_status_counts_delete AFTER DELETE ON sends
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION sends_status_counts_delete();

-- Recomputes one campaign's counters from sends and returns the rows that had drifted.
CREATE FUNCTION reconcile_status_counts(p_campaign_id integer)
RETURNS TABLE (branch_id integer, status text, projected bigint, actual bigint)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
BEGIN
  -- Serialize against writers for this campaign's counters while recomputing.
  PERFORM 1 FROM campaign_branch_status_counts c WHERE c.campaign_id = p_campaign_id FOR UPDATE;
  RETURN QUERY
  WITH actual AS (
    SELECT s.branch_id, s.status, count(*)::bigint AS n FROM sends s WHERE s.campaign_id = p_campaign_id GROUP BY 1, 2
  ), drift AS (
    SELECT COALESCE(a.branch_id, c.branch_id) AS branch_id, COALESCE(a.status, c.status) AS status,
           COALESCE(c.count, 0) AS projected, COALESCE(a.n, 0) AS actual
      FROM actual a
      FULL JOIN (SELECT * FROM campaign_branch_status_counts WHERE campaign_id = p_campaign_id) c
        ON c.branch_id = a.branch_id AND c.status = a.status
     WHERE COALESCE(c.count, 0) <> COALESCE(a.n, 0)
  ), fix AS (
    INSERT INTO campaign_branch_status_counts AS t (campaign_id, branch_id, status, count)
    SELECT p_campaign_id, d.branch_id, d.status, d.actual FROM drift d
    ON CONFLICT (campaign_id, branch_id, status) DO UPDATE SET count = EXCLUDED.count
  )
  SELECT d.branch_id, d.status, d.projected, d.actual FROM drift d;
END;
$$;

INSERT INTO campaign_branch_status_counts (campaign_id, branch_id, status, count)
SELECT campaign_id, branch_id, status, count(*) FROM sends GROUP BY 1, 2, 3;
