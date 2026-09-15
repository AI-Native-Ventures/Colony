/**
 * Provider credential pseudo-field for global agent defaults.
 *
 * OpenRouter renders the OAuth PKCE connect control (no paste field — the
 * key never touches the user's hands); every other provider with a secret
 * env var renders the paste field. Both views are pure views over
 * `env_vars[apiKeyEnvVar]` — writes go through `onConfigChange`, and the
 * connect control may persist immediately via `onAutoSaveConfig` (settings)
 * or stage the draft (onboarding coalescer).
 *
 * Google renders the same paste field plus a link to AI Studio, where the key
 * is minted for free, and the one thing a free-tier key costs the user: Google
 * may train on the prompts sent through it.
 */
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { openUrl } from "@/shared/api/nativeBridge";
import type { GlobalAgentConfig } from "@/shared/api/types";
import { OpenRouterConnectField } from "./OpenRouterConnectField";
import { PersonaProviderApiKeyField } from "./PersonaProviderApiKeyField";

const GOOGLE_AI_STUDIO_KEYS_URL = "https://aistudio.google.com/apikey";

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
        <>
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
                : effectiveProvider === "google"
                  ? "Google AI Studio API Key"
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
          {effectiveProvider === "google" ? (
            <div className="flex flex-col gap-0.5">
              <Button
                className="w-fit px-0 text-xs"
                data-testid="google-api-key-link"
                onClick={() =>
                  void openUrl(GOOGLE_AI_STUDIO_KEYS_URL).catch(() => {
                    toast.error("Failed to open link");
                  })
                }
                size="sm"
                variant="link"
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Get a free key
              </Button>
              <p className="text-xs text-muted-foreground">
                Free tier. Google may use your prompts to improve its products.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
