# Enterprise reference adapters

The CRM and service adapters implement the same narrow contract regardless of the selected vendor. Provider IDs remain External Identities and never become Altegro primary keys.

Configuration:

```text
CRM_INTEGRATION_LIVE=true
CRM_INTEGRATION_BASE_URL=https://crm.example/api
CRM_INTEGRATION_RECORDS_PATH=/organizations
CRM_INTEGRATION_TOKEN_FILE=/run/secrets/altegro_crm_token

SERVICE_INTEGRATION_LIVE=true
SERVICE_INTEGRATION_BASE_URL=https://service.example/api
SERVICE_INTEGRATION_RECORDS_PATH=/service-cases
SERVICE_INTEGRATION_TOKEN_FILE=/run/secrets/altegro_service_token
SERVICE_WEBHOOK_SECRET_FILE=/run/secrets/altegro_service_webhook_secret
```

The outbound adapter accepts arrays directly or in `data`, `items`, `records`, or `results`. CRM records require an external ID and organization name. Service records require an external ID, a mappable status, and a robot serial number or provider robot ID.

Signed service webhooks use `HMAC-SHA256(secret, "<unix timestamp>.<raw JSON body>")`. Send the timestamp in `x-altegro-timestamp` and the hexadecimal signature in `x-altegro-signature`. Altegro rejects stale, malformed, duplicate, or unmatched messages.
