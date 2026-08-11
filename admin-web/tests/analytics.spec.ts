import { expect, test, type Page } from "@playwright/test";

const sharedPubkey = "11".repeat(32);
const communityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function envelope<T>(
  data: T,
  options: { stale?: boolean; liveUnavailable?: boolean } = {},
) {
  return {
    data,
    as_of: "2026-08-09T12:00:00Z",
    freshness: {
      historical: {
        status: options.stale ? "stale" : "fresh",
        watermark: options.stale
          ? "2026-08-09T11:00:00Z"
          : "2026-08-09T11:59:00Z",
        lag_seconds: options.stale ? 3600 : 0,
      },
      live: {
        status: options.liveUnavailable ? "unavailable" : "fresh",
        observed_at: options.liveUnavailable ? null : "2026-08-09T12:00:00Z",
        message: options.liveUnavailable
          ? "shared live lease source unavailable"
          : null,
      },
    },
    definitions_version: "v1",
    warnings: options.liveUnavailable
      ? ["Live session source unavailable"]
      : [],
  };
}

const overviewData = {
  metrics: {
    unique_people: 12,
    memberships: 18,
    first_seen_people: 12,
    new_memberships: 3,
    online_people: 4,
    authenticated_sessions: 6,
    open_connections: 7,
    dau: 8,
    wau: 10,
    mau: 12,
    activity_volume: 240,
    active_channels: 5,
    threads: 19,
  },
  trend: [
    { utc_day: "2026-08-08", unique_people: 8, activity_volume: 120 },
    { utc_day: "2026-08-09", unique_people: 5, activity_volume: 90 },
  ],
  communities: [
    {
      id: communityId,
      name: "Design",
      host: "design.colony.test",
      status: "active",
      unique_people: 7,
      memberships: 9,
      channels: 3,
      threads: 11,
      online_people: 2,
      authenticated_sessions: 3,
      open_connections: 4,
      dau: 5,
      wau: 6,
      mau: 7,
      activity_volume: 150,
      last_activity_at: "2026-08-09T11:58:00Z",
    },
  ],
};

const communityData = {
  items: overviewData.communities,
  next_cursor: null,
};

const sharedPerson = {
  pubkey: sharedPubkey,
  display_name: "Ada",
  nip05: "ada@colony.test",
  person_type: "human",
  community_count: 2,
  membership_count: 2,
  channel_count: 4,
  owned_agent_count: 1,
  first_seen: "2026-07-01T12:00:00Z",
  last_activity_at: "2026-08-09T11:55:00Z",
  online: true,
  session_count: 2,
  deactivated: false,
};

const peopleData = { items: [sharedPerson], next_cursor: null, total: 1 };

const personDetail = {
  ...sharedPerson,
  memberships: [
    {
      community_id: communityId,
      community_host: "design.colony.test",
      community_name: "Design",
      role: "member",
      status: "active",
      channel_count: 4,
      thread_count: 8,
      joined_at: "2026-07-02T12:00:00Z",
    },
  ],
  activity: {
    dau: 1,
    wau: 4,
    mau: 8,
    event_count: 32,
    families: [{ family: "message", event_count: 30, unique_days: 6 }],
  },
  sessions: [
    {
      session_id: "session-one",
      pubkey: sharedPubkey,
      community_id: communityId,
      community_host: "design.colony.test",
      started_at: "2026-08-09T10:00:00Z",
      last_seen_at: "2026-08-09T11:59:30Z",
      pod: "relay-a",
      network: "203.0.113.0/24",
    },
    {
      session_id: "session-two",
      pubkey: sharedPubkey,
      community_id: communityId,
      community_host: "design.colony.test",
      started_at: "2026-08-09T11:00:00Z",
      last_seen_at: "2026-08-09T11:59:20Z",
      pod: "relay-b",
      network: "203.0.113.0/24",
    },
  ],
};

const sessionData = {
  online_people: 1,
  authenticated_sessions: 2,
  open_connections: 2,
  items: personDetail.sessions,
  next_cursor: null,
};

const definitionsData = {
  version: "v1",
  families: [{ family: "message", label: "Message", kinds: [1, 9] }],
  metrics: [
    {
      key: "unique_people",
      label: "Unique people",
      definition: "Distinct pubkeys across the selected communities.",
      source: "users and relay_members",
      exclusions: ["deactivated identities"],
    },
  ],
  exclusions: ["presence", "typing", "authentication", "transport heartbeats"],
  sources: ["Postgres daily rollups", "shared Redis session leases"],
};

async function installSigner(page: Page) {
  await page.addInitScript(() => {
    const signs: Array<{ url?: string; method?: string }> = [];
    Object.defineProperty(window, "__operatorSigns", {
      value: signs,
      writable: false,
    });
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        getPublicKey: async () => "11".repeat(32),
        signEvent: async (event: { tags: string[][] }) => {
          signs.push({
            url: event.tags.find((tag) => tag[0] === "u")?.[1],
            method: event.tags.find((tag) => tag[0] === "method")?.[1],
          });
          return {
            ...event,
            id: "33".repeat(32),
            pubkey: "11".repeat(32),
            sig: "44".repeat(64),
          };
        },
      },
    });
  });
}

