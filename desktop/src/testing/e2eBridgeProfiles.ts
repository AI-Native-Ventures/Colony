/** Profile command handlers for the synthetic/relay E2E transport. */
export type RawProfile = {
  pubkey: string;
  display_name: string | null;
  /** Kind-0 `name` field, kept separate from `display_name` so mention
   * resolution can match either alias. */
  name?: string | null;
  avatar_url: string | null;
  about: string | null;
  nip05_handle: string | null;
  owner_pubkey: string | null;
  is_agent?: boolean;
  /** Mirrors the Rust `has_profile_event` flag: true when a real kind:0 event
   * backed this profile, false for the synthesized empty fallback. */
  has_profile_event: boolean;
};

type ProfileConfig = {
  mock?: {
    profileReadDelayMs?: number;
    profileReadError?: string;
    profileUpdateError?: string;
    profileUpdateErrors?: string[];
  };
};

type Dependencies<Config> = {
  getIdentity: (config: Config | undefined) => { pubkey: string } | undefined;
  ensureMockProfile: (config: Config | undefined) => RawProfile;
  getMockMemberPubkey: (config: Config | undefined) => string;
  getMockProfileByPubkey: (pubkey: string) => RawProfile | null;
  applyMockDisplayName: (pubkey: string, name: string | null) => void;
  queryProfile: (
    config: Config | undefined,
    pubkey: string,
  ) => Promise<{ content?: string }[]>;
  publishProfile: (
    config: Config | undefined,
    content: string,
  ) => Promise<unknown>;
};

