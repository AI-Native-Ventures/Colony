# =============================================================================
# harness-ports.sh — single source of truth for the isolated harness port set.
#
# Sourced (not executed) by every harness launcher so all callers agree on one
# port set: scripts/start-isolated-test-relay.sh, scripts/prove-blocks.sh, and
# the discovery proof scripts.
#
# Every value resolves from the same BUZZ_HARNESS_*_PORT environment overrides
# and falls back to the historical fixed tuple, so a plain run is the old
# harness byte for byte:
#
#   relay main 3030 · postgres 5471 · redis 6471 · minio 9471/9472
#   relay health 8088 · relay metrics 9202
#
# To run a second harness concurrently on a disjoint set, override the ports
# and re-run (the minio console port is always minio + 1, same container):
#
#   export BUZZ_HARNESS_RELAY_PORT=3040  BUZZ_HARNESS_PG_PORT=5481
#   export BUZZ_HARNESS_REDIS_PORT=6481  BUZZ_HARNESS_MINIO_PORT=9481
#   export BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212
#   ./scripts/prove-blocks.sh
#
# The Compose project name derives from the relay main port, so containers and
# volumes stay separate between concurrent harnesses automatically.
# =============================================================================

HARNESS_RELAY_PORT="${BUZZ_HARNESS_RELAY_PORT:-3030}"
HARNESS_PG_PORT="${BUZZ_HARNESS_PG_PORT:-5471}"
HARNESS_REDIS_PORT="${BUZZ_HARNESS_REDIS_PORT:-6471}"
HARNESS_MINIO_PORT="${BUZZ_HARNESS_MINIO_PORT:-9471}"
HARNESS_MINIO_CONSOLE_PORT="$(( HARNESS_MINIO_PORT + 1 ))"
HARNESS_HEALTH_PORT="${BUZZ_HARNESS_HEALTH_PORT:-8088}"
HARNESS_METRICS_PORT="${BUZZ_HARNESS_METRICS_PORT:-9202}"

# The Compose project name must vary with the port set: with the fixed
# `buzz-harness` name, a second agent's `docker compose up` would attach to the
# first agent's containers and the port overrides would buy nothing.
if [[ "${HARNESS_RELAY_PORT}" == "3030" ]]; then
  HARNESS_PROJECT="buzz-harness"
else
  HARNESS_PROJECT="buzz-harness-${HARNESS_RELAY_PORT}"
fi

HARNESS_RELAY_HTTP_URL="http://localhost:${HARNESS_RELAY_PORT}"
HARNESS_RELAY_WS_URL="ws://localhost:${HARNESS_RELAY_PORT}"
HARNESS_DATABASE_URL="postgres://buzz:buzz_dev@localhost:${HARNESS_PG_PORT}/buzz"
