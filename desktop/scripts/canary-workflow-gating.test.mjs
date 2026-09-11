import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL("../../.github/workflows/colony-desktop-canary.yml", import.meta.url),
  "utf8",
);

/** The `if:` expression of one job, block scalar or single line. */
function jobCondition(name) {
  const rest = workflow.split(`\n  ${name}:\n`)[1];
  assert.ok(rest, `job ${name} is missing`);
  // Stop at the next job, or a later job's condition is read as this one's.
  const job = rest.split(/\n {2}[a-z][\w-]*:\n/)[0];
  const block = job.match(/\n {4}if: \|\n((?: {6}.*\n)+)/);
  if (block) return block[1].replace(/\s+/g, " ").trim();
  const line = job.match(/\n {4}if: (.*)\n/);
  assert.ok(line, `job ${name} has no if: condition`);
  return line[1].trim();
}

/** Evaluate a GitHub expression over the inputs this workflow actually uses. */
function evaluate(expression, { shouldBuild, dryRun, parity }) {
  const javascript = expression
    .replaceAll("always()", "true")
    .replaceAll(
      "needs.decide.outputs.should_build",
      JSON.stringify(shouldBuild),
    )
    .replaceAll("needs.relay-parity.result", JSON.stringify(parity))
    .replaceAll("inputs.dry_run", JSON.stringify(dryRun))
    .replaceAll(" == ", " === ")
    .replaceAll("'", '"');
  return new Function(`return (${javascript});`)();
}

test("relay parity is mandatory for a real canary and skipped for a dry run", () => {
  const parityJob = jobCondition("relay-parity");
  const publishJob = jobCondition("publish-canary-macos");

  // A real run: the gate runs, and publishing waits for it to pass.
  const real = { shouldBuild: "true", dryRun: false };
  assert.equal(evaluate(parityJob, { ...real, parity: "" }), true);
  assert.equal(evaluate(publishJob, { ...real, parity: "success" }), true);
  for (const parity of ["failure", "skipped", "cancelled"])
    assert.equal(evaluate(publishJob, { ...real, parity }), false);

  // A dry run publishes nothing, so the gate is skipped and cannot block it.
  const dry = { shouldBuild: "true", dryRun: true };
  assert.equal(evaluate(parityJob, { ...dry, parity: "" }), false);
  assert.equal(evaluate(publishJob, { ...dry, parity: "skipped" }), true);

  // An unchanged tree still builds nothing, dry run or not.
  for (const dryRun of [true, false])
    assert.equal(
      evaluate(publishJob, {
        shouldBuild: "false",
        dryRun,
        parity: "success",
      }),
      false,
    );
});

test("only a real run writes to colony-releases", () => {
  const publishing = [
    "Create release publisher token",
    "Publish the canary build",
    "Publish the canary update manifest",
    "Verify the canary update manifest",
    "Verify the canary download",
    "Record the built sha on the rolling release",
  ];
  for (const step of publishing) {
    const body = workflow.split(`- name: ${step}\n`)[1];
    assert.ok(body, `step ${step} is missing`);
    assert.match(
      body.split("\n")[0],
      /if: \$\{\{ !inputs\.dry_run \}\}/,
      `step ${step} must not run during a dry run`,
    );
  }
  for (const step of [
    "Stage the dry run artifacts",
    "Upload the dry run artifacts",
  ]) {
    const body = workflow.split(`- name: ${step}\n`)[1];
    assert.ok(body, `step ${step} is missing`);
    assert.match(body.split("\n")[0], /if: inputs\.dry_run/);
  }
});
