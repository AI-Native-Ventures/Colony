import * as React from "react";
import { Building2, Check, Coins, Loader2, MapPin } from "lucide-react";

import {
  formatNanousdAsUsd,
  getColonyCreditsAccount,
} from "@/shared/api/tauriProvisionedCredits";
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
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import {
  approvedCampaignBudgetNanousd,
  formatDiscoveryNanousd,
} from "../data/campaignBudget";
import type { DiscoveryEntitlement } from "../entitlement";
import type { CampaignDetail, Vertical } from "../types";
import { DISCOVERY_LIGHT_SURFACE_STYLE } from "./discoverySurfaceStyle";

export type CreateCampaignSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
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
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [availableBalanceNanousd, setAvailableBalanceNanousd] = React.useState<
    string | null
  >(null);
  const [balanceStatus, setBalanceStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const liveBusinessPhase = entitlement?.experience === "live";
  const loadBalance = React.useCallback(() => {
    let active = true;
    setBalanceStatus("loading");
    setAvailableBalanceNanousd(null);
    void getColonyCreditsAccount()
      .then((account) => {
        if (active) {
          setAvailableBalanceNanousd(account.available_balance_nanousd);
          setBalanceStatus("ready");
        }
      })
      .catch(() => {
        if (active) setBalanceStatus("error");
      });
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setName(defaultCampaignName(vertical));
    setLocation("");
    setTarget("50");
    setDescription("");
    setHasWebsite(true);
    setHasPhone(true);
    setHasEmail(true);
    setError(null);
  }, [open, vertical]);

  React.useEffect(() => {
    if (!open || !liveBusinessPhase) {
      setAvailableBalanceNanousd(null);
      setBalanceStatus("idle");
      return;
    }
    return loadBalance();
  }, [liveBusinessPhase, loadBalance, open]);

  const targetNumber = Math.max(0, Number.parseInt(target, 10) || 0);
  const targetValid = targetNumber >= 1 && targetNumber <= 500;
  const approvedBudget = targetValid
    ? formatDiscoveryNanousd(approvedCampaignBudgetNanousd(targetNumber))
    : null;
  const availableBalance = availableBalanceNanousd
    ? formatNanousdAsUsd(availableBalanceNanousd)
    : null;
  const balanceBelowApproval = (() => {
    if (!availableBalanceNanousd || targetNumber < 1 || targetNumber > 500) {
      return false;
    }
    try {
      return (
        BigInt(availableBalanceNanousd) <
        BigInt(approvedCampaignBudgetNanousd(targetNumber))
      );
    } catch {
      return false;
    }
  })();

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
    if (targetNumber > 500) {
      setError("Choose a lead target of 500 or fewer.");
      return;
    }
    if (
      liveBusinessPhase &&
      (balanceStatus !== "ready" || balanceBelowApproval)
    ) {
      setError(
        balanceBelowApproval
          ? "Top up Colony Credits before approving this Campaign."
          : "Colony Credits could not be confirmed. Try again before approving.",
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
                  max="500"
                  aria-describedby={
                    targetValid ? undefined : "discovery-target-error"
                  }
                  aria-invalid={!targetValid}
                  onChange={(event) => setTarget(event.target.value)}
                  type="number"
                  value={target}
                />
                <span className="text-sm text-muted-foreground">
                  per location
                </span>
              </div>
              {!targetValid ? (
                <p
                  className="mt-2 text-sm text-destructive"
                  id="discovery-target-error"
                  role="alert"
                >
                  Choose 1 to 500 leads.
                </p>
              ) : null}
            </section>

            <section className="rounded-2xl border border-primary/25 bg-primary/5 p-4">
              <div className="flex gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-background text-primary">
                  <Coins aria-hidden="true" className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">
                      {liveBusinessPhase ? "Campaign budget" : "Preview only"}
                    </p>
                    <span className="text-sm font-semibold text-primary">
                      {liveBusinessPhase
                        ? approvedBudget
                          ? `Up to ${approvedBudget}`
                          : "Choose 1 to 500 leads"
                        : "No Credits"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {liveBusinessPhase
                      ? "Colony charges 5¢ only for each newly retained, deduplicated lead. Failed requests and duplicate leads are not charged. Colony chooses and funds the data source."
                      : "This demo uses sample data and never approves or spends Colony Credits."}
                  </p>
                  {liveBusinessPhase && approvedBudget ? (
                    <p className="mt-2 text-sm font-medium text-foreground">
                      Creating this Campaign approves exactly {approvedBudget}{" "}
                      in Colony Credits.
                    </p>
                  ) : null}
                  {availableBalance ? (
                    <p
                      className={`mt-1 text-sm ${
                        balanceBelowApproval
                          ? "font-medium text-amber-700 dark:text-amber-300"
                          : "text-muted-foreground"
                      }`}
                    >
                      Credits balance: {availableBalance}
                      {balanceBelowApproval
                        ? ". Top up before this Campaign can be approved and run."
                        : ". Active Campaign reservations reduce the amount available to spend."}
                    </p>
                  ) : null}
                  {balanceStatus === "loading" ? (
                    <p
                      className="mt-2 text-sm text-muted-foreground"
                      role="status"
                    >
                      <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                      Checking Colony Credits...
                    </p>
                  ) : null}
                  {balanceStatus === "error" ? (
                    <div className="mt-2 flex items-center gap-2" role="alert">
                      <p className="text-sm font-medium text-destructive">
                        Colony Credits could not be confirmed.
                      </p>
                      <Button
                        onClick={() => loadBalance()}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

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
            <Button
              disabled={
                submitting ||
                !targetValid ||
                (liveBusinessPhase &&
                  (balanceStatus !== "ready" || balanceBelowApproval))
              }
              type="submit"
            >
              {submitting ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : null}
              {liveBusinessPhase
                ? approvedBudget
                  ? `Create and approve ${approvedBudget}`
                  : "Choose 1 to 500 leads"
                : "Create Campaign"}
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
