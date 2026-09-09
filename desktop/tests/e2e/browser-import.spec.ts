import { expect, test, type Page } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { openSettings } from "../helpers/settings";
import { waitForAnimations } from "../helpers/animations";

async function openImport(page: Page, scenario: "copied" | "preserved") {
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("open-settings")).toBeVisible();
  // The regular mock native bridge is already installed. This owner-only
  // browser adapter returns synthetic site metadata and counts, never cookies.
  await page.evaluate((mode) => {
    const calls: Record<string, unknown>[] = [];
    const sites = Array.from(
      { length: 105 },
      (_, index) => `.site-${index}.test`,
    );
    Object.assign(window, {
      __BROWSER_IMPORT_CALLS__: calls,
      colonyDesktop: {
        subscribe: () => () => {},
        request: async (type: string, payload?: Record<string, unknown>) => {
          if (type === "import:discover")
            return {
              profiles: [
                {
                  id: "one",
                  browserName: "Chrome",
                  profileName: "Work",
                  supported: true,
                },
                {
                  id: "two",
                  browserName: "Firefox",
                  profileName: "Personal",
                  supported: true,
                },
              ],
            };
          if (type === "import:sites")
            return payload?.profileId === "two" ? [".personal.test"] : sites;
          if (type === "import:run") {
            calls.push(payload ?? {});
            return mode === "preserved"
              ? {
                  imported: 0,
                  preserved: 336,
                  skipped: 28,
                  failed: 0,
                  status: "needs-verification",
                }
              : {
                  imported: (payload?.hosts as string[]).length,
                  preserved: 0,
                  skipped: 0,
                  failed: 0,
                  status: "needs-verification",
                };
          }
          throw new Error(`Unexpected synthetic browser request: ${type}`);
        },
      },
    });
  }, scenario);
  await openSettings(page);
  await page.getByTestId("settings-nav-browser").click();
  const form = page.getByTestId("browser-import");
  await expect(form).toBeVisible();
  await form
    .getByRole("combobox", { name: "Browser profile" })
    .selectOption("one");
  await expect(form.getByText("0 of 105 sites selected")).toBeVisible();
  return form;
}

async function importCalls(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __BROWSER_IMPORT_CALLS__: Record<string, unknown>[];
        }
      ).__BROWSER_IMPORT_CALLS__,
  );
}

test("bulk selection is explicit, search preserves other selections, and profile changes reset consent", async ({
  page,
}) => {
  const form = await openImport(page, "copied");
  await form.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(form.getByText("105 of 105 sites selected")).toBeVisible();
  await expect(
    form.getByRole("button", {
      name: "Import sign-ins (105 sites)",
      exact: true,
    }),
  ).toBeEnabled();
  expect(await importCalls(page)).toEqual([]);
  await waitForAnimations(page);
  await form.screenshot({ path: "test-results/browser-import/select-all.png" });

  await form.getByRole("button", { name: "Clear selection" }).click();
  await form
    .getByRole("checkbox", { name: ".site-99.test", exact: true })
    .check();
  await form.getByRole("textbox", { name: "Filter sites" }).fill(" .SITE-10 ");
  await form.getByRole("button", { name: "Select matches" }).click();
  await expect(
    form.getByText("7 of 105 sites selected · 6 matches"),
  ).toBeVisible();
  await form.getByRole("textbox", { name: "Filter sites" }).fill("");
  await expect(
    form.getByRole("checkbox", { name: ".site-99.test", exact: true }),
  ).toBeChecked();

  const replace = form.getByRole("checkbox", {
    name: /Replace existing sign-ins/,
  });
  await replace.check();
  await form
    .getByRole("combobox", { name: "Browser profile" })
    .selectOption("two");
  await expect(form.getByText("0 of 1 sites selected")).toBeVisible();
  await expect(replace).not.toBeChecked();
  expect(await importCalls(page)).toEqual([]);
});

test("select all imports over 100 sites using confirmed bounded requests and shows a clear result", async ({
  page,
}) => {
  const form = await openImport(page, "copied");
  await form.getByRole("button", { name: "Select all", exact: true }).click();
  await form
    .getByRole("button", { name: "Import sign-ins (105 sites)", exact: true })
    .click();
  const result = form.getByTestId("browser-import-result");
  await expect(
    result.getByText("Sign-in data copied", { exact: true }),
  ).toBeVisible();
  await expect(result).toContainText("accounts still need to be checked");
  const calls = await importCalls(page);
  expect(calls.map((call) => (call.hosts as string[]).length)).toEqual([
    100, 5,
  ]);
  expect(
    calls.every(
      (call) =>
        call.confirmed === true &&
        call.replaceExisting === false &&
        call.profileId === "one",
    ),
  ).toBe(true);
  expect(new Set(calls.flatMap((call) => call.hosts as string[])).size).toBe(
    105,
  );
  expect(calls[0].business).toBeTruthy();
  expect(calls[1].business).toBe(calls[0].business);
  await waitForAnimations(page);
  await result.screenshot({ path: "test-results/browser-import/copied.png" });
});

test("preserved-only import explains zero new data and provides a deliberate refresh path", async ({
  page,
}) => {
  const form = await openImport(page, "preserved");
  await form
    .getByRole("checkbox", { name: ".site-0.test", exact: true })
    .check();
  await form
    .getByRole("button", { name: "Import sign-ins (1 site)", exact: true })
    .click();
  const result = form.getByTestId("browser-import-result");
  await expect(
    result.getByText("No new sign-in data copied", { exact: true }),
  ).toBeVisible();
  await expect(result).toContainText("336");
  await expect(result).toContainText("28");
  await expect(result).toContainText("replacement was turned off");
  await expect(result).toContainText("turn on Replace existing sign-ins");
  expect((await importCalls(page))[0].replaceExisting).toBe(false);
  await expect(
    form.getByRole("checkbox", { name: /Replace existing sign-ins/ }),
  ).not.toBeChecked();
  await waitForAnimations(page);
  await result.screenshot({
    path: "test-results/browser-import/preserved.png",
  });
});
