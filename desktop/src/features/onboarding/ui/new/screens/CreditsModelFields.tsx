import { useEffect } from "react";
import { usePersonaModelDiscovery } from "@/features/agents/ui/usePersonaModelDiscovery";
import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";

/** Credits exposes served models, without asking the owner for a vendor API key. */
export function CreditsModelFields({
  config,
  runtime,
  onChange,
  onValidityChange,
  onRetry,
}: {
  config: GlobalAgentConfig;
  runtime: AcpRuntimeCatalogEntry;
  onChange: (config: GlobalAgentConfig) => void;
  onValidityChange: (valid: boolean) => void;
  onRetry: () => void;
}) {
  const discovery = usePersonaModelDiscovery({
    credentialMode: "colony_credits",
    envVars: config.env_vars,
    isCustomProviderEditing: false,
    modelFieldVisible: true,
    open: true,
    provider: config.provider ?? "",
    selectedRuntime: runtime,
  });
  const options = (discovery.discoveredModelOptions ?? []).filter(
    (model) => !!model.id,
  );
  const valid =
    !discovery.modelDiscoveryLoading &&
    options.some((model) => model.id === config.model);
  useEffect(() => onValidityChange(valid), [valid, onValidityChange]);
  return (
    <div className="onb-simple-field">
      <label htmlFor="onb-credits-model">Default model</label>
      <select
        id="onb-credits-model"
        value={valid ? (config.model ?? "") : ""}
        onChange={(event) => onChange({ ...config, model: event.target.value })}
      >
        <option value="" disabled>
          {discovery.modelDiscoveryLoading
            ? "Loading models…"
            : "Choose a model"}
        </option>
        {options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      <p className="onb-simple-note">
        Provided through Colony. No separate API key needed.
      </p>
      {discovery.modelDiscoveryStatus && (
        <div role="status" className="onb-simple-note">
          <p>{discovery.modelDiscoveryStatus.message}</p>
          {!discovery.modelDiscoveryLoading && (
            <button type="button" className="onb-simple-link" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
