import type { RelayEvent } from "@/shared/api/types";

export const BLOCK_SCHEMA_DRAFT_2020_12 =
  "https://json-schema.org/draft/2020-12/schema";
export const BLOCK_INLINE_DATA_MAX_BYTES = 32 * 1024;
export const BLOCK_EXTERNAL_DATA_MAX_BYTES = 2 * 1024 * 1024;
export const BLOCK_MAX_DEPTH = 12;
export const BLOCK_MAX_NODES = 200;
export const BLOCK_MAX_QUESTION_OPTIONS = 12;

export const BLOCK_PRIMITIVE_HANDLES = [
  "section",
  "metric",
  "details",
  "table",
  "card",
  "card-list",
  "chart",
  "media",
  "status",
  "actions",
  "question",
] as const;

export const BLOCK_STARTER_COMPOSITE_HANDLES = [
  "lead-card",
  "approval",
  "agent-proposal",
  "report",
  "artifact",
  "receipt",
  "brainstorm",
] as const;

export type BlockOrigin = "core" | "installed" | "workspace-custom";
export type BlockTrust = BlockOrigin | "untrusted";
export type BlockGap = "small" | "medium" | "large";
export type BlockValidationState = "draft" | "tested";

export type BlockPresentationInteraction = {
  type: "presentation";
  surface: "agent-review";
};

export type BlockSignedInteraction = {
  type: "signed";
  action_id: string;
  resolves_attention: boolean;
};

export type BlockInteraction =
  | BlockPresentationInteraction
  | BlockSignedInteraction;

export type BlockActionDeclaration = {
  id: string;
  label: string;
  input_schema?: unknown;
  interaction: BlockInteraction;
  permissions: string[];
};

export type BlockPermission = {
  capability: string;
  constraints: unknown;
};

export type BlockExample = {
  name: string;
  data: unknown;
};

export type BlockQuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type BlockNode =
  | {
      type: "stack";
      gap: BlockGap;
      children: BlockNode[];
    }
  | {
      type: "grid";
      columns: number;
      gap: BlockGap;
      children: BlockNode[];
    }
  | {
      type: "section";
      title?: string;
      text?: string;
    }
  | {
      type: "metric";
      label: string;
      value: string;
      unit?: string;
    }
  | {
      type: "details";
      items: Array<{ label: string; value: string }>;
    }
  | {
      type: "table";
      columns: Array<{ key: string; label: string }>;
      rows_path: string;
    }
  | {
      type: "card";
      title?: string;
      description?: string;
      children: BlockNode[];
    }
  | {
      type: "card-list";
      items_path: string;
      card: BlockNode;
    }
  | {
      type: "chart";
      kind: "bar" | "line" | "area" | "donut";
      data_path: string;
      label_key: string;
      value_key: string;
    }
  | {
      type: "media";
      url?: string;
      url_path?: string;
      alt: string;
    }
  | {
      type: "status";
      label: string;
      state_path?: string;
    }
  | {
      type: "actions";
      controls: Array<{ label: string; interaction: BlockInteraction }>;
    }
  | {
      type: "question";
      prompt: string;
      mode: "single-select" | "multi-select";
      options?: BlockQuestionOption[];
      options_path?: string;
      min_selections: number;
      max_selections: number;
      allow_custom: boolean;
      require_custom_input: boolean;
      submit_action: string;
    };

export type BlockManifest = {
  schema: string;
  handle: string;
  version: string;
  name: string;
  description: string;
  origin: BlockOrigin;
  created_at: number;
  input_schema: unknown;
  tree: BlockNode;
  actions: BlockActionDeclaration[];
  permissions: BlockPermission[];
  fallback_template: string;
  supported_clients: string[];
  primitive_versions: Record<string, number>;
  examples: BlockExample[];
  validation: {
    state: BlockValidationState;
    requires_attention: boolean;
  };
};

export type InlineBlockData = {
  type: "inline";
  value: unknown;
};

export type ExternalBlockData = {
  type: "external";
  url: string;
  mime: string;
  sha256: string;
  byteSize: number;
};

export type BlockInstanceData = InlineBlockData | ExternalBlockData;

export type BlockInstanceRef = {
  handle: string;
  manifestId: string;
  instanceId: string;
  data: BlockInstanceData;
  attentionRequired: boolean;
  decisionMakerPubkey: string | null;
  processorPubkey: string | null;
};

export type BlockActionRef = {
  actionId: string;
  instanceId: string;
  idempotencyKey: string;
  instanceEventId: string;
  manifestId: string;
  processorPubkey: string;
};

export type BlockReceiptStatus =
  | "succeeded"
  | "denied"
  | "failed"
  | "timed-out";

export type BlockReceiptRef = {
  instanceId: string;
  idempotencyKey: string;
  status: BlockReceiptStatus;
  actionEventId: string;
  instanceEventId: string;
  resolvesAttention: boolean;
};

export type BlockFailureCode =
  | "invalid-tags"
  | "invalid-json"
  | "invalid-manifest"
  | "invalid-data"
  | "invalid-event"
  | "missing-manifest"
  | "integrity-failed"
  | "unavailable";

export type BlockParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: BlockFailureCode; message: string };

export type BlockManifestRecord = {
  event: RelayEvent;
  manifest: BlockManifest;
  digest: string;
  trust: BlockTrust;
};

export type BlockWorkspaceTrust = {
  memberRoles: ReadonlyMap<string, "owner" | "admin" | "member">;
  verifiedAgentOwners: ReadonlyMap<string, string>;
  installedPublisherPubkeys: ReadonlySet<string>;
};
