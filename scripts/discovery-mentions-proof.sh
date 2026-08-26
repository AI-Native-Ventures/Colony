#!/usr/bin/env bash
# Real-relay proof for Discovery entity mentions (PR 2 of the Colony Credits
# and Entity Mentions delivery).
#
# Requires the isolated harness used by e2e_discovery.rs:
#   docker compose up -d postgres redis relay-test  (or your local equivalent)
#   RELAY_URL=ws://localhost:3030 DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz
#
# What it proves, on one commit:
#   1. A member message carrying strict ["discovery", kind, id] tags is
#      accepted by the relay and adds no recipient.
#   2. resolve_entities hydrates current permission-checked projections for
#      Industry, Vertical, Campaign, bounded Campaign Leads, Lead, and Run.
#   3. An unknown ID resolves to unavailable without revealing existence.
#   4. The same IDs resolved from a different community are all unavailable.
#
# This script does NOT prove desktop composer rendering; that lives in
# desktop/tests/e2e/discovery-mentions.spec.ts under the Playwright smoke gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. ./bin/activate-hermit

export RELAY_URL="${RELAY_URL:-ws://localhost:3030}"
export DATABASE_URL="${DATABASE_URL:-postgres://buzz:buzz_dev@localhost:5471/buzz}"

echo "== running discovery mention hydration proof against $RELAY_URL =="
cargo test -p buzz-test-client --test e2e_discovery \
    -- --ignored --nocapture discovery_entity_mentions

echo "== running message-plane mention suites =="
cargo test -p buzz-core -p buzz-sdk -p buzz-db
(cd desktop && pnpm test -- src/features/messages/lib/discoveryMentionRefs.test.mjs \
    && pnpm exec playwright test tests/e2e/discovery-mentions.spec.ts --project=smoke)

echo "== proof complete =="
