// Run by blockValidationNoEval.test.mjs in a child process started with
// --disallow-code-generation-from-strings, which makes `new Function` throw
// exactly as the packaged desktop CSP does. Prints one JSON line describing
// what it managed to validate; exits non-zero if anything failed.
import { readdir, readFile } from "node:fs/promises";

import {
  validateBlockActionData,
  validateBlockData,
  validateBlockManifest,
} from "./blockValidation.ts";

const CORE_COMPOSITES = new URL(
  "../../../../crates/buzz-relay/src/core_blocks/composites/",
  import.meta.url,
);

const ACTION_PAYLOAD = {
  requestId: "018f47a0-5db0-7ab1-8c6a-73d5ac1a69b1",
  definition: {
    displayName: "Researcher",
    systemPrompt: "Answer questions with sources.",
  },
  runOn: { type: "local" },
};

function codeGenerationAllowed() {
  try {
    new Function("");
    return true;
  } catch {
    return false;
  }
}

const failures = [];
const manifests = [];
let examples = 0;

const files = (await readdir(CORE_COMPOSITES)).filter((name) =>
  name.endsWith(".json"),
);
for (const file of files) {
  const raw = JSON.parse(
    await readFile(new URL(file, CORE_COMPOSITES), "utf8"),
  );
  const manifest = validateBlockManifest(raw);
  if (!manifest.ok) {
    failures.push(`${file}: ${manifest.message}`);
    continue;
  }
  manifests.push(manifest.value.handle);
  for (const example of manifest.value.examples) {
    const data = validateBlockData(manifest.value, example.data);
    if (data.ok) {
      examples += 1;
    } else {
      failures.push(`${file} example ${example.name}: ${data.message}`);
    }
  }
}

// Action payloads take a separate path through the validator, so exercise one
// signed action end to end, accepted and rejected.
const proposal = validateBlockManifest(
  JSON.parse(
    await readFile(new URL("agent-proposal.json", CORE_COMPOSITES), "utf8"),
  ),
);
if (proposal.ok) {
  const accepted = validateBlockActionData(
    proposal.value,
    "agent.create",
    ACTION_PAYLOAD,
  );
  if (!accepted.ok) {
    failures.push(`agent.create payload rejected: ${accepted.message}`);
  }
  const rejected = validateBlockActionData(proposal.value, "agent.create", {
    ...ACTION_PAYLOAD,
    requestId: "not-a-uuid",
  });
  if (rejected.ok) {
    failures.push("agent.create accepted a requestId that is not a UUID");
  }
}

process.stdout.write(
  `${JSON.stringify({
    codeGenerationAllowed: codeGenerationAllowed(),
    manifests,
    examples,
    failures,
  })}\n`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
