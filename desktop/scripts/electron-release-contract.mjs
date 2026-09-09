export const STABLE_UPDATER_ENDPOINT =
  "https://github.com/AI-Native-Ventures/colony-releases/releases/download/colony-desktop-latest/latest.json";

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

/** Baked updater configuration uses the same trust key and URL as existing installations. */
export function stableUpdaterConfig(env) {
  if (!env.BUZZ_UPDATER_PUBLIC_KEY?.trim())
    throw new Error(
      "BUZZ_UPDATER_PUBLIC_KEY is required for the production updater",
    );
  if (
    env.BUZZ_UPDATER_ENDPOINT &&
    env.BUZZ_UPDATER_ENDPOINT !== STABLE_UPDATER_ENDPOINT
  )
    throw new Error("The stable updater endpoint cannot change");
  return {
    plugins: {
      updater: {
        pubkey: env.BUZZ_UPDATER_PUBLIC_KEY,
        endpoints: [STABLE_UPDATER_ENDPOINT],
      },
    },
  };
}
