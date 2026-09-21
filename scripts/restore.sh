#!/bin/sh
set -eu

BACKUP_DIR="${1:?Usage: ALTEGRO_RESTORE_CONFIRM=RESTORE scripts/restore.sh BACKUP_DIRECTORY}"
: "${DATABASE_URL:?DATABASE_URL is required}"
if [ "${ALTEGRO_RESTORE_CONFIRM:-}" != "RESTORE" ]; then echo "Set ALTEGRO_RESTORE_CONFIRM=RESTORE to acknowledge the destructive database restore" >&2; exit 1; fi
for command in pg_restore sha256sum; do command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 1; }; done
test -f "$BACKUP_DIR/altegro.dump"
test -f "$BACKUP_DIR/manifest.txt"
test -f "$BACKUP_DIR/checksums.sha256"
grep -qx 'format=altegro-backup-v1' "$BACKUP_DIR/manifest.txt" || { echo "Unsupported backup format" >&2; exit 1; }
(cd "$BACKUP_DIR" && sha256sum -c checksums.sha256)
pg_restore --list "$BACKUP_DIR/altegro.dump" >/dev/null
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$DATABASE_URL" "$BACKUP_DIR/altegro.dump"
if grep -qx 'objects_included=true' "$BACKUP_DIR/manifest.txt" && [ "${OBJECT_STORAGE_DRIVER:-}" = "s3" ]; then
  command -v aws >/dev/null 2>&1 || { echo "aws CLI is required for S3 restore" >&2; exit 1; }
  test -d "$BACKUP_DIR/objects"
  if [ -n "${OBJECT_STORAGE_ENDPOINT:-}" ]; then aws s3 sync "$BACKUP_DIR/objects" "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}" --endpoint-url "$OBJECT_STORAGE_ENDPOINT" --only-show-errors
  else aws s3 sync "$BACKUP_DIR/objects" "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}" --only-show-errors; fi
fi
printf 'Restore completed and checksums verified from %s\n' "$BACKUP_DIR"
