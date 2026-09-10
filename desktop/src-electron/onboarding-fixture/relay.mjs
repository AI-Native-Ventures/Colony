// Real relay + fresh isolated backing services. No seeded business, account or task.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startNativeBackingServices } from "./native-services.mjs";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../..", import.meta.url));

async function port() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const result = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return result;
}

async function until(label, check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}

/** Start only a new project owned by this unique fixture; caller must await close. */
export async function startOnboardingFixtureRelay({
  profile,
  domain,
  directory,
  relayBinary,
  adminBinary,
  providerHttpUrl,
}) {
  assert.match(profile, /^[a-f0-9]{16}$/);
  assert.equal(domain, `onboarding-${profile}.invalid`);
  for (const binary of [relayBinary, adminBinary])
    assert.ok(path.isAbsolute(binary));
  const provider = new URL(providerHttpUrl);
  assert.equal(provider.protocol, "http:");
  assert.equal(provider.hostname, "127.0.0.1");
  assert.ok(provider.port);
  const project = `colony-onboarding-${profile}`;
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    TMPDIR: directory,
    BUZZ_HARNESS_OWNER: directory,
    BUZZ_HARNESS_PG_PORT: "127.0.0.1:0",
    BUZZ_HARNESS_REDIS_PORT: "127.0.0.1:0",
    BUZZ_HARNESS_MINIO_PORT: "127.0.0.1:0",
    BUZZ_HARNESS_MINIO_CONSOLE_PORT: "127.0.0.1:0",
  };
  // Docker CLI needs its configured socket/context, not the app's isolated HOME.
  const dockerEnv = {
    ...env,
    HOME: process.env.HOME,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  };
  const composeArgs = [
    "compose",
    "-p",
    project,
    "-f",
    path.join(repo, "docker-compose.harness.yml"),
  ];
  const compose = async (...args) =>
    (
      await exec("docker", [...composeArgs, ...args], {
        cwd: directory,
        env: dockerEnv,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  const nativeTools = process.env.COLONY_FIXTURE_TOOLS;
  let nativeServices;
  if (!nativeTools)
    assert.equal(
      await compose("ps", "--all", "--quiet"),
      "",
      "Never reuse another fixture project",
    );
  let started = false;
  let child;
  let log;
  let exit;
  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const killed = await Promise.race([
        exit.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (!killed) {
        child.kill("SIGKILL");
        await exit;
      }
    }
    if (log) await new Promise((resolve) => log.end(resolve));
    if (nativeServices) {
      await nativeServices.close();
      nativeServices = undefined;
    }
    if (started) {
      await compose("down", "--volumes", "--remove-orphans");
      started = false;
    }
  }
  try {
    if (nativeTools) {
      nativeServices = await startNativeBackingServices({
        directory,
        tools: nativeTools,
      });
    } else {
      started = true;
      // The bucket initializer is a successful one-shot, not a service that
      // should remain running for Compose's --wait health gate.
      await compose("up", "--detach", "--wait", "postgres", "redis", "minio");
      await compose("run", "--rm", "--no-deps", "minio-init");
    }
    const mapped = async (service, internal) => {
      if (nativeServices)
        return nativeServices[
          { postgres: "pg", redis: "redis", minio: "minio" }[service]
        ];
      const mapping = await compose("port", service, String(internal));
      assert.match(mapping, /^127\.0\.0\.1:\d+$/);
      return mapping;
    };
    const [pg, redis, minio, mainPort, healthPort, metricsPort] =
      await Promise.all([
        mapped("postgres", 5432),
        mapped("redis", 6379),
        mapped("minio", 9000),
        port(),
        port(),
        port(),
      ]);
    const relayEnv = {
      ...env,
      DATABASE_URL: `postgres://buzz:buzz_dev@${pg}/buzz`,
      REDIS_URL: `redis://${redis}`,
      RELAY_URL: `wss://bootstrap.${domain}`,
      BUZZ_BIND_ADDR: `127.0.0.1:${mainPort}`,
      BUZZ_HEALTH_PORT: String(healthPort),
      BUZZ_METRICS_PORT: String(metricsPort),
      BUZZ_S3_ENDPOINT: `http://${minio}`,
      BUZZ_S3_ACCESS_KEY: "buzz_dev",
      BUZZ_S3_SECRET_KEY: "buzz_dev_secret",
      BUZZ_S3_BUCKET: "buzz-media",
      BUZZ_RELAY_PRIVATE_KEY: `${"0".repeat(63)}2`,
      BUZZ_REQUIRE_AUTH_TOKEN: "true",
      // Match the hosted membership/owner-delegation posture. The real account
      // provisioning and NIP-OA enrollment paths establish this authority.
      BUZZ_REQUIRE_RELAY_MEMBERSHIP: "true",
      BUZZ_ALLOW_NIP_OA_AUTH: "true",
      // A distinct synthetic deployment operator bootstraps only the bootstrap
      // tenant. Customer ownership must still come from real provisioning.
      RELAY_OWNER_PUBKEY:
        "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
      BUZZ_SELF_PROVISION_DOMAIN: domain,
      BUZZ_SELF_PROVISION_PUBLIC: "true",
      VERCEL_AI_GATEWAY_KEY: "synthetic-onboarding-provider",
      VERCEL_AI_GATEWAY_BASE_URL: providerHttpUrl,
    };
    await exec(adminBinary, ["migrate"], {
      cwd: directory,
      env: relayEnv,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const query = (sql) =>
      nativeServices
        ? nativeServices.query(sql)
        : compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "buzz",
            "-d",
            "buzz",
            "-v",
            "ON_ERROR_STOP=1",
            "-tAc",
            sql,
          );
    // Deployment bootstrap is the only tenant seeded. Signup and signed business
    // provisioning create their own records through the actual application.
    await query(
      `INSERT INTO communities (host) VALUES ('bootstrap.${domain}');`,
    );
    const logPath = path.join(directory, "relay.log");
    log = createWriteStream(logPath);
    child = spawn(relayBinary, [], {
      cwd: directory,
      env: relayEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    exit = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const upstreamHttpUrl = `http://127.0.0.1:${mainPort}`;
    await until("isolated relay accepts bootstrap requests", async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Fixture relay exited; inspect ${logPath}`);
      try {
        const response = await fetch(upstreamHttpUrl, {
          headers: {
            Host: `bootstrap.${domain}`,
            Accept: "application/nostr+json",
          },
          signal: AbortSignal.timeout(1000),
          redirect: "error",
        });
        return response.ok;
      } catch {
        return false;
      }
    });
    return {
      project,
      backingServices: nativeServices?.evidence ?? {
        transport: "Docker Compose",
      },
      upstreamHttpUrl,
      query,
      close,
      logPath,
      // Real admin ledger credit in this isolated database, not a payment proof.
      async seedCredits(pubkey) {
        assert.match(pubkey, /^[a-f0-9]{64}$/);
        await exec(
          adminBinary,
          [
            "credits",
            "seed",
            "--pubkey",
            pubkey,
            "--usd",
            "5",
            "--ref",
            `onboarding-fixture-${profile}`,
          ],
          {
            cwd: directory,
            env: relayEnv,
            timeout: 30_000,
          },
        );
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Fixture startup and cleanup failed",
      );
    }
    // Keep bounded startup diagnostics after the caller removes its private
    // profile. Project only diagnostic messages, never log fields or headers.
    error.startupDiagnostics = (
      await readFile(path.join(directory, "relay.log"), "utf8").catch(() => "")
    )
      .split("\n")
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.level === "ERROR" && typeof entry.message === "string"
            ? [
                entry.message
                  .replace(/[a-f0-9]{64}/gi, "[redacted-key]")
                  .replace(/\b[a-z]+:\/\/\S+/gi, "[redacted-url]"),
              ]
            : [];
        } catch {
          return [];
        }
      })
      .slice(-10);
    throw error;
  }
}
