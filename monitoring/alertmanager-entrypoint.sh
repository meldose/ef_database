#!/bin/sh
set -eu

WEBHOOK_FILE=/run/secrets/altegro_monitoring_webhook_url
test -r "$WEBHOOK_FILE" || { echo "Monitoring webhook secret is missing" >&2; exit 1; }
WEBHOOK_URL=$(tr -d '\r\n' < "$WEBHOOK_FILE")
case "$WEBHOOK_URL" in
  https://*) ;;
  *) echo "Monitoring webhook URL must use HTTPS" >&2; exit 1 ;;
esac
case "$WEBHOOK_URL" in
  *"'"*) echo "Monitoring webhook URL contains an unsupported character" >&2; exit 1 ;;
esac

cat > /tmp/alertmanager.yml <<EOF
route:
  receiver: operations-webhook
  group_by: [alertname, provider]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
receivers:
  - name: operations-webhook
    webhook_configs:
      - url: '$WEBHOOK_URL'
        send_resolved: true
EOF

exec /bin/alertmanager --config.file=/tmp/alertmanager.yml --storage.path=/alertmanager
