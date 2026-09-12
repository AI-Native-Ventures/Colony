#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ci_workflow=${CI_WORKFLOW:-"$repo_root/.github/workflows/ci.yml"}
auto_tag_workflow=${AUTO_TAG_WORKFLOW:-"$repo_root/.github/workflows/auto-tag-on-release-pr-merge.yml"}
fly_workflow=${FLY_WORKFLOW:-"$repo_root/.github/workflows/fly-deploy-relay.yml"}

CI_WORKFLOW="$ci_workflow" \
AUTO_TAG_WORKFLOW="$auto_tag_workflow" \
FLY_WORKFLOW="$fly_workflow" \
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const ci = fs.readFileSync(process.env.CI_WORKFLOW, "utf8");
const ciWithSentinel = `${ci}\n  __contract_end__:\n`;
const autoTag = fs.readFileSync(process.env.AUTO_TAG_WORKFLOW, "utf8");
const fly = fs.readFileSync(process.env.FLY_WORKFLOW, "utf8");

function requireContract(condition, message) {
  if (!condition) {
    console.error(`release pipeline contract failed: ${message}`);
    process.exit(1);
  }
}

function job(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = ciWithSentinel.match(
    new RegExp(`^  ${escaped}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n)`, "m"),
  );
  requireContract(match, `CI job '${name}' is missing`);
  return match[0];
}

function filter(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = ci.match(
    new RegExp(`^            ${escaped}:\\n([\\s\\S]*?)(?=^            [a-zA-Z0-9_-]+:\\n|^      - name:|\\Z)`, "m"),
  );
  requireContract(match, `path filter '${name}' is missing`);
  return match[0];
}

requireContract(!/^  merge_group:\s*$/m.test(ci), "CI must not restore the disabled develop merge queue trigger");
requireContract(
  /^\s+cancel-in-progress: \$\{\{ github\.base_ref != 'main' \}\}$/m.test(ci),
  "CI must keep in-flight main promotion runs alive while retaining cancellation elsewhere",
);

const changes = job("changes");
for (const output of [
  "raw-rust",
  "raw-desktop",
  "raw-desktop-rust",
  "raw-web",
  "raw-mobile",
  "raw-blocks",
  "raw-desktop-integration",
  "raw-security",
  "raw-cross-compile",
  "core-enabled",
  "secondary-enabled",
  "release-push",
]) {
  requireContract(
    new RegExp(`^      ${output}:`, "m").test(changes),
    `Detect Changed Paths must expose '${output}'`,
  );
}
for (const output of ["rust", "desktop", "desktop-rust"]) {
  const line = changes.match(new RegExp(`^      ${output}:.*$`, "m"))?.[0] ?? "";
  requireContract(!line.includes("github.event_name == 'merge_group'"), `${output} must not be forced for a disabled merge queue`);
  requireContract(!line.includes("github.base_ref == 'main'"), `${output} must not be forced for main promotion PRs`);
  requireContract(line.includes("refs/heads/release"), `${output} must preserve full release push coverage`);
}

for (const bucket of [
  "rust",
  "desktop",
  "desktop-rust",
  "web",
  "mobile",
  "blocks",
  "desktop-integration",
  "security",
  "cross-compile",
]) {
  requireContract(
    filter(bucket).includes("'.github/workflows/ci.yml'"),
    `.github/workflows/ci.yml must exercise the '${bucket}' lane`,
  );
}

const coreJobs = [
  "rust-lint",
  "unit-tests",
  "desktop-core",
  "desktop-smoke-e2e",
  "desktop",
  "backend-integration",
  "relay-e2e",
  "agent-ask-e2e",
  "relay-suites",
];
for (const name of coreJobs) {
  const block = job(name);
  requireContract(block.includes("needs.changes.outputs.core-enabled == 'true'"), `${name} must use core event routing`);
  requireContract(!block.includes("github.event_name == 'push' ||"), `${name} must not rerun on every push`);
}

// windows-rust is intentionally absent from secondaryJobs: the Windows
// type-check moved out of ci.yml to .github/workflows/windows-typecheck-nightly.yml
// (2026-08). Its rust-cache entry (v0-rust-windows-msvc-windows-rust, 2.47 GB)
// was 26% of the 10 GB Actions cache budget and the eviction pressure it added
// starved desktop-e2e-relay's cache. It runs nightly on develop with a
// restore-only cache instead. Bring it back as a path-selected secondary job
// here AND in ci.yml once the Windows installer is code-signed and actually
// installable.
const secondaryJobs = [
  "desktop-e2e-integration-shard",
  "desktop-e2e-integration",
  "blocks-live-gate",
  "web",
  "mobile",
  "security",
  "server-cross-compile",
];
for (const name of secondaryJobs) {
  const block = job(name);
  requireContract(block.includes("needs.changes.outputs.secondary-enabled == 'true'"), `${name} must exclude merge_group and main push routing`);
  requireContract(block.includes("needs.changes.outputs.raw-"), `${name} must use raw path relevance`);
  requireContract(!block.includes("github.event_name == 'push' ||"), `${name} must not run unconditionally on push`);
}

