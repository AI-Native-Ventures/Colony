import { requestBroker } from "./browser/broker.mjs";
// Synthetic Firefox store -> real Electron cookie store -> authenticated fixture page.
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export async function verifyImport(application, page) {
  const profilePath = await realpath(
    await mkdtemp(path.join(tmpdir(), "colony-import-proof-")),
  );
  const db = new DatabaseSync(path.join(profilePath, "cookies.sqlite"));
  db.exec(
    "CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)",
  );
  db.prepare("INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)").run(
    "127.0.0.1",
    "colony_fixture",
    "test-only",
    "/",
    2000000000,
    0,
    1,
    1,
    "",
  );
  db.close();
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.headers.cookie?.includes("colony_fixture=test-only")
        ? '<h1>Fixture signed in</h1><label>Fixture text<input aria-label="Fixture text"></label>'
        : "<h1>Fixture signed out</h1>",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const packagedRoot = await application.evaluate(({ app }) =>
      app.isPackaged ? app.getAppPath() : null,
    );
    const result = await application.evaluate(
      async ({ session }, { profilePath, modulePath }) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(modulePath);
        const { SignInImport } = require(modulePath);
        const { createHash } = require("node:crypto");
        const partition =
          "persist:colony-business-" +
          createHash("sha256").update("import-proof").digest("hex");
        const destination = session.fromPartition(partition);
        await destination.cookies.set({
          url: "http://127.0.0.1/",
          name: "colony_fixture",
          value: "old-session",
          path: "/",
          httpOnly: true,
        });
        const manager = new SignInImport(
          {
            sessionFor(id) {
              if (id !== "import-proof") throw Error("wrong business");
              return destination;
            },
          },
          {
            discover: async () => ({
              profiles: [
                {
                  id: "fixture",
                  family: "firefox",
                  browserId: "firefox",
                  profilePath,
                },
              ],
              issues: [],
            }),
          },
        );
        await manager.discoverProfiles();
        await manager.list({ profileId: "fixture" });
        const result = await manager.import({
          business: "import-proof",
          profileId: "fixture",
          hosts: ["127.0.0.1"],
          confirmed: true,
          replaceExisting: true,
        });
        const isolated = await session
          .fromPartition("persist:import-proof-unrelated")
          .cookies.get({ name: "colony_fixture" });
        return { result, otherBusinessCookies: isolated.length };
      },
      {
        profilePath,
        modulePath: packagedRoot
          ? path.join(packagedRoot, "src-electron/browser-import/manager.mjs")
          : fileURLToPath(
              new URL("./browser-import/manager.mjs", import.meta.url),
            ),
      },
    );
    assert.equal(result.result.imported, 1);
    assert.equal(result.otherBusinessCookies, 0);
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.evaluate(async (url) => {
      await window.colonyDesktop.request("business", { id: "import-proof" });
      await window.colonyDesktop.request("browser:open", {
        business: "import-proof",
        id: "import-proof-tab",
        url,
      });
    }, url);
    let authenticated = false;
    for (let i = 0; i < 30; i++) {
      authenticated = await application.evaluate(
        async ({ webContents }, url) => {
          const tab = webContents
            .getAllWebContents()
            .find((w) => w.getURL() === url);
          return tab
            ? tab.executeJavaScript(
                'document.body.innerText.includes("Fixture signed in")',
              )
            : false;
        },
        url,
      );
      if (authenticated) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(authenticated, true);
    const shared = await page.evaluate(() =>
      window.colonyDesktop.request("browser:grant", {
        id: "import-proof-tab",
        worker: "Fixture worker",
        mode: "interact",
      }),
    );
    const grant = JSON.parse(await readFile(shared.grantPath, "utf8"));
    const call = (method, args) =>
      requestBroker(grant.socketPath, { token: grant.token, method, args });
    const snapshot = await call("browser_snapshot", {
      tabId: "import-proof-tab",
    });
    const line = snapshot.outline
      .split("\n")
      .find((value) => value.includes("textbox Fixture text"));
    assert.ok(line, "fixture textbox must have an observed reference");
    await call("browser_type", {
      tabId: "import-proof-tab",
      ref: line.split(" ")[0],
      text: "ready",
    });
    const value = await application.evaluate(async ({ webContents }, url) => {
      const tab = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === url);
      return tab.executeJavaScript('document.querySelector("input").value');
    }, url);
    assert.equal(value, "ready");
    await page.evaluate(() =>
      window.colonyDesktop.request("browser:action", {
        id: "import-proof-tab",
        action: "takeover",
      }),
    );
    await assert.rejects(
      call("browser_snapshot", { tabId: "import-proof-tab" }),
      /revoked/,
    );
    console.log("Scoped worker read/type and owner takeover: PASS");
    console.log(
      "Synthetic store import -> authenticated page; cross-business isolation: PASS",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(profilePath, { recursive: true, force: true });
  }
}
