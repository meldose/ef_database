#!/bin/sh
set -eu
BACKUP_DIR="${ALTEGRO_BACKUP_DIR:-./backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$BACKUP_DIR"
pg_dump --format=custom --file="$BACKUP_DIR/altegro.dump" "${DATABASE_URL:?DATABASE_URL is required}"
if [ "${OBJECT_STORAGE_DRIVER:-}" = "s3" ]; then
  if [ -n "${OBJECT_STORAGE_ENDPOINT:-}" ]; then
    aws s3 sync "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}" "$BACKUP_DIR/objects" --endpoint-url "$OBJECT_STORAGE_ENDPOINT"
  else
    aws s3 sync "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}" "$BACKUP_DIR/objects"
  fi
fi
printf 'Backup created in %s\n' "$BACKUP_DIR"
