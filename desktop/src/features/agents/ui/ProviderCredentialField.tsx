/**
 * Provider credential pseudo-field for global agent defaults.
 *
 * OpenRouter renders the OAuth PKCE connect control (no paste field — the
 * key never touches the user's hands); every other provider with a secret
 * env var renders the paste field. Both views are pure views over
 * `env_vars[apiKeyEnvVar]` — writes go through `onConfigChange`, and the
 * connect control may persist immediately via `onAutoSaveConfig` (settings)
 * or stage the draft (onboarding coalescer).
 */
import type { GlobalAgentConfig } from "@/shared/api/types";
import { OpenRouterConnectField } from "./OpenRouterConnectField";
import { PersonaProviderApiKeyField } from "./PersonaProviderApiKeyField";

export function ProviderCredentialField({
  apiKeyEnvVar,
  apiKeyFileSatisfied,
  apiKeyInherited,
  apiKeyValue,
  blockClassName,
  config,
  effectiveProvider,
  onAutoSaveConfig,
  onConfigChange,
}: {
  apiKeyEnvVar: string | null;
  apiKeyFileSatisfied: boolean;
  apiKeyInherited: boolean;
  apiKeyValue: string;
  blockClassName?: string;
  config: GlobalAgentConfig;
  effectiveProvider: string;
  onAutoSaveConfig?: (next: GlobalAgentConfig) => Promise<unknown>;
  onConfigChange: (next: GlobalAgentConfig) => void;
}) {
  if (!apiKeyEnvVar) return null;

  return (
    <div className={blockClassName}>
      {effectiveProvider === "openrouter" ? (
        <OpenRouterConnectField
          config={config}
          connected={apiKeyValue.trim().length > 0}
          inheritedLabel={
            apiKeyInherited
              ? apiKeyFileSatisfied
                ? "Set in runtime config"
                : "Provided by this build"
              : undefined
          }
          onAutoSaveConfig={onAutoSaveConfig}
          onConfigChange={onConfigChange}
        />
      ) : (
        <PersonaProviderApiKeyField
          disabled={false}
          inheritedLabel={
            apiKeyFileSatisfied
              ? "Set in runtime config"
              : "Provided by this build"
          }
          isInherited={apiKeyInherited}
          isRequired={!apiKeyInherited && apiKeyValue.length === 0}
          label={
            effectiveProvider === "anthropic"
              ? "Anthropic API Key"
              : "OpenAI API Key"
          }
          onValueChange={(value) =>
            onConfigChange({
              ...config,
              env_vars: { ...config.env_vars, [apiKeyEnvVar]: value },
            })
          }
          value={apiKeyValue}
        />
      )}
    </div>
  );
}
