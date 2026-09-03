import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  MORE_NAV_VIEWS,
  PRIMARY_NAV_VIEWS,
  isMoreNavView,
  readMoreNavOpen,
  rememberMoreNavOpened,
  resetSidebarMoreNav,
  shouldGroupMoreNav,
} from "./sidebarMoreNav.ts";

const FOUNDER = "f".repeat(64);
const OTHER = "0".repeat(64);

function installStorage() {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, String(value));
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
  };
  return store;
}

beforeEach(() => {
  installStorage();
  resetSidebarMoreNav();
});

test("the two lists together are the whole sidebar, with nothing in both", () => {
  const overlap = MORE_NAV_VIEWS.filter((view) =>
    PRIMARY_NAV_VIEWS.includes(view),
  );
  assert.deepEqual(overlap, []);
  assert.equal(MORE_NAV_VIEWS.length + PRIMARY_NAV_VIEWS.length, 10);
  assert.equal(isMoreNavView("discovery"), true);
  assert.equal(isMoreNavView("agents"), false);
});

test("only a founder who signed up on this machine gets the group", () => {
  assert.equal(
    shouldGroupMoreNav({ isFreshFounderIdentity: true, pubkey: FOUNDER }),
    true,
  );
  // An imported identity, or anyone whose first run happened elsewhere.
  assert.equal(
    shouldGroupMoreNav({ isFreshFounderIdentity: false, pubkey: FOUNDER }),
    false,
  );
  assert.equal(
    shouldGroupMoreNav({ isFreshFounderIdentity: true, pubkey: null }),
    false,
  );
});

test("the group starts collapsed and stays open once opened", () => {
  assert.equal(readMoreNavOpen(FOUNDER), false);
  rememberMoreNavOpened(FOUNDER);
  assert.equal(readMoreNavOpen(FOUNDER), true);
  // Survives a reload: the cache is dropped, the answer is not.
  resetSidebarMoreNav();
  assert.equal(readMoreNavOpen(FOUNDER), true);
  // And the group is still a group, so it is still there to be open.
  assert.equal(
    shouldGroupMoreNav({ isFreshFounderIdentity: true, pubkey: FOUNDER }),
    true,
  );
});

test("one identity's answer is not another's", () => {
  rememberMoreNavOpened(FOUNDER);
  assert.equal(readMoreNavOpen(OTHER), false);
  assert.equal(readMoreNavOpen(null), false);
});

test("the reset drops the cache without touching what was stored", () => {
  const store = installStorage();
  resetSidebarMoreNav();
  rememberMoreNavOpened(FOUNDER);

  // A different community's storage, read through a stale cache, would
  // otherwise answer for this one. Empty the backing store and the cached
  // "true" must not survive the reset.
  store.clear();
  assert.equal(readMoreNavOpen(FOUNDER), true, "cached before reset");
  resetSidebarMoreNav();
  assert.equal(readMoreNavOpen(FOUNDER), false, "re-read after reset");
});
