/**
 * The agent definition dialog's readiness gate.
 *
 * Memoized separately from the dialog because the dialog sits at the desktop
 * file-size ratchet's limit; the rule there is to split rather than raise it.
 * Behaviour is unchanged: the same `computeLocalModeGate` call with the same
 * inputs and the same dependency list.
 */
import * as React from "react";

import { computeLocalModeGate } from "@/features/agents/ui/agentConfigOptions";
import type { RuntimeFileConfigSubset } from "@/shared/api/tauri";

export function useLocalModeGate({
  bakedEnvKeys,
  envVars,
  globalEnvVars,
  globalModel,
  globalProvider,
  model,
  provider,
  runtimeFileConfig,
  runtimeId,
}: {
  bakedEnvKeys: string[] | undefined;
  envVars: Record<string, string>;
  globalEnvVars: Record<string, string>;
  globalModel: string;
  globalProvider: string;
  model: string;
  provider: string;
  runtimeFileConfig: RuntimeFileConfigSubset | null | undefined;
  runtimeId: string;
}) {
  return React.useMemo(
    () =>
      computeLocalModeGate({
        bakedEnvKeys,
        envVars,
        globalEnvVars,
        globalProvider,
        globalModel,
        isProviderMode: false,
        model,
        provider,
        runtimeId,
        runtimeFileConfig,
      }),
    [
      bakedEnvKeys,
      envVars,
      globalEnvVars,
      globalModel,
      globalProvider,
      model,
      provider,
      runtimeFileConfig,
      runtimeId,
    ],
  );
}
