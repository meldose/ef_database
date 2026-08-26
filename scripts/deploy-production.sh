#!/bin/sh
set -eu

DEPLOY_IMAGE=${ALTEGRO_IMAGE:?Set ALTEGRO_IMAGE to the immutable container image}
DEPLOY_URL=${ALTEGRO_HEALTH_URL:-http://127.0.0.1:3000/ready}

export ALTEGRO_IMAGE="$DEPLOY_IMAGE"
docker compose -f compose.yaml -f compose.production.yaml pull altegro
docker compose -f compose.yaml -f compose.production.yaml up -d --no-build --remove-orphans

attempt=1
while [ "$attempt" -le 30 ]; do
  if command -v curl >/dev/null 2>&1 && curl --fail --silent --show-error "$DEPLOY_URL" >/dev/null; then
    echo "Altegro deployment is ready: $DEPLOY_IMAGE"
    exit 0
  fi
  if command -v wget >/dev/null 2>&1 && wget -q -O /dev/null "$DEPLOY_URL"; then
    echo "Altegro deployment is ready: $DEPLOY_IMAGE"
    exit 0
  fi
  sleep 2
  attempt=$((attempt + 1))
done

docker compose -f compose.yaml -f compose.production.yaml ps
docker compose -f compose.yaml -f compose.production.yaml logs --tail=100 altegro
echo "Altegro failed its readiness check" >&2
exit 1
