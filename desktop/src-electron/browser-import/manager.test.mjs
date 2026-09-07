import test from "node:test";
import assert from "node:assert/strict";
import { SignInImport } from "./manager.mjs";
const cookie = {
  url: "https://example.com/",
  domain: ".example.com",
  name: "session",
  value: "synthetic-only",
  path: "/",
  secure: true,
};
async function fixture(read = async () => ({ cookies: [cookie], skipped: 0 })) {
  let business = "one";
  const saved = [];
  const destination = {
    cookies: {
      get: async () => saved,
      set: async (value) => {
        const index = saved.findIndex(
          (item) =>
            item.name === value.name &&
            item.domain === value.domain &&
            item.path === value.path,
        );
        if (index < 0) saved.push({ ...value });
        else saved[index] = { ...value };
      },
      flushStore: async () => {},
    },
  };
  const manager = new SignInImport(
    {
      sessionFor(id) {
        if (id !== business) throw Error("changed");
        return destination;
      },
    },
    {
      discover: async () => ({
        profiles: [
          {
            id: "p",
            family: "firefox",
            profilePath: "/fixture",
            browserId: "firefox",
          },
        ],
        issues: [],
      }),
      sites: async () => [".example.com"],
      read,
    },
  );
  await manager.discoverProfiles();
  await manager.list({ profileId: "p" });
  return {
    manager,
    saved,
    switchBusiness: () => {
      business = "two";
    },
  };
}
const request = {
  business: "one",
  profileId: "p",
  hosts: [".example.com"],
  confirmed: true,
};
test("confirmation and known-site selection are mandatory", async () => {
  const { manager, saved } = await fixture();
  await assert.rejects(
    manager.import({ ...request, confirmed: false }),
    /confirm/,
  );
  await assert.rejects(
    manager.import({ ...request, hosts: ["unselected.com"] }),
    /Choose/,
  );
  assert.equal(saved.length, 0);
});
test("existing sessions survive re-import and no values leave the service", async () => {
  const { manager, saved } = await fixture();
  const result = await manager.import(request);
  assert.equal(result.imported, 1);
  assert.equal(result.status, "needs-verification");
  assert.equal(JSON.stringify(result).includes(cookie.value), false);
  assert.equal((await manager.import(request)).preserved, 1);
  assert.equal(saved.length, 1);
});
test("business switch during credential access cancels before writes", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { manager, saved, switchBusiness } = await fixture(() => pending);
  const importing = manager.import(request);
  switchBusiness();
  release({ cookies: [cookie], skipped: 0 });
  assert.equal((await importing).status, "interrupted");
  assert.equal(saved.length, 0);
});
test("simultaneous imports cannot race existing-session checks", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { manager } = await fixture(() => pending);
  const importing = manager.import(request);
  await assert.rejects(manager.import(request), /already running/);
  release({ cookies: [], skipped: 0 });
  await importing;
});

test("only explicit replacement refreshes an existing session", async () => {
  const { manager, saved } = await fixture();
  saved.push({ ...cookie, value: "old-session" });
  assert.equal((await manager.import(request)).preserved, 1);
  assert.equal(saved[0].value, "old-session");
  assert.equal(
    (await manager.import({ ...request, replaceExisting: true })).imported,
    1,
  );
  assert.equal(saved[0].value, cookie.value);
  await assert.rejects(
    manager.import({ ...request, replaceExisting: "yes" }),
    /Invalid replacement/,
  );
});
