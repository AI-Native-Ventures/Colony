// Actual service processes, private to one hosted proof. No S3 response stubs.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();

/** Reserve no global names or ports; every child gets an owned process group. */
export async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

/** Create a real private MinIO bucket using an ordinary AWS Signature V4 request. */
export function bucketRequest(endpoint, now = new Date()) {
  const url = new URL("/buzz-media", endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const payload = sha("");
  const names = "host;x-amz-content-sha256;x-amz-date";
  const headers = `host:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`;
  const request = ["PUT", url.pathname, "", headers, names, payload].join("\n");
  const scope = `${day}/us-east-1/s3/aws4_request`;
  let key = hmac("AWS4buzz_dev_secret", day);
  for (const part of ["us-east-1", "s3", "aws4_request"]) key = hmac(key, part);
  const signature = hmac(
    key,
    `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(request)}`,
  ).toString("hex");
  return {
    url: url.href,
    headers: {
      "x-amz-date": date,
      "x-amz-content-sha256": payload,
      Authorization: `AWS4-HMAC-SHA256 Credential=buzz_dev/${scope}, SignedHeaders=${names}, Signature=${signature}`,
    },
  };
}

/** Launch pinned binaries against empty runner-local data and return owned cleanup. */
export async function startNativeBackingServices({ directory, tools }) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "darwin");
  assert.ok(path.isAbsolute(tools));
  assert.equal(await realpath(tools), tools, "Tools must be a canonical path");
  const sources = JSON.parse(
    await readFile(new URL("service-sources.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(tools, "service-sources.json"), "utf8"),
    ),
    sources,
  );
  const root = path.join(directory, "services");
  await mkdir(root, { recursive: false });
  const [pgPort, redisPort, minioPort, consolePort] = await Promise.all(
    Array.from({ length: 4 }, availablePort),
  );
  assert.equal(
    new Set([pgPort, redisPort, minioPort, consolePort]).size,
    4,
    "Every backing service needs a distinct private port",
  );
  const evidence = {
    sources,
    binaryHashes: [],
    bucketCreated: false,
    cleanup: "pending",
  };
  const pgBin = (name) => path.join(tools, "postgres/bin", name);
  const bin = (name) => path.join(tools, "bin", name);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    LANG: "en_US.UTF-8",
    PGPASSWORD: "buzz_dev",
  };
  const children = [];
  const binaryHashes = evidence.binaryHashes;
  async function start(name, binary, args, extra = {}) {
    binaryHashes.push({ name, sha256: sha(await readFile(binary)) });
    const log = createWriteStream(path.join(root, `${name}.log`));
    const child = spawn(binary, args, {
      cwd: root,
      env: { ...env, ...extra },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure;
    const done = new Promise((resolve) => {
      child.once("error", (error) => {
        failure = error;
        resolve();
      });
      child.once("exit", resolve);
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    children.push({ name, child, done, log, error: () => failure });
  }
  function healthy() {
    for (const { name, child, error } of children) {
      if (error() || child.exitCode !== null || child.signalCode !== null)
        throw new Error(`${name} exited before fixture completion`);
    }
  }
  async function until(label, read) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      healthy();
      if (await read().catch(() => false)) return;
      await delay(200);
    }
    throw new Error(`Timed out starting ${label}`);
  }
  const query = async (sql, database = "buzz") =>
    (
      await exec(
        pgBin("psql"),
        [
          "-h",
          "127.0.0.1",
          "-p",
          String(pgPort),
          "-U",
          "buzz",
          "-d",
          database,
          "-v",
          "ON_ERROR_STOP=1",
          "-tAc",
          sql,
        ],
        { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout.trim();
  async function close() {
    const errors = [];
    try {
      healthy();
    } catch (error) {
      errors.push(error);
    }
    const receipts = [];
    for (const { child, done, log, name } of [...children].reverse()) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") errors.push(error);
        }
        const exited = await Promise.race([
          done.then(() => true),
          delay(10_000).then(() => false),
        ]);
        if (!exited) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") errors.push(error);
          }
          await done;
          errors.push(new Error(`${name} required forced cleanup`));
        }
      }
      await new Promise((resolve) => log.end(resolve));
      receipts.push({
        name,
        exited: child.exitCode !== null || child.signalCode !== null,
        code: child.exitCode,
        signal: child.signalCode,
      });
    }
    evidence.cleanup = {
      complete:
        errors.length === 0 && receipts.every((receipt) => receipt.exited),
      services: receipts,
    };
    if (errors.length)
      throw new AggregateError(errors, "Native service cleanup failed");
  }
  try {
    const password = path.join(root, "pg-password");
    await writeFile(password, "buzz_dev\n", { mode: 0o600, flag: "wx" });
    const cluster = path.join(root, "postgres");
    await exec(
      pgBin("initdb"),
      [
        "-D",
        cluster,
        "-U",
        "buzz",
        "--auth-local=trust",
        "--auth-host=scram-sha-256",
        `--pwfile=${password}`,
        "--no-locale",
        "-E",
        "UTF8",
      ],
      { env, timeout: 60_000 },
    );
    await start("postgres", pgBin("postgres"), [
      "-D",
      cluster,
      "-h",
      "127.0.0.1",
      "-p",
      String(pgPort),
      "-k",
      "",
    ]);
    await until(
      "Postgres",
      async () => (await query("SELECT 1", "postgres")) === "1",
    );
    await query("CREATE DATABASE buzz", "postgres");
    await start("redis", bin("redis-server"), [
      "--bind",
      "127.0.0.1",
      "--port",
      String(redisPort),
      "--save",
      "",
      "--appendonly",
      "no",
    ]);
    await until(
      "Redis",
      async () =>
        (
          await exec(
            bin("redis-cli"),
            ["-h", "127.0.0.1", "-p", String(redisPort), "ping"],
            { env, timeout: 2000 },
          )
        ).stdout.trim() === "PONG",
    );
    const minio = `127.0.0.1:${minioPort}`;
    await start(
      "minio",
      bin("minio"),
      [
        "server",
        path.join(root, "objects"),
        "--address",
        minio,
        "--console-address",
        `127.0.0.1:${consolePort}`,
        "--quiet",
      ],
      {
        MINIO_ROOT_USER: "buzz_dev",
        MINIO_ROOT_PASSWORD: "buzz_dev_secret",
        MINIO_BROWSER: "off",
        MINIO_UPDATE: "off",
      },
    );
    await until(
      "MinIO",
      async () =>
        (
          await fetch(`http://${minio}/minio/health/live`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok,
    );
    const request = bucketRequest(`http://${minio}`);
    const response = await fetch(request.url, {
      method: "PUT",
      headers: request.headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(
      response.status,
      200,
      "The real MinIO bucket must be created successfully",
    );
    evidence.bucketCreated = true;
    return {
      pg: `127.0.0.1:${pgPort}`,
      redis: `127.0.0.1:${redisPort}`,
      minio,
      query,
      close,
      healthy,
      evidence,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Service startup and cleanup failed",
      );
    }
    throw error;
  }
}
