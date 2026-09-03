// desktop/src/features/onboarding/invitesFlag.ts

type Env = Record<string, string | undefined>;

/**
 * Whether the invite screen ships in this build.
 *
 * It is dark by default: an invite link has nowhere to land while the
 * download button is off the marketing site, so the flow completes instead
 * of asking someone to invite people who cannot install Colony.
 *
 * This used to hang off the redesign's kill switch, which is gone: the canvas
 * flow is the only flow, so there is nothing left to fall back to.
 */
export function invitesEnabled(env: Env): boolean {
  return env.VITE_ONBOARDING_INVITES === "1";
}
