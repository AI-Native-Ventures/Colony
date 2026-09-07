import os from "node:os";
import {
  discoverBrowserProfiles,
  summarizeBrowserProfiles,
} from "./discovery.mjs";
import { support, listSites, readSelectedCookies } from "./stores.mjs";

/** Owner-only import service. IPC returns metadata and counts, never cookie values. */
export class SignInImport {
  profiles = new Map();
  selections = new Map();
  busy = false;
  constructor(
    views,
    {
      discover = discoverBrowserProfiles,
      sites = listSites,
      read = readSelectedCookies,
    } = {},
  ) {
    this.views = views;
    this.discover = discover;
    this.sites = sites;
    this.read = read;
  }
  async discoverProfiles() {
    const found = await this.discover({
      platform: process.platform,
      homeDir: os.homedir(),
      env: process.env,
    });
    this.profiles = new Map(
      found.profiles.map((profile) => [profile.id, profile]),
    );
    this.selections.clear();
    const summary = summarizeBrowserProfiles(found);
    summary.profiles = summary.profiles.map((profile) => ({
      ...profile,
      supported: support(this.profiles.get(profile.id)),
    }));
    return summary;
  }
  profile(id) {
    const profile = this.profiles.get(id);
    if (!profile || !support(profile))
      throw new Error("This profile requires signing in directly in Colony");
    return profile;
  }
  async list({ profileId }) {
    const hosts = await this.sites(this.profile(profileId));
    if (hosts.length > 2000)
      throw new Error(
        "This profile has too many sites. Sign in directly in Colony.",
      );
    this.selections.set(profileId, new Set(hosts));
    return hosts;
  }
  async import({
    business,
    profileId,
    hosts,
    confirmed,
    replaceExisting = false,
  }) {
    if (confirmed !== true)
      throw new Error("Choose sites and confirm the import first");
    if (this.busy) throw new Error("An import is already running");
    if (typeof replaceExisting !== "boolean")
      throw new Error("Invalid replacement choice");
    const profile = this.profile(profileId);
    const available = this.selections.get(profileId);
    if (
      !Array.isArray(hosts) ||
      hosts.length === 0 ||
      hosts.length > 100 ||
      new Set(hosts).size !== hosts.length ||
      hosts.some((host) => typeof host !== "string" || !available?.has(host))
    )
      throw new Error("Choose up to 100 sites from this profile");
    const destination = this.views.sessionFor(business);
    this.busy = true;
    let imported = 0,
      skipped = 0,
      preserved = 0,
      failed = 0;
    try {
      const result = await this.read(profile, hosts);
      skipped = result.skipped;
      // Recheck after OS prompts/database reads. Never retarget an in-flight import.
      this.views.sessionFor(business);
      for (const cookie of result.cookies) {
        this.views.sessionFor(business);
        const existing = await destination.cookies.get({ name: cookie.name });
        this.views.sessionFor(business);
        const domain = (cookie.domain || new URL(cookie.url).hostname).replace(
          /^\./,
          "",
        );
        if (
          !replaceExisting &&
          existing.some(
            (saved) =>
              saved.domain.replace(/^\./, "") === domain &&
              saved.path === cookie.path,
          )
        ) {
          preserved++;
          continue;
        }
        try {
          await destination.cookies.set(cookie);
          imported++;
        } catch {
          failed++;
        }
      }
      await destination.cookies.flushStore();
      return {
        imported,
        skipped,
        preserved,
        failed,
        status: "needs-verification",
      };
    } catch {
      // May have applied a subset. No automatic retry or dishonest success state.
      return { imported, skipped, preserved, failed, status: "interrupted" };
    } finally {
      this.busy = false;
    }
  }
}
