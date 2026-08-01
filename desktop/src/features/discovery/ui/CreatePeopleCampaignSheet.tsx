import * as React from "react";
import { Check, Loader2, MapPin, UserRoundSearch } from "lucide-react";

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
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
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
import type { CampaignDetail, ProfessionalRole } from "../types";
import { EntitlementLock } from "./EntitlementLock";
import { DISCOVERY_LIGHT_SURFACE_STYLE } from "./discoverySurfaceStyle";

const LOCATIONS = [
  "United States",
  "New York",
  "Los Angeles",
  "Chicago",
  "Austin",
  "San Francisco",
  "Johannesburg",
  "Cape Town",
  "South Africa",
];

type CreatePeopleCampaignSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  onRetryEntitlement: () => void;
  fieldName: string;
  role: ProfessionalRole;
  onCreated: (campaign: CampaignDetail) => void;
};

function CriteriaRow({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 text-sm text-foreground">
      <span>{label}</span>
      <button
        aria-pressed={checked}
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-transparent"
        }`}
        onClick={() => onCheckedChange(!checked)}
        type="button"
      >
        <Check aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </label>
  );
}

export function CreatePeopleCampaignSheet({
  open,
  onOpenChange,
  dataSource,
  entitlement,
  onRetryEntitlement,
  fieldName,
  role,
  onCreated,
}: CreatePeopleCampaignSheetProps) {
  const [name, setName] = React.useState("");
  const [location, setLocation] = React.useState("");
  const [target, setTarget] = React.useState("50");
  const [description, setDescription] = React.useState("");
  const [mustMatchLocation, setMustMatchLocation] = React.useState(true);
  const [mustMatchRole, setMustMatchRole] = React.useState(true);
  const [hasEmail, setHasEmail] = React.useState(true);
  const [hasLinkedIn, setHasLinkedIn] = React.useState(true);
  const [hasCompany, setHasCompany] = React.useState(true);
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
    setName(`${role.name} campaign`);
    setLocation("");
    setTarget("50");
    setDescription("");
    setMustMatchLocation(true);
    setMustMatchRole(true);
    setHasEmail(true);
    setHasLinkedIn(true);
    setHasCompany(true);
    setSourceMode(DEFAULT_SOURCE_CONFIG.mode);
    setEnabledSources([...DEFAULT_SOURCE_CONFIG.order]);
    setError(null);
  }, [open, role.name]);

  const targetNumber = Math.max(0, Number.parseInt(target, 10) || 0);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!location.trim()) {
      setError("Add at least one location before creating the campaign.");
      return;
    }
    if (targetNumber < 1) {
      setError("Choose a people target of at least one.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const campaign = await dataSource.createCampaign({
        targetType: "individual",
        name: name.trim() || `${role.name} campaign`,
        industryId: role.fieldId,
        verticalId: role.id,
        fieldId: role.fieldId,
        roleId: role.id,
        location: location.trim(),
        target: targetNumber,
        description:
          description.trim() ||
          `Find ${role.name.toLowerCase()} professionals in ${location.trim()}.`,
        sourceConfig: { mode: sourceMode, order: [...enabledSources] },
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
        className="flex h-full w-full max-w-[37.5rem] flex-col gap-0 overflow-hidden p-0 text-foreground sm:max-w-[37.5rem]"
        side="right"
        style={DISCOVERY_LIGHT_SURFACE_STYLE}
      >
        <SheetHeader className="border-b border-border px-8 py-8">
          <SheetTitle className="text-xl">
            Tell Jen who to find and how many people you need.
          </SheetTitle>
          <SheetDescription>
            Configure the discovery campaign for {role.name}.
          </SheetDescription>
        </SheetHeader>

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-8 py-8">
            <section className="space-y-3">
              <h2 className="text-base font-semibold">
                What type of professional?
              </h2>
              <div className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/30 bg-background text-primary">
                  <UserRoundSearch aria-hidden="true" className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{role.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Selected role · {fieldName}
                  </p>
                </div>
              </div>
            </section>

            <fieldset className="space-y-3">
              <legend className="text-base font-semibold">
                Where should Jen search?
              </legend>
              <div className="flex flex-wrap gap-2">
                {LOCATIONS.map((item) => (
                  <Button
                    aria-pressed={location === item}
                    className="rounded-full"
                    key={item}
                    onClick={() => setLocation(item)}
                    size="sm"
                    type="button"
                    variant={location === item ? "secondary" : "outline"}
                  >
                    {item}
                  </Button>
                ))}
              </div>
              <div className="relative">
                <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search location"
                  className="pl-9"
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="Or type a location (city, state, country)..."
                  value={location}
                />
              </div>
            </fieldset>

            <section className="space-y-3">
              <h2 className="text-base font-semibold">How many people?</h2>
              <div className="flex items-center gap-3">
                <Input
                  className="w-32 text-center font-mono"
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
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Estimated cost
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    ~300 credits per person
                  </p>
                </div>
                <strong className="font-mono text-lg text-primary">
                  {(targetNumber * 300).toLocaleString()} credits
                </strong>
              </div>
            </div>

            <details className="rounded-2xl border border-border p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                Advanced: Data Sources
              </summary>
              <div className="mt-4 space-y-4">
                <Tabs
                  onValueChange={(value) =>
                    value === "waterfall" || value === "concurrent"
                      ? setSourceMode(value)
                      : undefined
                  }
                  value={sourceMode}
                >
                  <TabsList>
                    <TabsTrigger value="waterfall">Waterfall</TabsTrigger>
                    <TabsTrigger value="concurrent">Concurrent</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="space-y-2">
                  {DISCOVERY_SOURCES.map(({ key }) => {
                    const enabled = enabledSources.includes(key);
                    const locked =
                      key === "linkedin_company_search" &&
                      entitlement?.state !== "entitled";
                    return (
                      <div
                        className="flex items-center gap-3 rounded-lg border border-border/50 p-2.5"
                        key={key}
                      >
                        <span className="min-w-0 flex-1 text-sm">
                          {DISCOVERY_SOURCE_LABELS[key]}
                        </span>
                        <Switch
                          checked={enabled}
                          disabled={locked}
                          onCheckedChange={() =>
                            setEnabledSources(
                              (current) =>
                                toggleSource(
                                  { mode: sourceMode, order: current },
                                  key,
                                ).order,
                            )
                          }
                        />
                        {locked ? (
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
              <h2 className="text-base font-semibold">Advanced Criteria</h2>
              <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Must have
              </p>
              <CriteriaRow
                checked={mustMatchLocation}
                label="Must be in the specified location"
                onCheckedChange={setMustMatchLocation}
              />
              <CriteriaRow
                checked={mustMatchRole}
                label="Must match the selected role or title"
                onCheckedChange={setMustMatchRole}
              />
              <p className="pt-2 text-2xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Nice to have
              </p>
              <CriteriaRow
                checked={hasEmail}
                label="Has a verified email address"
                onCheckedChange={setHasEmail}
              />
              <CriteriaRow
                checked={hasLinkedIn}
                label="Has a LinkedIn profile"
                onCheckedChange={setHasLinkedIn}
              />
              <CriteriaRow
                checked={hasCompany}
                label="Has a current company"
                onCheckedChange={setHasCompany}
              />
            </section>

            <label
              className="space-y-2 text-sm font-medium"
              htmlFor="people-campaign-name"
            >
              Campaign name
              <Input
                id="people-campaign-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </label>
            <label
              className="space-y-2 text-sm font-medium"
              htmlFor="people-campaign-description"
            >
              Campaign details{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
              <Input
                id="people-campaign-description"
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the ideal person"
                value={description}
              />
            </label>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <SheetFooter className="gap-2 border-t border-border px-8 py-6">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={submitting} type="submit">
              {submitting ? <Loader2 className="animate-spin" /> : null}Create
              Campaign
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
