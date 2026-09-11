# altegro.de production inputs

The repository now contains the reverse proxy, TLS, provider runtime and monitoring configuration. The deployment host still needs these external inputs:

1. Point the `A`/`AAAA` records for `altegro.de` at the deployment host and allow inbound TCP 80/443 and UDP 443.
2. Install Docker Compose v2 and create every external secret declared in `compose.production.yaml` plus `altegro_metrics_token`.
3. Place the approved AutoXing wrapper on the host and set `AUTOXING_REPO_HOST_PATH` to that directory. It is mounted read-only at `/opt/autoxing`.
4. Set `CENOBOTS_ROBOT_OPEN_IDS` to the comma-separated Open IDs authorized for the same EU API account.
5. Keep `CENOBOTS_COMMANDS_ENABLED=false` until the physical command safety review is complete.
6. Publish immutable backend and frontend images and set both `ALTEGRO_IMAGE` and `ALTEGRO_FRONTEND_IMAGE`.
7. Set `ALTEGRO_DOMAIN=altegro.de`, `ACME_EMAIL`, and every `LEGAL_*` identity field before running `scripts/deploy-production.sh`.
8. Configure the real SMTP and SMS webhook settings when `ALTEGRO_ENABLE_ALERTS=true` (the production default), and create the `altegro_smtp_password` and `altegro_sms_webhook_token` secrets.
9. Create `altegro_monitoring_webhook_url` containing the HTTPS incident receiver used by Alertmanager.

Caddy obtains and renews certificates for `altegro.de` and `www.altegro.de`, redirects `www` to the canonical domain, routes `/api`, readiness and documentation to the backend, and routes application pages to the typed Next.js frontend. Altegro is only published on loopback; Caddy is the public entry point. Prometheus and Alertmanager are also loopback-only and authenticate to internal services with mounted secrets.

The current host uses Apache on ports 80 and 443. During an approved maintenance window, stop and disable that virtual host before starting Caddy; do not run both public proxies on the same ports. Confirm that `https://altegro.de/health` succeeds with normal certificate verification before allowing user sign-in.

The deployment script performs a fail-fast preflight for immutable image names, legal identity, alert settings, Docker secrets and the merged Compose configuration. It will not start a partial production stack. Use secure files as input to `docker secret create`; never pass secret values directly on a command line or commit them to this repository.
