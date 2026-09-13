/** The hosted account service already used by Colony stable and canary. */
export const ELECTRON_BETA_RELAY = Object.freeze({
  websocket: "wss://relay.colony.ainative.ventures",
  http: "https://relay.colony.ainative.ventures",
});

/** The port channel talks only to the canary relay, never to production. */
export const ELECTRON_PORT_RELAY = Object.freeze({
  websocket: "wss://relay-canary.colony.ainative.ventures",
  http: "https://relay-canary.colony.ainative.ventures",
});

/**
 * Provision the branded, installable beta independently of a developer's
 * current relay. Local overrides remain available through electron:dev.
 * A port build is the one channel that embeds a different relay.
 */
export function electronBetaBuildEnv(env, { port = false } = {}) {
  const relay = port ? ELECTRON_PORT_RELAY : ELECTRON_BETA_RELAY;
  const configured = {
    ...env,
    BUZZ_RELAY_URL: relay.websocket,
    BUZZ_RELAY_HTTP: relay.http,
  };
  // Signup uses this root's account API; a fresh identity must not join the
  // root community before onboarding provisions its own business.
  delete configured.BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY;
  delete configured.BUZZ_ONBOARDING_FIXTURE_TRANSPORT;
  return configured;
}

/**
 * The canary keyring service the Tauri canary already bakes in. A canary that
 * used the stable service would read and rewrite the stable install's identity
 * blob, which broke first-run signup on 2026-08-27.
 */
export const CANARY_KEYRING_SERVICE = "colony-canary-desktop";

/** The port keyring service the Tauri port build already bakes in. */
export const PORT_KEYRING_SERVICE = "colony-port-desktop";

/** Fixture transports are an explicit, separately named build, never a beta default. */
export function electronPackageVariant(args) {
  const fixture = args.includes("--onboarding-fixture");
  const production = args.includes("--production");
  const adHoc = args.includes("--ad-hoc");
  const candidate = args.includes("--production-candidate");
  const canary = args.includes("--canary");
  const port = args.includes("--port");
  if (canary && port)
    throw new Error("--canary and --port are mutually exclusive");
  if (adHoc && !production && !canary && !port)
    throw new Error(
      "Explicit ad-hoc distribution requires --production, --canary, or --port",
    );
  // Canary and port are distributions of their own. They borrow production's
  // signing and packaging, never production's name, identifier or updater
  // channel.
  const stable = !canary && !port && (production || candidate);
  const release = stable || canary || port;
  if (
    release &&
    (fixture || args.includes("--debug") || (production && candidate))
  )
    throw new Error(
      "Production packages cannot use fixture, debug or conflicting release modes",
    );
  if (port && candidate)
    throw new Error("A port package cannot also be a production candidate");
  if (canary && candidate)
    throw new Error("A canary package cannot also be a production candidate");
  const name = canary
    ? "Colony Canary"
    : port
      ? "Colony Port"
      : stable
        ? "Colony"
        : fixture
          ? "Colony Onboarding Fixture"
          : "Colony Electron Beta";
  return {
    fixture,
    production,
    canary,
    port,
    developerId: production && !adHoc,
    candidate,
    stable,
    release,
    channel: canary
      ? "canary"
      : port
        ? "port"
        : production
          ? "stable"
          : candidate
            ? "candidate"
            : "beta",
    name,
    // Never buzz-desktop for the canary: the two apps must be distinguishable
    // in Activity Monitor and killable one at a time.
    executableName: canary
      ? "colony-canary"
      : port
        ? "colony-port"
        : stable
          ? "buzz-desktop"
          : name,
    bundleId: canary
      ? "ventures.ainative.colony.canary"
      : port
        ? "ventures.ainative.colony.port"
        : stable
          ? "xyz.block.buzz.app"
          : fixture
            ? "ventures.ainative.colony.onboarding-fixture"
            : "ventures.ainative.colony.electron-beta",
    outputSuffix: canary
      ? "-canary"
      : port
        ? "-port"
        : stable
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
    hostFeatures: release
      ? "electron-stable"
      : fixture
        ? "electron-host,onboarding-fixture,tauri/custom-protocol"
        : "electron-host",
  };
}
