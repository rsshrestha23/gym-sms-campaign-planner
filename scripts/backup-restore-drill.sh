#!/usr/bin/env bash
# Backup/restore drill against the docker compose database (staging uses the same steps against a
# PITR snapshot of the managed instance; see docs/production-runbook.md#backup-and-restore).
#
#   1. pg_dump (custom format) of the live database
#   2. restore into a scratch database
#   3. verify: schema version, row counts, constraints/triggers active, counters reconcile
#   4. drop the scratch database
set -euo pipefail

DB_SERVICE=${DB_SERVICE:-db}
SOURCE_DB=${SOURCE_DB:-gym}
SCRATCH_DB=${SCRATCH_DB:-gym_restore_drill}
DUMP=/tmp/gym-drill.dump
psql() { docker compose exec -T "$DB_SERVICE" psql -U gym -v ON_ERROR_STOP=1 -tA "$@"; }

echo "1/4 dumping $SOURCE_DB"
start=$(date +%s)
docker compose exec -T "$DB_SERVICE" pg_dump -U gym -Fc -f "$DUMP" "$SOURCE_DB"
echo "    dump: $(docker compose exec -T "$DB_SERVICE" du -h "$DUMP" | cut -f1) in $(( $(date +%s) - start ))s"

echo "2/4 restoring into $SCRATCH_DB"
psql -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null
psql -d postgres -c "CREATE DATABASE $SCRATCH_DB" >/dev/null
start=$(date +%s)
docker compose exec -T "$DB_SERVICE" pg_restore -U gym -d "$SCRATCH_DB" --exit-on-error "$DUMP"
echo "    restore: $(( $(date +%s) - start ))s"

echo "3/4 verifying"
fail=0
check() { # name, sql, expected-sql (evaluated on source)
  local got want
  got=$(psql -d "$SCRATCH_DB" -c "$2")
  want=$(psql -d "$SOURCE_DB" -c "${3:-$2}")
  if [[ "$got" == "$want" ]]; then echo "    ok   $1 ($got)"; else echo "    FAIL $1: restored=$got source=$want"; fail=1; fi
}
check "migrations" "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations"
for t in members sends provider_event_receipts provider_event_applications send_attempts send_outbox status_event_outbox campaign_audience_members; do
  check "rows:$t" "SELECT count(*) FROM $t"
done
check "status counters reconcile" "SELECT count(*) FROM campaigns c, reconcile_status_counts(c.id)" "SELECT 0"
check "transition trigger active" \
  "SELECT count(*) FROM pg_trigger WHERE tgname IN ('sends_guard_transition','send_attempts_append_only','sends_status_counts_update') AND tgenabled = 'O'" "SELECT 3"
# Constraint enforcement survives restore: a final status must stay terminal.
if psql -d "$SCRATCH_DB" -c "UPDATE sends SET status = 'planned' WHERE id = (SELECT id FROM sends WHERE status = 'delivered' LIMIT 1)" >/dev/null 2>&1; then
  echo "    FAIL terminal status was reopened in the restored copy"; fail=1
else
  echo "    ok   terminal statuses enforced"
fi

echo "4/4 cleaning up"
psql -d postgres -c "DROP DATABASE $SCRATCH_DB" >/dev/null
docker compose exec -T "$DB_SERVICE" rm -f "$DUMP"
[[ $fail == 0 ]] && echo "DRILL PASSED" || { echo "DRILL FAILED"; exit 1; }
