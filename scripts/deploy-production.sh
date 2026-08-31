#!/bin/sh
set -eu

DEPLOY_IMAGE=${ALTEGRO_IMAGE:?Set ALTEGRO_IMAGE to the immutable container image}
DEPLOY_DOMAIN=${ALTEGRO_DOMAIN:-altegro.de}
: "${ACME_EMAIL:?Set ACME_EMAIL for automatic TLS certificate notices}"
DEPLOY_URL=${ALTEGRO_HEALTH_URL:-https://${DEPLOY_DOMAIN}/ready}

export ALTEGRO_IMAGE="$DEPLOY_IMAGE"
export ALTEGRO_DOMAIN="$DEPLOY_DOMAIN"
if [ "${ALTEGRO_ENABLE_MONITORING:-true}" = "true" ]; then
  docker compose -f compose.yaml -f compose.production.yaml -f compose.proxy.yaml -f compose.monitoring.yaml pull
  docker compose -f compose.yaml -f compose.production.yaml -f compose.proxy.yaml -f compose.monitoring.yaml up -d --no-build --remove-orphans
else
  docker compose -f compose.yaml -f compose.production.yaml -f compose.proxy.yaml pull
  docker compose -f compose.yaml -f compose.production.yaml -f compose.proxy.yaml up -d --no-build --remove-orphans
fi

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

docker compose -f compose.yaml -f compose.production.yaml -f compose.proxy.yaml ps
docker compose -f compose.yaml -f compose.production.yaml -f compose.proxy.yaml logs --tail=100 altegro caddy
echo "Altegro failed its readiness check" >&2
exit 1
