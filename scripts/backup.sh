#!/bin/sh
set -eu

for command in pg_dump sha256sum mktemp; do command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 1; }; done
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${ALTEGRO_BACKUP_DIR:-./backups/$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_PARENT=$(dirname "$BACKUP_DIR")
BACKUP_NAME=$(basename "$BACKUP_DIR")
mkdir -p "$BACKUP_PARENT"
if [ -e "$BACKUP_DIR" ]; then echo "Backup target already exists: $BACKUP_DIR" >&2; exit 1; fi
STAGING_DIR=$(mktemp -d "$BACKUP_PARENT/.${BACKUP_NAME}.tmp.XXXXXX")
cleanup() { if [ -n "${STAGING_DIR:-}" ] && [ -d "$STAGING_DIR" ]; then rm -rf -- "$STAGING_DIR"; fi; }
trap cleanup EXIT HUP INT TERM

pg_dump --format=custom --compress=9 --file="$STAGING_DIR/altegro.dump" "$DATABASE_URL"
OBJECTS_INCLUDED=false
if [ "${OBJECT_STORAGE_DRIVER:-}" = "s3" ]; then
  command -v aws >/dev/null 2>&1 || { echo "aws CLI is required for S3 backups" >&2; exit 1; }
  mkdir -p "$STAGING_DIR/objects"
  if [ -n "${OBJECT_STORAGE_ENDPOINT:-}" ]; then aws s3 sync "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}" "$STAGING_DIR/objects" --endpoint-url "$OBJECT_STORAGE_ENDPOINT" --only-show-errors
  else aws s3 sync "s3://${OBJECT_STORAGE_BUCKET:?OBJECT_STORAGE_BUCKET is required}" "$STAGING_DIR/objects" --only-show-errors; fi
  OBJECTS_INCLUDED=true
fi

DUMP_SHA256=$(sha256sum "$STAGING_DIR/altegro.dump" | awk '{print $1}')
OBJECT_COUNT=$(find "$STAGING_DIR/objects" -type f 2>/dev/null | wc -l | tr -d ' ')
{
  printf 'format=altegro-backup-v1\n'
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'database_sha256=%s\n' "$DUMP_SHA256"
  printf 'objects_included=%s\n' "$OBJECTS_INCLUDED"
  printf 'object_count=%s\n' "$OBJECT_COUNT"
  printf 'source_revision=%s\n' "$(git rev-parse HEAD 2>/dev/null || printf unknown)"
} > "$STAGING_DIR/manifest.txt"
(cd "$STAGING_DIR" && find . -type f ! -name checksums.sha256 -print0 | sort -z | xargs -0 -r sha256sum) > "$STAGING_DIR/checksums.sha256"
chmod -R go-rwx "$STAGING_DIR"
mv "$STAGING_DIR" "$BACKUP_DIR"
STAGING_DIR=
trap - EXIT HUP INT TERM
printf 'Verified backup created in %s (%s objects)\n' "$BACKUP_DIR" "$OBJECT_COUNT"