async function mockAnalytics(
  page: Page,
  options: { stale?: boolean; liveUnavailable?: boolean } = {},
) {
  await page.route("**/operator/analytics/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const data = pathname.endsWith("/overview")
      ? overviewData
      : pathname.endsWith("/communities")
        ? communityData
        : pathname.endsWith("/activity")
          ? {
              points: overviewData.trend,
              families: [
                { family: "message", event_count: 210, unique_people: 8 },
              ],
              people: [
                { person_type: "human", event_count: 210, unique_people: 8 },
              ],
            }
          : pathname.endsWith("/sessions")
            ? sessionData
            : pathname.endsWith("/definitions")
              ? definitionsData
              : pathname.includes(`/people/${sharedPubkey}`)
                ? personDetail
                : peopleData;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(envelope(data, options)),
    });
  });
}

test("overview command center shows deployment metrics and NIP-98 signing", async ({
  page,
}) => {
  await installSigner(page);
  await mockAnalytics(page);
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(
    page.locator(".analytics-metric-card").filter({ hasText: "Unique people" }),
  ).toBeVisible();
  await expect(page.getByText("12", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("People online")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Community health" }),
  ).toBeVisible();
  const signs = await page.evaluate(
    () =>
      (
        window as unknown as {
          __operatorSigns: Array<{ url?: string; method?: string }>;
        }
      ).__operatorSigns,
  );
  expect(signs.length).toBeGreaterThan(0);
  expect(
    signs.every(
      (sign) =>
        sign.method === "GET" && sign.url?.includes("/operator/analytics/"),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
});

test("stale historical data stays visible with a watermark", async ({
  page,
}) => {
  await installSigner(page);
  await mockAnalytics(page, { stale: true });
  await page.goto("/analytics");
  await expect(page.getByText(/Historical: Stale/)).toBeVisible();
  await expect(
    page.getByText(/latest available rollup watermark/),
  ).toBeVisible();
  await expect(
    page.locator(".analytics-metric-card").filter({ hasText: "Unique people" }),
  ).toBeVisible();
});

test("Redis-unavailable live pulse is explicit and not zero", async ({
  page,
}) => {
  await installSigner(page);
  await mockAnalytics(page, { liveUnavailable: true });
  await page.goto("/analytics/sessions");
  await expect(page.getByText(/Live: Unavailable/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Source unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText(/not replaced with a single-pod estimate/),
  ).toBeVisible();
  await expect(page.getByText("No active sessions")).toHaveCount(0);
});

test("community scope drills into people and person detail", async ({
  page,
}) => {
  await installSigner(page);
  await mockAnalytics(page);
  await page.goto("/analytics/communities");
  await expect(
    page.getByRole("heading", { name: "Community fleet" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Design" }).click();
  await expect(page).toHaveURL(/community=aaaaaaaa/);
  await page.goto("/analytics/people");
  await page.getByRole("searchbox", { name: "Search people" }).fill("Ada");
  await expect(page.getByRole("link", { name: "Ada" })).toBeVisible();
  await page.getByRole("link", { name: "Ada" }).click();
  await expect(page).toHaveURL(new RegExp(`/analytics/people/${sharedPubkey}`));
  await expect(
    page.getByRole("heading", { name: "Person detail" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Memberships and context" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await expect(page.getByText("Provider")).toHaveCount(0);
  await expect(page.getByText("model", { exact: false })).toHaveCount(0);
  await expect(page.getByText("203.0.113.10")).toHaveCount(0);
});

test("sessions distinguish two connections for one person", async ({
  page,
}) => {
  await installSigner(page);
  await mockAnalytics(page);
  await page.goto("/analytics/sessions");
  await expect(page.getByText("Online people")).toBeVisible();
  await expect(page.getByText("Authenticated sessions")).toBeVisible();
  await expect(page.getByText("session-one")).toBeVisible();
  await expect(page.getByText("session-two")).toBeVisible();
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("2", { exact: true }).first()).toBeVisible();
});

test("no signer shows a connect-operator state without making requests", async ({
  page,
}) => {
  await page.goto("/analytics");
  await expect(
    page.getByRole("heading", { name: "Connect an operator signer" }),
  ).toBeVisible();
  await expect(
    page.getByText(/private keys never enter this page/),
  ).toBeVisible();
});

test("forbidden analytics responses show an explicit access state", async ({
  page,
}) => {
  await installSigner(page);
  await mockAnalytics(page);
  await page.route("**/operator/analytics/overview**", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "forbidden", message: "not authorized" },
      }),
    });
  });
  await page.goto("/analytics");
  await expect(
    page.getByRole("heading", { name: "Access denied" }),
  ).toBeVisible();
  await expect(page.getByText(/not allowlisted/)).toBeVisible();
});

test("empty communities and definitions remain explicit", async ({ page }) => {
  await installSigner(page);
  await page.route("**/operator/analytics/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const data = pathname.endsWith("/definitions")
      ? definitionsData
      : pathname.endsWith("/communities")
        ? { items: [], next_cursor: null }
        : overviewData;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(envelope(data)),
    });
  });
  await page.goto("/analytics/communities");
  await expect(
    page.getByRole("heading", { name: "No communities in scope" }),
  ).toBeVisible();
  await page.goto("/analytics/definitions");
  await expect(
    page.getByRole("heading", { name: "Metric definitions" }),
  ).toBeVisible();
  await expect(
    page.getByText("Distinct pubkeys across the selected communities."),
  ).toBeVisible();
});
