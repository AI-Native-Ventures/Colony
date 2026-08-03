import * as React from "react";
import { Building2, Check, Loader2, MapPin } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  getDiscoveryCredentialStatus,
  type DiscoveryCredentialProvider,
  type DiscoveryCredentialStatus,
} from "@/shared/api/discoveryCredentials";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Switch } from "@/shared/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { DiscoveryEntitlement } from "../entitlement";
import {
  DEFAULT_SOURCE_CONFIG,
  DISCOVERY_SOURCES,
  DISCOVERY_SOURCE_LABELS,
  DISCOVERY_SOURCE_PROVIDERS,
  isLiveDiscoverySource,
  toggleSource,
  type DiscoveryMode,
  type DiscoverySource,
} from "../sourceConfig";
import type { CampaignDetail, Vertical } from "../types";
import { EntitlementLock } from "./EntitlementLock";
import { DISCOVERY_LIGHT_SURFACE_STYLE } from "./discoverySurfaceStyle";

export type CreateCampaignSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  onRetryEntitlement: () => void;
  industryName: string;
  vertical: Vertical;
  onCreated: (campaign: CampaignDetail) => void;
};

const LOCATION_SUGGESTIONS = [
  "Johannesburg",
  "Cape Town",
  "Durban",
  "Pretoria",
  "Sandton",
  "Port Elizabeth",
  "Gauteng",
  "Western Cape",
  "KwaZulu-Natal",
  "South Africa",
];

function defaultCampaignName(vertical: Vertical) {
  return `${vertical.name} campaign`;
}

