# Deployment operator analytics

The operator portal is the private, read-only deployment command center at
`/analytics`. It reports metadata-only population, community, activity, person,
and live-session measures across every Colony community. It never returns event
or message content, signatures, private keys, provider credentials, model
settings, raw IP addresses, reverse DNS, or geolocation.

## Authority and serving

The production bundle is built into the relay image and is served only when an
exact admin authority is configured:

```text
BUZZ_ADMIN_HOST=admin.example.com
BUZZ_ADMIN_WEB_DIR=/srv/buzz/admin-web
RELAY_OPERATOR_API_ORIGIN=https://admin.example.com
RELAY_OPERATOR_PUBKEYS=<64-char hex>[,<64-char hex>...]
```

Every `GET /operator/analytics/*` request needs a fresh NIP-98 signature from
one of those public keys. The signature binds to the exact HTTPS URL, including
its raw query string, and uses the dedicated `operator-analytics` replay scope.
The browser delegates signing to NIP-07 or the Colony remote-signer bridge; it
does not receive or persist a private key.

Keep the SPA and API same-origin. If they must run separately, use a narrowly
scoped reverse proxy for `/operator/analytics/*`. Do not add wide-open CORS or
trust an inbound `Host` header as operator authority. A private ingress remains
useful defense in depth, but it does not replace individual NIP-98 identity.

## Sources and freshness

- Postgres authoritative metadata plus `operator_activity_daily` provides
  population, memberships, communities, and meaningful activity.
- `operator_activity_cursor` reports the worker observation time and last
  source-event watermark. The API marks a delayed worker as stale.
- Shared Redis leases provide online people and authenticated connections
  across all relay machines. `POD_NAME`, then `HOSTNAME`, labels each lease.
- Redis is mandatory for live cards. On outage, live state is `unavailable`;
  the relay never substitutes one process's local connection count.
- `operator_access_log` records the operator, route, request ID, digested
  filters/target, and outcome. Raw filters and targets are not stored.

Migration `0057_operator_analytics.sql` creates the rebuildable daily model,
cursor, indexes, and deployment access log. The relay's 30-second worker keeps
new activity current after the initial backfill.

## Controlled backfill

Run migrations first, then rebuild a bounded UTC range. `--to` is an exclusive
day boundary. Scope must be explicit and the source batch is bounded to
100–5000 events.

```bash
buzz-admin migrate
buzz-admin operator-analytics backfill \
  --all \
  --from 2026-01-01 \
  --to 2026-08-12 \
  --batch-size 1000
```

For selected communities, repeat `--community <uuid>` instead of `--all`.
The command uses the same classifier and transaction as the runtime rollup,
prints only counts and watermarks, continues across selected communities, and
exits nonzero if any community fails. Repeating the same range is idempotent.

## First production run

1. Deploy the image and allow migration 0057 to complete.
2. Set `RELAY_OPERATOR_PUBKEYS` as a deployment secret; never commit a private
   key or signer URI.
3. Run the controlled backfill for the intended historical window.
4. Confirm the rollup worker and Redis session gauges are healthy.
5. Open `/analytics` on the exact admin origin and connect an allowlisted
   signer.
6. Verify Definitions before relying on counts, then compare a representative
   community and UTC range against exact source queries.

The current portal does not install or query PostHog. PostHog may later answer
separate product-funnel questions, but it is not an authority for deployment
people, memberships, activity, or live sessions.
