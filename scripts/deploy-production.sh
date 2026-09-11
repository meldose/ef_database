#!/bin/sh
set -eu

DEPLOY_IMAGE=${ALTEGRO_IMAGE:?Set ALTEGRO_IMAGE to the immutable container image}
DEPLOY_FRONTEND_IMAGE=${ALTEGRO_FRONTEND_IMAGE:?Set ALTEGRO_FRONTEND_IMAGE to the immutable frontend image}
DEPLOY_DOMAIN=${ALTEGRO_DOMAIN:-altegro.de}
: "${ACME_EMAIL:?Set ACME_EMAIL for automatic TLS certificate notices}"
: "${LEGAL_OPERATOR_NAME:?Set the legal operator name}"
: "${LEGAL_REPRESENTATIVE:?Set the legal representative}"
: "${LEGAL_STREET:?Set the legal street address}"
: "${LEGAL_CITY:?Set the legal postal code and city}"
: "${LEGAL_EMAIL:?Set the legal contact email}"
DEPLOY_URL=${ALTEGRO_HEALTH_URL:-https://${DEPLOY_DOMAIN}/ready}

export ALTEGRO_IMAGE="$DEPLOY_IMAGE"
export ALTEGRO_FRONTEND_IMAGE="$DEPLOY_FRONTEND_IMAGE"
export ALTEGRO_DOMAIN="$DEPLOY_DOMAIN"

set -- -f compose.yaml -f compose.production.yaml -f compose.proxy.yaml
REQUIRED_SECRETS="autoxing_app_id autoxing_app_secret autoxing_app_code cenobots_access_key cenobots_secret_key cenobots_webhook_secret altegro_metrics_token altegro_postgres_password altegro_object_access_key altegro_object_secret_key"
if [ "${ALTEGRO_ENABLE_MONITORING:-true}" = "true" ]; then
  set -- "$@" -f compose.monitoring.yaml
  REQUIRED_SECRETS="$REQUIRED_SECRETS altegro_monitoring_webhook_url"
fi
if [ "${ALTEGRO_ENABLE_ALERTS:-true}" = "true" ]; then
  : "${EMAIL_ALERT_FROM:?Set EMAIL_ALERT_FROM}"
  : "${EMAIL_ALERT_RECIPIENTS:?Set EMAIL_ALERT_RECIPIENTS}"
  : "${EMAIL_SMTP_HOST:?Set EMAIL_SMTP_HOST}"
  : "${EMAIL_SMTP_USERNAME:?Set EMAIL_SMTP_USERNAME}"
  : "${SMS_ALERT_RECIPIENTS:?Set SMS_ALERT_RECIPIENTS}"
  : "${SMS_ALERT_WEBHOOK_URL:?Set SMS_ALERT_WEBHOOK_URL}"
  set -- "$@" -f compose.email.yaml
  REQUIRED_SECRETS="$REQUIRED_SECRETS altegro_smtp_password altegro_sms_webhook_token"
fi

MISSING_SECRETS=""
for secret in $REQUIRED_SECRETS; do
  if ! docker secret inspect "$secret" >/dev/null 2>&1; then MISSING_SECRETS="$MISSING_SECRETS $secret"; fi
done
if [ -n "$MISSING_SECRETS" ]; then
  echo "Missing Docker secrets:$MISSING_SECRETS" >&2
  exit 1
fi

docker compose "$@" config -q
docker compose "$@" pull
docker compose "$@" up -d --no-build --remove-orphans

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

docker compose "$@" ps
docker compose "$@" logs --tail=100 altegro frontend caddy
echo "Altegro failed its readiness check" >&2
exit 1
