export const STABLE_UPDATER_ENDPOINT =
  "https://github.com/AI-Native-Ventures/colony-releases/releases/download/colony-desktop-latest/latest.json";

export const CANARY_UPDATER_ENDPOINT =
  "https://github.com/AI-Native-Ventures/colony-releases/releases/download/colony-canary-latest/latest.json";

/**
 * One endpoint per release channel. A build never carries another channel's.
 *
 * A release candidate is a prerelease of the stable channel, not a channel of
 * its own, so it updates from the same manifest stable does.
 */
export const UPDATER_ENDPOINTS = Object.freeze({
  stable: STABLE_UPDATER_ENDPOINT,
  candidate: STABLE_UPDATER_ENDPOINT,
  canary: CANARY_UPDATER_ENDPOINT,
});

/** Developer ID mode has no ad-hoc fallback. Never log credentials. */
export function productionSigning(env) {
  const required = [
    "COLONY_APPLE_SIGNING_IDENTITY",
    "COLONY_APPLE_TEAM_ID",
    "COLONY_APPLE_API_KEY",
    "COLONY_APPLE_API_KEY_ID",
    "COLONY_APPLE_API_ISSUER",
  ];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length)
    throw new Error(
      `Production signing is unavailable: configure ${missing.join(", ")}`,
    );
  if (
    !env.COLONY_APPLE_SIGNING_IDENTITY.startsWith(
      "Developer ID Application: ",
    ) ||
    !/^[A-Z0-9]{10}$/.test(env.COLONY_APPLE_TEAM_ID) ||
    !env.COLONY_APPLE_SIGNING_IDENTITY.endsWith(`(${env.COLONY_APPLE_TEAM_ID})`)
  )
    throw new Error(
      "Production requires a matching Developer ID Application identity and Apple team",
    );
  return {
    osxSign: {
      identity: env.COLONY_APPLE_SIGNING_IDENTITY,
      keychain: env.COLONY_APPLE_KEYCHAIN,
      identityValidation: true,
      optionsForFile: () => ({ hardenedRuntime: true }),
    },
    osxNotarize: {
      appleApiKey: env.COLONY_APPLE_API_KEY,
      appleApiKeyId: env.COLONY_APPLE_API_KEY_ID,
      appleApiIssuer: env.COLONY_APPLE_API_ISSUER,
    },
  };
}

/**
 * Baked updater configuration uses the same trust key and URL as existing
 * installations of that channel. Stable and canary share one updater keypair
 * on purpose: they are separate channels, not separate trust roots.
 */
export function channelUpdaterConfig(channel, env) {
  const endpoint = UPDATER_ENDPOINTS[channel];
  if (!endpoint)
    throw new Error(`No updater endpoint is defined for channel ${channel}`);
  if (!env.BUZZ_UPDATER_PUBLIC_KEY?.trim())
    throw new Error(
      "BUZZ_UPDATER_PUBLIC_KEY is required for the production updater",
    );
  if (env.BUZZ_UPDATER_ENDPOINT && env.BUZZ_UPDATER_ENDPOINT !== endpoint)
    throw new Error(`The ${channel} updater endpoint cannot change`);
  return {
    plugins: {
      updater: {
        pubkey: env.BUZZ_UPDATER_PUBLIC_KEY,
        endpoints: [endpoint],
      },
    },
  };
}

/** Kept for callers that only ever package the stable channel. */
export function stableUpdaterConfig(env) {
  return channelUpdaterConfig("stable", env);
}