export function CreateCampaignSheet({
  open,
  onOpenChange,
  dataSource,
  entitlement,
  onRetryEntitlement,
  industryName,
  vertical,
  onCreated,
}: CreateCampaignSheetProps) {
  const [name, setName] = React.useState(() => defaultCampaignName(vertical));
  const [location, setLocation] = React.useState("");
  const [target, setTarget] = React.useState("50");
  const [description, setDescription] = React.useState("");
  const [hasWebsite, setHasWebsite] = React.useState(true);
  const [hasPhone, setHasPhone] = React.useState(true);
  const [hasEmail, setHasEmail] = React.useState(true);
  const [sourceMode, setSourceMode] = React.useState<DiscoveryMode>(
    DEFAULT_SOURCE_CONFIG.mode,
  );
  const [enabledSources, setEnabledSources] = React.useState<DiscoverySource[]>(
    () => [...DEFAULT_SOURCE_CONFIG.order],
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [credentialStatuses, setCredentialStatuses] = React.useState<
    Partial<Record<DiscoveryCredentialProvider, DiscoveryCredentialStatus>>
  >({});
  const liveBusinessPhase = entitlement?.experience === "live";

  React.useEffect(() => {
    if (!open) return;
    setName(defaultCampaignName(vertical));
    setLocation("");
    setTarget("50");
    setDescription("");
    setHasWebsite(true);
    setHasPhone(true);
    setHasEmail(true);
    setSourceMode(DEFAULT_SOURCE_CONFIG.mode);
    setEnabledSources(
      liveBusinessPhase ? [] : [...DEFAULT_SOURCE_CONFIG.order],
    );
    setCredentialStatuses({});
    setError(null);
    if (liveBusinessPhase) {
      let cancelled = false;
      void Promise.all(
        Object.values(DISCOVERY_SOURCE_PROVIDERS).map(async (provider) => {
          try {
            return [
              provider,
              await getDiscoveryCredentialStatus(provider),
            ] as const;
          } catch {
            return [provider, "unavailable"] as const;
          }
        }),
      ).then((statuses) => {
        if (cancelled) return;
        const next = Object.fromEntries(statuses) as Partial<
          Record<DiscoveryCredentialProvider, DiscoveryCredentialStatus>
        >;
        setCredentialStatuses(next);
        const configuredSources = (
          ["google_maps", "brave_search", "exa_search"] as const
        ).filter(
          (source) => next[DISCOVERY_SOURCE_PROVIDERS[source]] === "configured",
        );
        setEnabledSources(configuredSources);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [liveBusinessPhase, open, vertical]);

  const targetNumber = Math.max(0, Number.parseInt(target, 10) || 0);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedLocation = location.trim();
    if (!normalizedLocation) {
      setError("Add at least one location before creating the campaign.");
      return;
    }
    if (!Number.isFinite(targetNumber) || targetNumber < 1) {
      setError("Choose a lead target of at least one.");
      return;
    }
    if (enabledSources.length === 0) {
      setError(
        liveBusinessPhase
          ? "Connect an API key in Settings > Discovery, then select a source."
          : "Select at least one Discovery source.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const campaign = await dataSource.createCampaign({
        name: name.trim() || defaultCampaignName(vertical),
        industryId: vertical.industryId,
        verticalId: vertical.id,
        location: normalizedLocation,
        target: targetNumber,
        description:
          description.trim() ||
          `Find ${vertical.name.toLowerCase()} businesses in ${normalizedLocation}.`,
        sourceConfig: {
          mode: sourceMode,
          order: [...enabledSources],
        },
      });
      onCreated(campaign);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not create campaign.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        aria-describedby="create-campaign-description"
        aria-labelledby="create-campaign-title"
        className="flex h-full w-full max-w-[37.5rem] flex-col gap-0 overflow-hidden p-0 text-foreground sm:max-w-[37.5rem]"
        side="right"
        style={DISCOVERY_LIGHT_SURFACE_STYLE}
      >
        <SheetHeader className="border-b border-border px-8 py-8">
          <SheetTitle className="text-xl" id="create-campaign-title">
            Tell Jen where to find leads and how many you need.
          </SheetTitle>
          <SheetDescription id="create-campaign-description">
            Configure the discovery campaign for {vertical.name}.
          </SheetDescription>
        </SheetHeader>

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-8 py-8">
            <section className="space-y-3">
              <h2 className="text-base font-semibold text-foreground">
                What type of business?
              </h2>
              <div className="flex items-center justify-between rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/30 bg-background text-primary">
                    <Building2 aria-hidden="true" className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {vertical.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Selected vertical · {industryName}
                    </div>
                  </div>
                </div>
                <Button
                  className="text-xs"
                  onClick={() => undefined}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Change
                </Button>
              </div>
            </section>

            <fieldset className="space-y-3">
              <legend className="text-base font-semibold text-foreground">
                Where should Jen search?
              </legend>
              <div className="flex flex-wrap gap-2">
                {LOCATION_SUGGESTIONS.map((suggestion) => (
                  <Button
                    aria-pressed={location === suggestion}
                    className="rounded-full"
                    key={suggestion}
                    onClick={() => setLocation(suggestion)}
                    size="sm"
                    type="button"
                    variant={location === suggestion ? "secondary" : "outline"}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
              <div className="relative">
                <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search location"
                  className="pl-9"
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="Or type a location (city, province, country)..."
                  value={location}
                />
              </div>
            </fieldset>

            <section className="space-y-3">
              <h2 className="text-base font-semibold text-foreground">
                How many leads?
              </h2>
              <div className="flex items-center gap-3">
                <Input
                  className="w-32 text-center font-mono"
                  id="discovery-campaign-target"
                  min="1"
                  onChange={(event) => setTarget(event.target.value)}
                  type="number"
                  value={target}
                />
                <span className="text-sm text-muted-foreground">
                  per location
                </span>
              </div>
            </section>

            <div className="rounded-2xl bg-muted/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Provider usage
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Billed directly by your connected source account.
                  </p>
                </div>
                <span className="text-right text-sm font-semibold text-primary">
                  No Colony usage credits
                </span>
              </div>
            </div>

            <details className="group rounded-2xl border border-border p-4">
              <summary className="cursor-pointer text-sm font-semibold text-foreground">
                Advanced: Data Sources
              </summary>
              <div className="mt-4 space-y-4">
                <Tabs
                  onValueChange={(value) => {
                    if (value === "waterfall" || value === "concurrent")
                      setSourceMode(value);
                  }}
                  value={sourceMode}
                >
                  <TabsList aria-label="Campaign source mode">
                    <TabsTrigger value="waterfall">Waterfall</TabsTrigger>
                    <TabsTrigger value="concurrent">Concurrent</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="space-y-2">
                  {DISCOVERY_SOURCES.map(({ key }) => {
                    const enabled = enabledSources.includes(key);
                    const liveAvailable =
                      isLiveDiscoverySource(key) &&
                      credentialStatuses[DISCOVERY_SOURCE_PROVIDERS[key]] ===
                        "configured";
                    const locked = liveBusinessPhase
                      ? !liveAvailable
                      : key === "linkedin_company_search" &&
                        entitlement?.state !== "entitled";
                    const liveHint = !liveBusinessPhase
                      ? null
                      : !isLiveDiscoverySource(key)
                        ? "Not available yet"
                        : credentialStatuses[
                              DISCOVERY_SOURCE_PROVIDERS[key]
                            ] === "configured"
                          ? "Connected"
                          : "Connect in Settings";
                    return (
                      <div
                        className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/50 p-2.5"
                        key={key}
                      >
                        <span className="min-w-0 flex-1 text-sm text-foreground">
                          {DISCOVERY_SOURCE_LABELS[key]}
                        </span>
                        {liveHint ? (
                          <span className="text-xs text-muted-foreground">
                            {liveHint}
                          </span>
                        ) : null}
                        <Switch
                          aria-label={`${enabled ? "Disable" : "Enable"} ${DISCOVERY_SOURCE_LABELS[key]}`}
                          checked={enabled}
                          disabled={locked}
                          onCheckedChange={() => {
                            if (liveBusinessPhase) {
                              setEnabledSources((current) =>
                                current.includes(key)
                                  ? current.length > 1
                                    ? current.filter((source) => source !== key)
                                    : current
                                  : [...current, key],
                              );
                              return;
                            }
                            setEnabledSources(
                              (current) =>
                                toggleSource(
                                  { mode: sourceMode, order: current },
                                  key,
                                ).order,
                            );
                          }}
                        />
                        {locked && !liveBusinessPhase ? (
                          <EntitlementLock
                            actionLabel="Unlock source"
                            entitlement={entitlement}
                            onRetry={onRetryEntitlement}
                            onRun={() => undefined}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </details>

            <section className="space-y-4">
              {liveBusinessPhase ? (
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    Qualification criteria
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This first live version uses the business type and location
                    above. Additional qualification filters will be added in a
                    later phase.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      Advanced Criteria
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Optional signals Jen can use to qualify results.
                    </p>
                  </div>
                  <div className="space-y-3">
                    <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Must have
                    </p>
                    <CriteriaSwitch
                      checked={hasWebsite}
                      label="Must be in the specified location"
                      onCheckedChange={setHasWebsite}
                    />
                    <CriteriaSwitch
                      checked={hasPhone}
                      label="Must match the vertical/profession"
                      onCheckedChange={setHasPhone}
                    />
                    <p className="pt-2 text-2xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Nice to have
                    </p>
                    <CriteriaSwitch
                      checked={hasWebsite}
                      label="Has website"
                      onCheckedChange={setHasWebsite}
                    />
                    <CriteriaSwitch
                      checked={hasPhone}
                      label="Has phone number"
                      onCheckedChange={setHasPhone}
                    />
                    <CriteriaSwitch
                      checked={hasEmail}
                      label="Has email address"
                      onCheckedChange={setHasEmail}
                    />
                  </div>
                </>
              )}
            </section>

            <label
              className="space-y-2 text-sm font-medium text-foreground"
              htmlFor="discovery-campaign-name"
            >
              Campaign name
              <Input
                id="discovery-campaign-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </label>
            <label
              className="space-y-2 text-sm font-medium text-foreground"
              htmlFor="discovery-campaign-description"
            >
              Campaign details{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
              <Input
                id="discovery-campaign-description"
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the ideal lead"
                value={description}
              />
            </label>
          </div>

          {error ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <SheetFooter className="mt-6 gap-2 border-t border-border/50 px-8 pb-8 pt-6">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={submitting} type="submit">
              {submitting ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : null}
              Create Campaign
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function CriteriaSwitch({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-foreground">
      <span className="min-w-0 flex-1">{label}</span>
      <button
        aria-label={label}
        aria-pressed={checked}
        className={
          checked
            ? "grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors"
            : "h-5 w-5 shrink-0 rounded-full border-2 border-muted-foreground/40 transition-colors hover:border-primary"
        }
        onClick={() => onCheckedChange(!checked)}
        type="button"
      >
        {checked ? (
          <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
        ) : null}
      </button>
    </div>
  );
}
