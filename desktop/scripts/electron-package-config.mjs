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
  const production = args.includes("--production");
  const candidate = args.includes("--production-candidate");
  const stable = production || candidate;
  if (
    stable &&
    (fixture || args.includes("--debug") || (production && candidate))
  )
    throw new Error(
      "Production packages cannot use fixture, debug or conflicting release modes",
    );
  const name = stable
    ? "Colony"
    : fixture
      ? "Colony Onboarding Fixture"
      : "Colony Electron Beta";
  return {
    fixture,
    production,
    candidate,
    stable,
    channel: production ? "stable" : candidate ? "candidate" : "beta",
    name,
    executableName: stable ? "buzz-desktop" : name,
    bundleId: stable
      ? "xyz.block.buzz.app"
      : fixture
        ? "ventures.ainative.colony.onboarding-fixture"
        : "ventures.ainative.colony.electron-beta",
    outputSuffix: stable
      ? production
        ? "-stable"
        : "-candidate"
      : fixture
        ? "-onboarding-fixture"
        : "",
    helperFeatures: fixture
      ? [
          "--features",
          "buzz-acp/onboarding-fixture,buzz-cli/onboarding-fixture",
        ]
      : [],
    hostFeatures: stable
      ? "electron-stable"
      : fixture
        ? "electron-host,onboarding-fixture,tauri/custom-protocol"
        : "electron-host",
  };
}
