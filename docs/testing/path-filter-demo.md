# Path-filter demo (PR #137)

This file exists only as the unrelated-file proof for the Blocks live gate CI
work: it touches no path-filtered surface (`crates/buzz-core/src/block.rs`,
`kind.rs`, `buzz-relay` blocks modules, `desktop/src/features/blocks/**`,
`blocks-live.spec.ts`, the blocks migrations, `scripts/prove-blocks.sh`,
`scripts/start-isolated-test-relay.sh`, `docker-compose.harness.yml`, or
`.github/workflows/ci.yml`), so the `blocks` path filter must report false and
the `Blocks Live Gate` job must not run. Reverted immediately after the run.
