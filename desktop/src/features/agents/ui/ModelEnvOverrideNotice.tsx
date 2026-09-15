/**
 * Inline notice for a saved env var that looks like it chooses the model but
 * does not.
 *
 * `BUZZ_ACP_MODEL` and `BUZZ_ACP_PROVIDER` are written from the agent's resolved
 * configuration at launch, so a copy of either in the agent's env vars is
 * ignored. That used to be invisible: an agent showed harness "Claude Code" and
 * model `opus[1m]` in this dialog while launching with `--model
 * metered/grok-4.5` from a leftover `BUZZ_ACP_MODEL`, and the vendor CLI replied
 * that the model may not exist. The value is migrated off the record on the next
 * load, so this notice covers the window before that and anything set by hand
 * afterwards.
 */
import { AlertTriangle } from "lucide-react";

/** Env keys the resolved configuration owns. Mirrors `CONFIG_OWNED_MODEL_ENV_KEYS`. */
export const CONFIG_OWNED_MODEL_ENV_KEYS = [
  "BUZZ_ACP_MODEL",
  "BUZZ_ACP_PROVIDER",
] as const;

/** What the notice says the key is for, so the sentence reads naturally. */
const FIELD_LABEL: Record<string, string> = {
  BUZZ_ACP_MODEL: "model",
  BUZZ_ACP_PROVIDER: "provider",
};

export type IgnoredModelEnvOverride = {
  /** The key exactly as it is stored, so the user can find it under Advanced. */
  key: string;
  value: string;
  /** "model" or "provider". */
  label: string;
};

/**
 * The config-owned env entries present in `envVars`, in key order. Matching is
 * case-insensitive because the Rust side strips and migrates case-insensitively.
 */
export function findIgnoredModelEnvOverrides(
  envVars: Record<string, string> | null | undefined,
): IgnoredModelEnvOverride[] {
  if (!envVars) return [];
  return Object.keys(envVars)
    .sort()
    .flatMap((key) => {
      const owned = CONFIG_OWNED_MODEL_ENV_KEYS.find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      if (!owned) return [];
      return [{ key, value: envVars[key] ?? "", label: FIELD_LABEL[owned] }];
    });
}

export function ModelEnvOverrideNotice({
  envVars,
}: {
  envVars: Record<string, string> | null | undefined;
}) {
  const overrides = findIgnoredModelEnvOverrides(envVars);
  if (overrides.length === 0) return null;
  return (
    <div
      className="mt-2 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-bg px-3 py-2.5"
      data-testid="model-env-override-notice"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-warning"
      />
      <div aria-live="polite" className="text-xs leading-5 text-warning">
        {overrides.map((override) => (
          <p key={override.key}>
            This agent still has{" "}
            <code className="font-mono">
              {override.key}={override.value}
            </code>{" "}
            saved under Advanced. It is ignored: the {override.label} above is
            what runs. Delete the env var to stop seeing this.
          </p>
        ))}
      </div>
    </div>
  );
}
