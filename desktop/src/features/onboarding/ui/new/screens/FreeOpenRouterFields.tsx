import { useEffect } from "react";
import { OpenRouterConnectField } from "@/features/agents/ui/OpenRouterConnectField";
import { usePersonaModelDiscovery } from "@/features/agents/ui/usePersonaModelDiscovery";
import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";
import { isFreeOpenRouterModel } from "../../../powerChoice";

/** Native OAuth and the live model catalog; only explicitly free model IDs save. */
export function FreeOpenRouterFields({
  config,
  runtime,
  onChange,
  onValidityChange,
}: {
  config: GlobalAgentConfig;
  runtime: AcpRuntimeCatalogEntry;
  onChange: (config: GlobalAgentConfig) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const connected = !!config.env_vars.OPENROUTER_API_KEY?.trim();
  const discovery = usePersonaModelDiscovery({
    envVars: config.env_vars,
    isCustomProviderEditing: false,
    modelFieldVisible: connected,
    open: connected,
    provider: "openrouter",
    selectedRuntime: runtime,
  });
  const options = (discovery.discoveredModelOptions ?? []).filter((model) =>
    isFreeOpenRouterModel(model.id),
  );
  // The documented free router is a stable default even when a provider's
  // catalog does not list routing aliases. Named models require catalog proof.
  const valid =
    connected &&
    !discovery.modelDiscoveryLoading &&
    discovery.discoveredModelOptions !== null &&
    (config.model === "openrouter/free" ||
      options.some((model) => model.id === config.model));
  useEffect(() => onValidityChange(valid), [valid, onValidityChange]);
  return (
    <div className="space-y-4">
      <OpenRouterConnectField
        config={config}
        connected={connected}
        onConfigChange={onChange}
      />
      <div className="onb-simple-field">
        <label htmlFor="onb-free-model">Default model</label>
        <select
          id="onb-free-model"
          value={config.model ?? "openrouter/free"}
          onChange={(event) =>
            onChange({ ...config, model: event.target.value })
          }
        >
          <option value="openrouter/free">
            Choose a free model automatically
          </option>
          {options
            .filter((model) => model.id !== "openrouter/free")
            .map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
        </select>
        {discovery.modelDiscoveryLoading && (
          <p className="onb-simple-note">Checking available free models…</p>
        )}
        {discovery.modelDiscoveryStatus && (
          <p className="onb-simple-note" role="status">
            {discovery.modelDiscoveryStatus.message}
          </p>
        )}
      </div>
      <p className="onb-simple-note">
        Free models have usage limits. OpenRouter allows 50 requests a day;
        buying at least $10 of OpenRouter credits raises that to 1,000 a day.
        The limit is 20 requests a minute. These are OpenRouter credits,
        separate from Colony Credits.
      </p>
      <a
        className="onb-simple-link"
        href="https://openrouter.ai/docs/api_reference/limits"
        target="_blank"
        rel="noreferrer"
      >
        View OpenRouter’s limits
      </a>
    </div>
  );
}