const relayArtifacts = job("desktop-e2e-relay");
requireContract(relayArtifacts.includes("needs.changes.outputs.core-enabled == 'true'"), "relay artifact prerequisite must support required core jobs");
requireContract(relayArtifacts.includes("needs.changes.outputs.secondary-enabled == 'true'"), "relay artifact prerequisite must support path-selected Desktop Integration");
requireContract(relayArtifacts.includes("needs.changes.outputs.raw-"), "relay artifact prerequisite must use raw relevance for secondary work");

requireContract(/\n\s+if: \$\{\{ false \}\}/.test(job("real-shell-e2e")), "Real-shell must stay explicitly excluded until it can execute");

const literalPromotionNameCount = (ci.match(/^\s+name: Promotion Gate\s*$/gm) ?? []).length;
requireContract(literalPromotionNameCount === 0, "Promotion Gate must not use a literal name that also appears as skipped on non-promotion events");
const workflowDir = path.dirname(process.env.CI_WORKFLOW);
const repositoryLiteralPromotionNameCount = fs
  .readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => fs.readFileSync(path.join(workflowDir, name), "utf8"))
  .reduce((count, workflow) => count + (workflow.match(/^\s+name: Promotion Gate\s*$/gm) ?? []).length, 0);
requireContract(repositoryLiteralPromotionNameCount === 0, `literal Promotion Gate names are unsafe outside the promotion event; found ${repositoryLiteralPromotionNameCount}`);
const promotion = job("promotion-gate");
requireContract(promotion.includes("'Promotion Gate'"), "promotion job must emit the exact required context for main PRs");
requireContract(promotion.includes("'Promotion Gate (not applicable)'"), "non-promotion events must emit a different, non-required context name");
requireContract(promotion.includes("github.base_ref == 'main'"), "dynamic Promotion Gate name must distinguish main pull requests");
requireContract(promotion.includes("if: always()"), "Promotion Gate must run with always() so dependency failures are reported");
requireContract(promotion.includes("github.base_ref == 'main'"), "Promotion Gate must be limited to main pull requests");
requireContract(promotion.includes('HEAD_REF: ${{ github.head_ref }}'), "Promotion Gate must inspect the head branch");
requireContract(promotion.includes('develop | hotfix/*'), "Promotion Gate must admit develop and hotfix heads");
requireContract(
  /\*\)\s*\n\s*fail "Promotions to main must come from/.test(promotion),
  "Promotion Gate must refuse every head it does not name",
);
// The gate and the tagger read the same branch names. If one learns a lane
// the other does not, a promotion is either refused before it can be tagged
// or tagged from a head the gate never admitted, so every lane the tagger
// resolves must appear here.
// Match the case arm itself, not the failure message beneath it: the message
// names every lane too, so a looser check passes while the rule is gone.
const promotionHeadArm = (promotion.match(/^\s*develop \| hotfix\/\*.*$/m) ?? [""])[0];
requireContract(promotionHeadArm !== "", "Promotion Gate must admit heads in one case arm");
for (const lane of ["version-bump/", "relay-release/", "chart-release/", "push-chart-release/"]) {
  requireContract(autoTag.includes(`${lane}*)`), `auto-tag must resolve the '${lane}*' lane`);
  requireContract(
    promotionHeadArm.includes(`${lane}*`),
    `Promotion Gate must admit the '${lane}*' lane the tagger resolves`,
  );
}
requireContract(promotion.includes('true|false)'), "Promotion Gate must reject missing or malformed path relevance");
for (const output of ["RAW_RUST", "RAW_DESKTOP", "RAW_DESKTOP_RUST"]) {
  requireContract(promotion.includes(`${output}: \${{ needs.changes.outputs.raw-`), `Promotion Gate must receive '${output}' path relevance`);
}
requireContract(promotion.includes('require_optional "Rust Lint"'), "Promotion Gate must scope Rust Lint to the promotion diff");
requireContract(promotion.includes('require_optional "Unit Tests"'), "Promotion Gate must scope Unit Tests to the promotion diff");
requireContract(promotion.includes('require_optional "Desktop Core"'), "Promotion Gate must scope Desktop Core to the promotion diff");
requireContract(promotion.includes('require_optional "Desktop"'), "Promotion Gate must scope Desktop to the promotion diff");
requireContract(promotion.includes('require_optional "Relay Suites"'), "Promotion Gate must scope Relay Suites to the promotion diff");

