/** The hosted account service already used by Colony stable and canary. */
export const ELECTRON_BETA_RELAY = Object.freeze({
  websocket: "wss://relay.colony.ainative.ventures",
  http: "https://relay.colony.ainative.ventures",
});

/**
 * Provision the branded, installable beta independently of a developer's
 * current relay. Local overrides remain available through electron:dev.
 */
export function electronBetaBuildEnv(env) {
  const configured = {
    ...env,
    BUZZ_RELAY_URL: ELECTRON_BETA_RELAY.websocket,
    BUZZ_RELAY_HTTP: ELECTRON_BETA_RELAY.http,
  };
  // Signup uses this root's account API; a fresh identity must not join the
  // root community before onboarding provisions its own business.
  delete configured.BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY;
  delete configured.BUZZ_ONBOARDING_FIXTURE_TRANSPORT;
  return configured;
}

/** Fixture transports are an explicit, separately named build, never a beta default. */
export function electronPackageVariant(args) {
  const fixture = args.includes("--onboarding-fixture");
  return {
    fixture,
    name: fixture ? "Colony Onboarding Fixture" : "Colony Electron Beta",
    bundleId: fixture
      ? "ventures.ainative.colony.onboarding-fixture"
      : "ventures.ainative.colony.electron-beta",
    outputSuffix: fixture ? "-onboarding-fixture" : "",
    helperFeatures: fixture
      ? [
          "--features",
          "buzz-acp/onboarding-fixture,buzz-cli/onboarding-fixture",
        ]
      : [],
    hostFeatures: fixture
      ? "electron-host,onboarding-fixture"
      : "electron-host",
  };
}
