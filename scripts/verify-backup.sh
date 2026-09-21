#!/bin/sh
set -eu

BACKUP_DIR="${1:?Usage: ALTEGRO_DRILL_DATABASE_URL=postgres://... scripts/verify-backup.sh BACKUP_DIRECTORY}"
: "${DATABASE_URL:?DATABASE_URL must identify the source database}"
: "${ALTEGRO_DRILL_DATABASE_URL:?ALTEGRO_DRILL_DATABASE_URL must identify a disposable isolated database}"
if [ "$DATABASE_URL" = "$ALTEGRO_DRILL_DATABASE_URL" ]; then echo "The drill database must not be the source database" >&2; exit 1; fi
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }
ALTEGRO_RESTORE_CONFIRM=RESTORE DATABASE_URL="$ALTEGRO_DRILL_DATABASE_URL" OBJECT_STORAGE_DRIVER=none sh "$(dirname "$0")/restore.sh" "$BACKUP_DIR"
psql "$ALTEGRO_DRILL_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT CASE WHEN EXISTS (SELECT 1 FROM application_snapshots WHERE id=1) THEN 'snapshot-ok' ELSE 'snapshot-missing' END;" | grep -qx snapshot-ok
psql "$ALTEGRO_DRILL_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='cost_entries') THEN 'schema-ok' ELSE 'schema-missing' END;" | grep -qx schema-ok
psql "$ALTEGRO_DRILL_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT 'robots=' || count(*) FROM robots;"
printf 'Restore drill passed against the isolated database. Drop or recreate that database before the next drill.\n'