for (const dependency of [
  "changes",
  "rust-lint",
  "unit-tests",
  "desktop-core",
  "desktop",
  "relay-suites",
  "desktop-e2e-integration",
  "security",
  "server-cross-compile",
  "web",
  "mobile",
  "blocks-live-gate",
]) {
  requireContract(new RegExp(`(^|[\\s,\\[])${dependency}([\\s,\\]]|$)`, "m").test(promotion), `Promotion Gate must depend on '${dependency}'`);
}
for (const result of [
  "needs.changes.result",
  "needs.rust-lint.result",
  "needs.unit-tests.result",
  "needs.desktop-core.result",
  "needs.desktop.result",
  "needs.relay-suites.result",
  "needs.desktop-e2e-integration.result",
  "needs.security.result",
  "needs.server-cross-compile.result",
  "needs.web.result",
  "needs.mobile.result",
  "needs.blocks-live-gate.result",
]) {
  requireContract(promotion.includes(result), `Promotion Gate must evaluate '${result}'`);
}

requireContract(autoTag.includes("checks: read"), "auto-tag must have check-run read permission");
requireContract(autoTag.includes("Verify Promotion Gate"), "auto-tag must verify the promotion gate before tagging");
requireContract(autoTag.includes("github.event.pull_request.head.sha"), "auto-tag must verify the reviewed promotion head SHA");
requireContract(autoTag.includes('select(.name == "Promotion Gate")'), "auto-tag must filter the exact Promotion Gate name");
// A commit can carry several Promotion Gate records: a promotion closed and
// reopened, or two PRs to main sharing one develop head. Requiring exactly one
// blocked relay-v0.11.12 and v0.17.5 with every gate green, so the contract now
// pins the two properties that actually matter rather than the record count.
requireContract(autoTag.includes('${#gate_conclusions[@]}" -eq 0'), "auto-tag must require at least one Promotion Gate result");
requireContract(autoTag.includes('for conclusion in "${gate_conclusions[@]}"'), "auto-tag must inspect every Promotion Gate result, not only the first");
requireContract(autoTag.includes('"$conclusion" != "success"'), "auto-tag must require Promotion Gate success");
requireContract(autoTag.indexOf("Verify Promotion Gate") < autoTag.indexOf("Resolve release lane and version"), "auto-tag must verify before resolving or creating release tags");

requireContract(fly.includes("Verify live relay readiness and version"), "Fly deploy must expose a distinct live-proof step");
requireContract(fly.includes("scripts/verify-relay-live.sh"), "Fly deploy must invoke the relay live canary");
requireContract(fly.indexOf("flyctl deploy") < fly.indexOf("scripts/verify-relay-live.sh"), "the live canary must run after flyctl deploy");
NODE

"$repo_root/scripts/test-verify-relay-live.sh"

if [[ ${RELEASE_PIPELINE_MUTATION_MODE:-0} == 1 ]]; then
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

expect_mutation_failure() {
  local label=$1 ci_mutation=$2 auto_tag_mutation=$3 fly_mutation=$4
  cp "$ci_workflow" "$tmp/ci.yml"
  cp "$auto_tag_workflow" "$tmp/auto-tag.yml"
  cp "$fly_workflow" "$tmp/fly.yml"
  eval "$ci_mutation"
  eval "$auto_tag_mutation"
  eval "$fly_mutation"
  if RELEASE_PIPELINE_MUTATION_MODE=1 \
    CI_WORKFLOW="$tmp/ci.yml" \
    AUTO_TAG_WORKFLOW="$tmp/auto-tag.yml" \
    FLY_WORKFLOW="$tmp/fly.yml" \
    "$repo_root/scripts/test-release-pipeline-contract.sh" >/dev/null 2>&1; then
    echo "release pipeline mutation was not detected: $label" >&2
    exit 1
  fi
}

noop=':'
expect_mutation_failure \
  "merge_group trigger restored" \
  "perl -0pi -e 's/^on:$/on:\\n  merge_group:/m' '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "promotion cancellation restored" \
  "sed -i.bak 's/cancel-in-progress:.*/cancel-in-progress: true/' '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "core push rerun restored" \
  "perl -0pi -e \"s/needs\\.changes\\.outputs\\.core-enabled == 'true'/github.event_name == 'push'/\" '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "promotion core forcing restored" \
  "perl -0pi -e \"s/steps\\.filter\\.outputs\\.rust/github.base_ref == 'main' || steps.filter.outputs.rust/\" '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "promotion head assertion removed" \
  "perl -0pi -e 's/^.*develop \\| hotfix\\/\\*.*\\n//m' '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "promotion head catch-all removed" \
  "perl -0pi -e 's/^.*fail \"Promotions to main must come from.*\\n//m' '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "non-promotion check renamed to the required context" \
  "perl -0pi -e 's/^    name: .*Promotion Gate.*$/    name: Promotion Gate/m' '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "promotion Rust relevance removed" \
  "sed -i.bak '/require_optional \"Rust Lint\"/d' '$tmp/ci.yml'" "$noop" "$noop"
expect_mutation_failure \
  "tag promotion verification removed" \
  "$noop" "sed -i.bak '/Verify Promotion Gate/d' '$tmp/auto-tag.yml'" "$noop"
expect_mutation_failure \
  "live canary invocation removed" \
  "$noop" "$noop" "sed -i.bak '/scripts\/verify-relay-live.sh/d' '$tmp/fly.yml'"

echo "release pipeline contract passed"
