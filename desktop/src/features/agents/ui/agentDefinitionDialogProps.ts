/**
 * Props and submit options for `AgentDefinitionDialog`.
 *
 * Split out of the dialog itself: the component sits at the desktop file-size
 * ratchet's limit, and the ratchet's rule is to split rather than raise it.
 * Types are the cleanest seam, since they carry no behaviour.
 */
import type * as React from "react";

import type { AgentRank } from "@/features/agents/employeeHeads";
import type {
  AcpRuntimeCatalogEntry,
  CreatePersonaInput,
  UpdatePersonaInput,
} from "@/shared/api/types";

export type AgentDefinitionDialogProps = {
  open: boolean;
  embedded?: boolean;
  title: string;
  description: string;
  submitLabel: string;
  initialValues: CreatePersonaInput | UpdatePersonaInput | null;
  error: Error | null;
  isPending: boolean;
  runtimes: AcpRuntimeCatalogEntry[];
  runtimeCatalogStatus?: "loading" | "ready" | "error";
  runtimesLoading?: boolean;
  secondaryAction?: { label: string; onSelect: () => void };
  onDirtyChange?: (dirty: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    input: CreatePersonaInput | UpdatePersonaInput,
    options: AgentDefinitionSubmitOptions,
  ) => Promise<unknown>;
  /** Publishes saved changes when the edited agent is shared in the catalog. */
  publishCatalogUpdatesOnSave?: boolean;
  createRunSection?: React.ReactNode;
  /** Offer rank + manager at create time. See `AgentOrgPlacementSection`. */
  orgPlacement?: boolean;
  /** Extra create-mode submit gate (e.g. incomplete provider config). */
  createSubmitBlocked?: boolean;
};

export type AgentDefinitionSubmitOptions = {
  publishCatalogUpdates: boolean;
  /** Placement published after the created agent's head lands; see
   * `AgentOrgPlacementSection` for why it cannot ride the persona payload. */
  orgRank?: AgentRank;
  orgManager?: string;
};
