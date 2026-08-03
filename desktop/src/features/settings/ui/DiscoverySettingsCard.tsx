import * as React from "react";
import {
  Check,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import {
  deleteDiscoveryCredential,
  getDiscoveryCredentialStatus,
  saveDiscoveryCredential,
  type DiscoveryCredentialProvider,
  type DiscoveryCredentialStatus,
} from "@/shared/api/discoveryCredentials";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SettingsOptionGroup, SettingsOptionRow } from "./SettingsOptionGroup";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

const STATUS_CONTENT: Record<
  DiscoveryCredentialStatus,
  { label: string; className: string }
> = {
  configured: {
    label: "Connected",
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  missing: {
    label: "Not connected",
    className: "border-border/60 bg-background text-muted-foreground",
  },
  unavailable: {
    label: "Secure storage unavailable",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

const PROVIDERS: Array<{
  provider: DiscoveryCredentialProvider;
  label: string;
  description: string;
}> = [
  {
    provider: "outscraper",
    label: "Outscraper Businesses",
    description: "Finds public Google Maps business listings.",
  },
  {
    provider: "brave_search",
    label: "Brave Search",
    description: "Finds businesses from public web search results.",
  },
  {
    provider: "exa_search",
    label: "Exa Search",
    description: "Finds businesses using Exa semantic web search.",
  },
];

interface ProviderCredentialRowProps {
  provider: DiscoveryCredentialProvider;
  label: string;
  description: string;
}

function ProviderCredentialRow({
  provider,
  label,
  description,
}: ProviderCredentialRowProps) {
  const [status, setStatus] = React.useState<DiscoveryCredentialStatus | null>(
    null,
  );
  const [value, setValue] = React.useState("");
  const [showValue, setShowValue] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState<string | null>(null);
  const requestSequence = React.useRef(0);

  React.useEffect(() => {
    const sequence = ++requestSequence.current;
    void getDiscoveryCredentialStatus(provider)
      .then((nextStatus) => {
        if (requestSequence.current === sequence) setStatus(nextStatus);
      })
      .catch(() => {
        if (requestSequence.current === sequence) {
          setStatus("unavailable");
          setError("Colony could not check secure credential storage.");
        }
      });
    return () => {
      requestSequence.current += 1;
    };
  }, [provider]);

  const isBusy = isSaving || isDeleting;
  const storageUnavailable = status === "unavailable";
  const testPrefix = `discovery-${provider}`;

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim() || isBusy || storageUnavailable) return;
    setIsSaving(true);
    setError(null);
    setConfirmation(null);
    try {
      const nextStatus = await saveDiscoveryCredential(provider, value);
      setStatus(nextStatus);
      setValue("");
      setShowValue(false);
      setConfirmation(`${label} is connected on this device.`);
    } catch {
      setError(
        "The API key could not be saved securely. No provider request was made.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (isBusy) return;
    setIsDeleting(true);
    setError(null);
    setConfirmation(null);
    try {
      const nextStatus = await deleteDiscoveryCredential(provider);
      setStatus(nextStatus);
      setValue("");
      setShowValue(false);
      setConfirmation(`${label} was disconnected from this device.`);
    } catch {
      setError(
        "The saved API key could not be removed. Try again after unlocking secure storage.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  const statusContent = status ? STATUS_CONTENT[status] : null;

  return (
    <SettingsOptionRow
      className="flex-col items-stretch justify-start gap-3 border-b border-border/40 py-4 last:border-b-0"
      data-testid={`${testPrefix}-row`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-input/40 bg-background shadow-xs">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{label}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        {statusContent ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium",
              statusContent.className,
            )}
            data-testid={`${testPrefix}-credential-status`}
          >
            {statusContent.label}
          </span>
        ) : (
          <span
            className="inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground"
            data-testid={`${testPrefix}-credential-loading`}
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Checking…
          </span>
        )}
      </div>

      {storageUnavailable ? (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300"
          data-testid={`${testPrefix}-credential-unavailable`}
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Unlock your system keychain and restart Colony before connecting this
          source.
        </div>
      ) : (
        <form className="space-y-3" onSubmit={handleSave}>
          <label
            className="block text-sm font-medium"
            htmlFor={`${testPrefix}-key`}
          >
            {status === "configured" ? "Replace API key" : `${label} API key`}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <input
                autoComplete="new-password"
                className="h-9 w-full rounded-lg border border-input/60 bg-background px-3 pr-10 text-sm shadow-xs outline-hidden transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                data-testid={`${testPrefix}-key-input`}
                disabled={isBusy || status === null}
                id={`${testPrefix}-key`}
                onChange={(event) => {
                  setValue(event.target.value);
                  setConfirmation(null);
                }}
                placeholder={
                  status === "configured"
                    ? "Paste a replacement key"
                    : "Paste your API key"
                }
                spellCheck={false}
                type={showValue ? "text" : "password"}
                value={value}
              />
              <button
                aria-label={
                  showValue ? `Hide ${label} API key` : `Show ${label} API key`
                }
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                disabled={!value || isBusy}
                onClick={() => setShowValue((visible) => !visible)}
                type="button"
              >
                {showValue ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <Button
              data-testid={`${testPrefix}-save-credential`}
              disabled={!value.trim() || isBusy || status === null}
              type="submit"
            >
              {isSaving ? <LoaderCircle className="animate-spin" /> : null}
              {status === "configured" ? "Replace" : "Connect"}
            </Button>
            {status === "configured" ? (
              <Button
                data-testid={`${testPrefix}-delete-credential`}
                disabled={isBusy}
                onClick={() => void handleDelete()}
                type="button"
                variant="outline"
              >
                {isDeleting ? <LoaderCircle className="animate-spin" /> : null}
                Disconnect
              </Button>
            ) : null}
          </div>
        </form>
      )}

      {confirmation ? (
        <p
          className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400"
          data-testid={`${testPrefix}-credential-confirmation`}
        >
          <Check className="h-4 w-4" />
          {confirmation}
        </p>
      ) : null}
      {error ? (
        <p
          className="flex items-start gap-1.5 text-sm text-destructive"
          data-testid={`${testPrefix}-credential-error`}
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </SettingsOptionRow>
  );
}

export function DiscoverySettingsCard() {
  return (
    <section className="min-w-0" data-testid="settings-discovery">
      <SettingsSectionHeader
        description="Connect the sources Colony uses to find businesses."
        title="Discovery"
      />

      <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="text-sm text-muted-foreground">
          Each API key stays in this device&apos;s secure credential store.
          Colony does not upload or synchronize them. Live usage is billed
          directly to your provider accounts; saving a key does not start a run.
        </p>
      </div>

      <SettingsOptionGroup>
        {PROVIDERS.map((provider) => (
          <ProviderCredentialRow key={provider.provider} {...provider} />
        ))}
      </SettingsOptionGroup>
    </section>
  );
}
