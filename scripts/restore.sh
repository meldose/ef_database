#!/bin/sh
set -eu
BACKUP_DIR="${1:?Usage: scripts/restore.sh BACKUP_DIRECTORY}"
test -f "$BACKUP_DIR/altegro.dump"
pg_restore --clean --if-exists --no-owner --dbname="${DATABASE_URL:?DATABASE_URL is required}" "$BACKUP_DIR/altegro.dump"
if [ -d "$BACKUP_DIR/objects" ] && [ "${OBJECT_STORAGE_DRIVER:-}" = "s3" ]; then
  if [ -n "${OBJECT_STORAGE_ENDPOINT:-}" ]; then
    aws s3 sync "$BACKUP_DIR/objects" "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}" --endpoint-url "$OBJECT_STORAGE_ENDPOINT"
  else
    aws s3 sync "$BACKUP_DIR/objects" "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}"
  fi
fi
printf 'Restore completed from %s\n' "$BACKUP_DIR"
