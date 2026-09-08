// Per-run public test CA. Private material never leaves this process or survives
// certificate generation on disk; this module is not imported by the app.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function createFixtureCertificates(directory, hosts) {
  const temporary = await mkdtemp(path.join(directory, "fixture-tls-"));
  const run = async (...args) => {
    try {
      await exec("openssl", args, { cwd: temporary, timeout: 30_000 });
    } catch {
      throw new Error(
        "Could not generate the process-private fixture certificate",
      );
    }
  };
  try {
    await writeFile(
      path.join(temporary, "ca.cnf"),
      "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Colony onboarding fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n",
      { mode: 0o600 },
    );
    await writeFile(
      path.join(temporary, "leaf.cnf"),
      `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=${hosts[0]}\n[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`,
      { mode: 0o600 },
    );
    await run(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-config",
      "ca.cnf",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    );
    await run(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-config",
      "leaf.cnf",
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
    );
    await run(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "2",
      "-sha256",
      "-extfile",
      "leaf.cnf",
      "-extensions",
      "leaf",
      "-out",
      "leaf.pem",
    );
    const [key, cert, ca] = await Promise.all(
      ["leaf.key", "leaf.pem", "ca.pem"].map((name) =>
        readFile(path.join(temporary, name)),
      ),
    );
    const leaf = new X509Certificate(cert);
    const issuer = new X509Certificate(ca);
    assert.ok(issuer.ca && issuer.verify(issuer.publicKey));
    assert.ok(!leaf.ca && leaf.verify(issuer.publicKey));
    assert.ok(
      Date.now() >= Date.parse(leaf.validFrom) &&
        Date.now() < Date.parse(leaf.validTo),
    );
    assert.equal(
      leaf.subjectAltName,
      hosts.map((host) => `DNS:${host}`).join(", "),
    );
    for (const host of hosts) assert.equal(leaf.checkHost(host), host);
    return {
      key,
      cert,
      ca,
      caDerBase64: issuer.raw.toString("base64"),
      leafSpki: createHash("sha256")
        .update(leaf.publicKey.export({ type: "spki", format: "der" }))
        .digest("base64"),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
