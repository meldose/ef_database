# altegro.de production inputs

The repository now contains the reverse proxy, TLS, provider runtime and monitoring configuration. The deployment host still needs these external inputs:

1. Point the `A`/`AAAA` records for `altegro.de` at the deployment host and allow inbound TCP 80/443 and UDP 443.
2. Install Docker Compose v2 and create every external secret declared in `compose.production.yaml` plus `altegro_metrics_token`.
3. Place the approved AutoXing wrapper on the host and set `AUTOXING_REPO_HOST_PATH` to that directory. It is mounted read-only at `/opt/autoxing`.
4. Set `CENOBOTS_ROBOT_OPEN_IDS` to the comma-separated Open IDs authorized for the same EU API account.
5. Keep `CENOBOTS_COMMANDS_ENABLED=false` until the physical command safety review is complete.
6. Set `ALTEGRO_DOMAIN=altegro.de` and `ACME_EMAIL` before running `scripts/deploy-production.sh`.

Caddy obtains and renews the public certificate automatically. Altegro is only published on loopback; Caddy is the public entry point. Prometheus is also loopback-only on port 9090 and authenticates to `/metrics` with the mounted monitoring token.
