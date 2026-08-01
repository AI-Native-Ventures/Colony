import * as React from "react";
import { Loader2, MapPin } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Switch } from "@/shared/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { DiscoveryEntitlement } from "../entitlement";
import {
  DEFAULT_SOURCE_CONFIG,
  DISCOVERY_SOURCES,
  DISCOVERY_SOURCE_LABELS,
  toggleSource,
  type DiscoveryMode,
  type DiscoverySource,
} from "../sourceConfig";
import type { CampaignDetail, Vertical } from "../types";
import { EntitlementLock } from "./EntitlementLock";

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
  "New York",
  "Los Angeles",
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
  const [hasPhone, setHasPhone] = React.useState(false);
  const [hasEmail, setHasEmail] = React.useState(false);
  const [sourceMode, setSourceMode] = React.useState<DiscoveryMode>(
    DEFAULT_SOURCE_CONFIG.mode,
  );
  const [enabledSources, setEnabledSources] = React.useState<DiscoverySource[]>(
    () => [...DEFAULT_SOURCE_CONFIG.order],
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(defaultCampaignName(vertical));
    setLocation("");
    setTarget("50");
    setDescription("");
    setHasWebsite(true);
    setHasPhone(false);
    setHasEmail(false);
    setSourceMode(DEFAULT_SOURCE_CONFIG.mode);
    setEnabledSources([...DEFAULT_SOURCE_CONFIG.order]);
    setError(null);
  }, [open, vertical]);

  const targetNumber = Math.max(0, Number.parseInt(target, 10) || 0);
  const estimatedCredits = targetNumber * 300;

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
        className="flex h-full max-w-xl flex-col overflow-y-auto"
        side="right"
      >
        <SheetHeader>
          <SheetTitle id="create-campaign-title">
            New discovery campaign
          </SheetTitle>
          <SheetDescription id="create-campaign-description">
            Tell the discovery agent where to find {vertical.name.toLowerCase()}{" "}
            businesses.
          </SheetDescription>
        </SheetHeader>

        <form className="mt-5 flex flex-1 flex-col" onSubmit={handleSubmit}>
          <Tabs className="flex-1" defaultValue="campaign">
            <TabsList aria-label="Campaign setup sections">
              <TabsTrigger value="campaign">Campaign</TabsTrigger>
              <TabsTrigger value="criteria">Criteria</TabsTrigger>
            </TabsList>
            <TabsContent className="space-y-5" value="campaign">
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  Selected vertical
                </p>
                <p className="mt-1 text-base font-semibold text-foreground">
                  {vertical.name}
                </p>
                <p className="text-sm text-muted-foreground">{industryName}</p>
              </div>

              <label
                className="space-y-1.5 text-sm font-medium text-foreground"
                htmlFor="discovery-campaign-name"
              >
                Campaign name
                <Input
                  id="discovery-campaign-name"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">
                  Where should the agent search?
                </legend>
                <div className="flex flex-wrap gap-2">
                  {LOCATION_SUGGESTIONS.map((suggestion) => (
                    <Button
                      aria-pressed={location === suggestion}
                      key={suggestion}
                      onClick={() => setLocation(suggestion)}
                      size="sm"
                      type="button"
                      variant={
                        location === suggestion ? "secondary" : "outline"
                      }
                    >
                      <MapPin aria-hidden="true" />
                      {suggestion}
                    </Button>
                  ))}
                </div>
                <Input
                  aria-label="Search location"
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="Or type a city, state, or country"
                  value={location}
                />
              </fieldset>

              <label
                className="space-y-1.5 text-sm font-medium text-foreground"
                htmlFor="discovery-campaign-target"
              >
                How many leads?
                <Input
                  id="discovery-campaign-target"
                  min="1"
                  onChange={(event) => setTarget(event.target.value)}
                  type="number"
                  value={target}
                />
              </label>

              <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Estimated discovery credits
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      A display-only fixture estimate; no credits are reserved
                      or charged.
                    </p>
                  </div>
                  <span className="font-mono text-base font-semibold text-primary">
                    {estimatedCredits.toLocaleString()} credits
                  </span>
                </div>
              </div>

              <label
                className="space-y-1.5 text-sm font-medium text-foreground"
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
            </TabsContent>

            <TabsContent className="space-y-5" value="criteria">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Advanced criteria
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  These preferences are saved with the campaign setup for the
                  provider integration.
                </p>
              </div>
              <div className="space-y-3 rounded-lg border border-border/60 p-4">
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
              <div className="space-y-4 rounded-lg border border-border/60 p-4">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    Advanced Data Sources
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Choose which sources the discovery agent can use. This is
                    saved with the draft and never charges credits here.
                  </p>
                </div>
                <Tabs
                  onValueChange={(value) => {
                    if (value === "waterfall" || value === "concurrent") {
                      setSourceMode(value);
                    }
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
                    const paidLocked =
                      key === "linkedin_company_search" &&
                      entitlement?.state !== "entitled";
                    return (
                      <div
                        className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/50 p-2.5"
                        key={key}
                      >
                        <span className="min-w-0 flex-1 text-sm text-foreground">
                          {DISCOVERY_SOURCE_LABELS[key]}
                        </span>
                        <Switch
                          aria-label={`${enabled ? "Disable" : "Enable"} ${DISCOVERY_SOURCE_LABELS[key]}`}
                          checked={enabled}
                          disabled={paidLocked}
                          onCheckedChange={() => {
                            setEnabledSources(
                              (current) =>
                                toggleSource(
                                  {
                                    mode: sourceMode,
                                    order: current,
                                  },
                                  key,
                                ).order,
                            );
                          }}
                        />
                        {paidLocked ? (
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
            </TabsContent>
          </Tabs>

          {error ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <SheetFooter className="mt-6 gap-2 border-t border-border/50 pt-4">
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
              Create campaign
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
      <span>{label}</span>
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
