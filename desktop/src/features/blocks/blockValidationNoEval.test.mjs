import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const DESKTOP_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("./blockValidationNoEval.fixture.mjs", import.meta.url),
);

/**
 * The packaged desktop ships a CSP without `'unsafe-eval'`
 * (desktop/src-tauri/tauri.conf.json, pinned by src-tauri/tests/csp.rs), so a
 * schema validator that generates code and hands it to `new Function` throws
 * at runtime and every Block carrying an input_schema renders an error instead
 * of its form. Manifests arrive from the relay, so their schemas cannot be
 * precompiled either: the validator has to interpret them.
 *
 * Node's --disallow-code-generation-from-strings makes `new Function` throw the
 * same way, which is why this runs in a child process rather than in the test
 * process itself.
 */
test("core Blocks validate with code generation disabled", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--disallow-code-generation-from-strings",
      "--import",
      "./test-loader.mjs",
      "--experimental-strip-types",
      FIXTURE,
    ],
    { cwd: DESKTOP_ROOT },
  );

  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(
    report.codeGenerationAllowed,
    false,
    "the child process must actually have code generation disabled",
  );
  assert.deepEqual(report.failures, []);
  assert.ok(
    report.manifests.includes("agent-proposal"),
    "agent-proposal is the Block that regressed, so it must be covered",
  );
  assert.ok(
    report.manifests.length > 1,
    "every core composite must be covered",
  );
  assert.ok(report.examples > 0, "manifest examples must be validated too");
});
