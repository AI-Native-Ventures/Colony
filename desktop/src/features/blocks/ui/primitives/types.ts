import type { ReactNode } from "react";

import type { BlockQuestionOption } from "@/features/blocks/contracts";

export type BlockGap = "small" | "medium" | "large";
export type BlockOrigin =
  | "core"
  | "installed"
  | "workspace-custom"
  | "untrusted";
export type BlockTone = "neutral" | "info" | "success" | "warning" | "error";

export type BlockSignedInteraction = {
  type: "signed";
  action_id: string;
  resolves_attention?: boolean;
};

export type BlockPresentationInteraction = {
  type: "presentation";
  surface: "agent-review";
};

export type BlockInteraction =
  | BlockSignedInteraction
  | BlockPresentationInteraction;

export type BlockActionControl = {
  label: string;
  interaction: BlockInteraction;
};

export type BlockLayoutNode =
  | {
      type: "stack";
      gap: BlockGap;
      children: BlockPrimitiveNode[];
    }
  | {
      type: "grid";
      columns: number;
      gap: BlockGap;
      children: BlockPrimitiveNode[];
    };

export type BlockSectionNode = {
  type: "section";
  title?: string;
  text?: string;
};

export type BlockMetricNode = {
  type: "metric";
  label: string;
  value: string;
  unit?: string;
};

export type BlockDetailsNode = {
  type: "details";
  items: Array<{ label: string; value: string }>;
};

export type BlockStatusNode = {
  type: "status";
  label: string;
  state_path?: string;
};

export type BlockActionsNode = {
  type: "actions";
  controls: BlockActionControl[];
};

export type BlockQuestionNode = {
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

export type BlockTableColumn = {
  key: string;
  label: string;
  format?: "text" | "number" | "currency" | "date" | "boolean";
};

export type BlockTableNode = {
  type: "table";
  columns: BlockTableColumn[];
  rows_path: string;
  caption?: string;
};

export type BlockCardNode = {
  type: "card";
  title?: string;
  description?: string;
  children?: BlockPrimitiveNode[];
};

export type BlockCardListMode = "list" | "grid" | "carousel";

export type BlockCardListNode = {
  type: "card-list";
  items_path: string;
  card: BlockPrimitiveNode;
  mode?: BlockCardListMode;
};

export type BlockChartKind = "bar" | "line" | "area" | "donut";

export type BlockChartNode = {
  type: "chart";
  kind: BlockChartKind;
  data_path: string;
  label_key: string;
  value_key: string;
};

export type BlockMediaKind = "image" | "video" | "file";

export type BlockMediaNode = {
  type: "media";
  url?: string;
  url_path?: string;
  alt: string;
};

export type BlockPrimitiveNode =
  | BlockLayoutNode
  | BlockSectionNode
  | BlockMetricNode
  | BlockDetailsNode
  | BlockStatusNode
  | BlockActionsNode
  | BlockQuestionNode
  | BlockTableNode
  | BlockCardNode
  | BlockCardListNode
  | BlockChartNode
  | BlockMediaNode;

export type BlockMediaItem = {
  url: string;
  alt: string;
  kind?: BlockMediaKind;
  mime?: string;
  filename?: string;
  expectedSha256?: string;
  actualSha256?: string;
};

export type BlockActionEnvironment = {
  origin: BlockOrigin;
  trusted: boolean;
  declaredActionIds: ReadonlySet<string>;
  /** Signed controls that are safe to invoke with an empty inline payload. */
  directActionIds?: ReadonlySet<string>;
  directActionInputs?: ReadonlyMap<string, unknown>;
  actionUnavailableReasons?: ReadonlyMap<string, string>;
  hideIndirectSignedActions?: boolean;
  resolvingActionIds?: ReadonlySet<string>;
  pendingActionId?: string;
  completedActionIds?: ReadonlySet<string>;
  disabledReason?: string;
  submitSigned?: (
    interaction: BlockSignedInteraction,
    input?: unknown,
  ) => void | Promise<void>;
  openPresentation?: (
    interaction: BlockPresentationInteraction,
  ) => void | Promise<void>;
};

export type BlockPrimitiveRenderContext = {
  data: unknown;
  rootData?: unknown;
  /** Terminal resolution for an instance that required user attention. */
  attentionResolution?: "succeeded" | "denied";
  actionEnvironment?: BlockActionEnvironment;
  mediaItems?: readonly BlockMediaItem[];
  renderChild?: (
    node: BlockPrimitiveNode,
    key: string,
    data: unknown,
  ) => ReactNode;
};

export type ResolvedStatus = {
  label: string;
  state: string;
  tone: BlockTone;
  progress?: number;
};

export type ResolvedChartDatum = {
  label: string;
  value: number;
};

export type ResolvedMedia = {
  item?: BlockMediaItem;
  reason?: string;
};
