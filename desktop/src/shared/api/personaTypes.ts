import type { RespondToMode } from "@/shared/api/types";

export type AgentPersona = {
  id: string;
  /** Stable company role slug, independent of this persona's personal name. */
  roleId: string | null;
  /** Human-readable title paired with roleId. */
  roleTitle: string | null;
  displayName: string;
  avatarUrl: string | null;
  systemPrompt: string;
  /** Preferred ACP runtime ID (e.g. "goose", "claude"). */
  runtime: string | null;
  /** Opaque, harness-specific model identifier string. */
  model: string | null;
  /** LLM inference provider injected as the runtime's provider env var. */
  provider: string | null;
  namePool: string[];
  isBuiltIn: boolean;
  isActive: boolean;
  /** Whether this persona is discoverable in the active community catalog. */
  shared: boolean;
  /** Team ID when imported from a team directory. */
  sourceTeam?: string | null;
  /** Coordinate of the foreign catalog publication this persona copied. */
  catalogSource?: CatalogSourceCoordinate | null;
  /** Agent environment variables, layered after desktop parent and persona values. */
  envVars: Record<string, string>;
  /** NIP-AP behavioral defaults (wire shape). Null/empty = unset. */
  respondTo: RespondToMode | null;
  respondToAllowlist: string[];
  parallelism: number | null;
  createdAt: string;
  updatedAt: string;
};

/** A catalog publication's owner plus persona d-tag coordinate. */
export type CatalogSourceCoordinate = {
  ownerPubkey: string;
  personaId: string;
};

/** NIP-AP behavioral defaults for a persona definition. */
export type PersonaBehaviorInput = {
  respondTo?: RespondToMode;
  respondToAllowlist?: string[];
  parallelism?: number;
};

export type CreatePersonaInput = {
  displayName: string;
  roleId?: string;
  roleTitle?: string;
  avatarUrl?: string;
  systemPrompt: string;
  runtime?: string;
  model?: string;
  provider?: string;
  namePool?: string[];
  envVars?: Record<string, string>;
  behavior?: PersonaBehaviorInput;
  /** Coordinate of the foreign catalog entry this persona copies. */
  catalogSource?: CatalogSourceCoordinate;
};

export type UpdatePersonaInput = {
  id: string;
  displayName: string;
  /** Omit both fields to preserve the stored role for legacy edit callers. */
  roleId?: string;
  roleTitle?: string;
  avatarUrl?: string;
  systemPrompt: string;
  runtime?: string;
  model?: string;
  provider?: string;
  namePool?: string[];
  envVars?: Record<string, string>;
  behavior?: PersonaBehaviorInput;
};