/** Preserve the bridge's shared profile store and relay transport by reference. */
export function createProfileHandlers<Config extends ProfileConfig>({
  getIdentity,
  ensureMockProfile,
  getMockMemberPubkey,
  getMockProfileByPubkey,
  applyMockDisplayName,
  queryProfile,
  publishProfile,
}: Dependencies<Config>) {
  const cloneProfile = (profile: RawProfile): RawProfile => ({ ...profile });
  async function handleGetProfile(config: Config | undefined) {
    const identity = getIdentity(config);
    if (!identity) {
      const profileReadDelayMs = config?.mock?.profileReadDelayMs ?? 0;
      if (profileReadDelayMs > 0) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, profileReadDelayMs);
        });
      }

      const profileReadError = config?.mock?.profileReadError;
      if (profileReadError) {
        throw new Error(profileReadError);
      }

      return cloneProfile(ensureMockProfile(config));
    }

    // Pure Nostr: query kind:0 (profile metadata) for our pubkey.
    const events = await queryProfile(config, identity.pubkey);
    if (events.length === 0) {
      return {
        pubkey: identity.pubkey,
        display_name: null,
        about: null,
        avatar_url: null,
        nip05_handle: null,
        owner_pubkey: null,
        has_profile_event: false,
      };
    }
    const content = JSON.parse(events[0].content ?? "{}");
    return {
      pubkey: identity.pubkey,
      display_name: content.display_name ?? content.name ?? null,
      about: content.about ?? null,
      avatar_url: content.picture ?? null,
      nip05_handle: content.nip05 ?? null,
      owner_pubkey: null,
      has_profile_event: true,
    };
  }

  async function handleUpdateProfile(
    args: {
      displayName?: string;
      displayNameIfMissing?: boolean;
      avatarUrl?: string;
      about?: string;
      nip05Handle?: string;
    },
    config: Config | undefined,
  ) {
    const identity = getIdentity(config);
    if (!identity) {
      const profileUpdateError = config?.mock?.profileUpdateError;
      const profileUpdateErrors = config?.mock?.profileUpdateErrors;
      const nextProfileUpdateError = profileUpdateErrors?.shift();
      if (nextProfileUpdateError) {
        throw new Error(nextProfileUpdateError);
      }

      if (profileUpdateError) {
        if (config?.mock) {
          config.mock.profileUpdateError = undefined;
        }
        throw new Error(profileUpdateError);
      }

      const profile = ensureMockProfile(config);
      if (
        args.displayNameIfMissing &&
        profile.has_profile_event &&
        profile.display_name?.trim()
      ) {
        return cloneProfile(profile);
      }
      const hasDisplayNameUpdate = typeof args.displayName === "string";
      const hasAvatarUrlUpdate = typeof args.avatarUrl === "string";
      const hasAboutUpdate = typeof args.about === "string";
      const hasNip05HandleUpdate = typeof args.nip05Handle === "string";
      const nextDisplayName = args.displayName?.trim() ?? "";
      const nextAvatarUrl = args.avatarUrl?.trim() ?? "";
      const nextAbout = args.about?.trim() ?? "";
      const nextNip05Handle = args.nip05Handle?.trim() ?? "";

      if (hasDisplayNameUpdate && nextDisplayName !== profile.display_name) {
        profile.display_name = nextDisplayName || null;
        applyMockDisplayName(profile.pubkey, profile.display_name);
      }
      if (hasAvatarUrlUpdate && nextAvatarUrl !== profile.avatar_url) {
        profile.avatar_url = nextAvatarUrl || null;
      }
      if (hasAboutUpdate && nextAbout !== profile.about) {
        profile.about = nextAbout || null;
      }
      if (hasNip05HandleUpdate && nextNip05Handle !== profile.nip05_handle) {
        profile.nip05_handle = nextNip05Handle || null;
      }

      // A successful native update publishes kind:0, including an empty profile.
      profile.has_profile_event = true;
      return cloneProfile(profile);
    }

    // Read-merge-write: fetch current profile, merge, sign kind:0.
    const currentEvents = await queryProfile(config, identity.pubkey);
    const currentContent = currentEvents[0]
      ? JSON.parse(currentEvents[0].content ?? "{}")
      : {};
    const profileContent = JSON.stringify({
      display_name:
        args.displayName ?? currentContent.display_name ?? undefined,
      name: currentContent.display_name ?? undefined,
      picture: args.avatarUrl ?? currentContent.picture ?? undefined,
      about: args.about ?? currentContent.about ?? undefined,
      nip05: args.nip05Handle ?? currentContent.nip05 ?? undefined,
    });
    await publishProfile(config, profileContent);

    // Return the updated profile in RawProfile shape
    const updated = JSON.parse(profileContent);
    return {
      pubkey: identity.pubkey,
      display_name: updated.display_name ?? null,
      about: updated.about ?? null,
      avatar_url: updated.picture ?? null,
      nip05_handle: updated.nip05 ?? null,
      owner_pubkey: null,
      has_profile_event: true,
    };
  }

  async function handleGetUserProfile(
    args: {
      pubkey?: string;
    },
    config: Config | undefined,
  ) {
    const identity = getIdentity(config);
    if (!identity) {
      const pubkey = (args.pubkey ?? getMockMemberPubkey(config)).toLowerCase();
      const profile = getMockProfileByPubkey(pubkey);
      if (!profile) {
        throw new Error(`User ${pubkey} not found.`);
      }

      return cloneProfile(profile);
    }

    const targetPubkey = args.pubkey ?? identity.pubkey;
    const events = await queryProfile(config, targetPubkey);
    if (events.length === 0) {
      return {
        pubkey: targetPubkey,
        display_name: null,
        about: null,
        avatar_url: null,
        nip05_handle: null,
        owner_pubkey: null,
        has_profile_event: false,
      };
    }
    const content = JSON.parse(events[0].content ?? "{}");
    return {
      pubkey: targetPubkey,
      display_name: content.display_name ?? content.name ?? null,
      about: content.about ?? null,
      avatar_url: content.picture ?? null,
      nip05_handle: content.nip05 ?? null,
      owner_pubkey: null,
      has_profile_event: true,
    };
  }

  return { handleGetProfile, handleUpdateProfile, handleGetUserProfile };
}
