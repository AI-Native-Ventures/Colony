import * as React from "react";
import { toast } from "sonner";

import { companyRepository } from "@/features/company/companyRepository";
import type { CompanyProfile, CostCentre } from "@/features/company/contracts";
import { companyActionBroker } from "@/features/company/workRepository";
import { useCommunities } from "@/features/communities/useCommunities";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import { signCommunityProfileUpdate } from "@/shared/api/companyProfileEdit";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Skeleton } from "@/shared/ui/skeleton";
import { Textarea } from "@/shared/ui/textarea";
import { SettingsOptionGroup } from "./SettingsOptionGroup";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

/**
 * The community's own business details: what it trades as, what it sells, and
 * the cost centres work charges against.
 *
 * Every community has a profile from the moment it exists, so this is always
 * editing something rather than creating it. Before this existed the only
 * writer was an agent interview with no trigger, which meant a workspace
 * whose interview never ran had no way to set a cost centre at all — and a
 * Task cannot be created without one.
 */
export function CompanySettingsCard() {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const relaySelfQuery = useRelaySelfQuery(communityId !== "");

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [profile, setProfile] = React.useState<CompanyProfile | null>(null);
  const [headEventId, setHeadEventId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    const result = await companyRepository.getActiveCompanyHead();
    if (result.ok) {
      setProfile(result.value.profile);
      setHeadEventId(result.value.headEventId);
      setError(null);
    } else {
      setProfile(null);
      setError(result.message);
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    if (communityId === "") return;
    void load();
  }, [communityId, load]);

  const relayPubkey = relaySelfQuery.data ?? null;
  const canSave =
    profile !== null && headEventId !== null && relayPubkey !== null && !saving;

  const save = async () => {
    if (!canSave || !profile || !headEventId || !relayPubkey) return;
    setSaving(true);
    try {
      const signed = await signCommunityProfileUpdate({
        profile: { ...profile, updatedAt: Math.floor(Date.now() / 1000) },
        expectedHeadEventId: headEventId,
        relayPubkey,
        requestId: crypto.randomUUID(),
      });
      const outcome = await companyActionBroker.submit(signed);
      if (outcome.status === "applied") {
        toast.success("Company details saved.");
        await load();
        return;
      }
      // A conflict means the profile changed between the read and the save —
      // an agent filling it in, or another window. Reloading is the only
      // honest answer: overwriting would discard what actually landed.
      if (outcome.status === "conflict") {
        toast.error("Someone else changed this. Reloaded the latest version.");
        await load();
        return;
      }
      toast.error(outcome.message);
    } catch (thrown) {
      toast.error(
        thrown instanceof Error ? thrown.message : "That didn't go through.",
      );
    } finally {
      setSaving(false);
    }
  };

  const patch = (next: Partial<CompanyProfile>) =>
    setProfile((current) => (current ? { ...current, ...next } : current));

  const patchCostCentre = (index: number, next: Partial<CostCentre>) =>
    setProfile((current) =>
      current
        ? {
            ...current,
            costCentres: current.costCentres.map((centre, position) =>
              position === index ? { ...centre, ...next } : centre,
            ),
          }
        : current,
    );

  return (
    <div data-testid="company-settings">
      <SettingsSectionHeader
        description="What this workspace trades as, and the cost centres its work is charged to."
        title="Company"
      />

      {loading ? <Skeleton className="h-64 rounded-2xl" /> : null}

      {!loading && !profile ? (
        <SettingsOptionGroup title="Company details">
          <p
            className="text-sm text-muted-foreground"
            data-testid="company-settings-error"
          >
            {error ?? "This community has no profile yet."}
          </p>
          <Button
            className="mt-3"
            onClick={() => void load()}
            size="sm"
            variant="outline"
          >
            Try again
          </Button>
        </SettingsOptionGroup>
      ) : null}

      {!loading && profile ? (
        <div className="flex flex-col gap-6">
          <SettingsOptionGroup
            description="The name this workspace does business as."
            title="Identity"
          >
            <div className="flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="company-trading-name"
              >
                Trading name
              </label>
              <Input
                data-testid="company-trading-name"
                id="company-trading-name"
                onChange={(event) => patch({ tradingName: event.target.value })}
                value={profile.tradingName}
              />
            </div>
            <div className="mt-3 flex flex-col gap-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="company-summary"
              >
                What the business does
              </label>
              <Textarea
                className="min-h-20"
                data-testid="company-summary"
                id="company-summary"
                onChange={(event) => patch({ summary: event.target.value })}
                placeholder="One or two sentences. Agents read this to understand the work."
                value={profile.summary}
              />
            </div>
          </SettingsOptionGroup>

          <SettingsOptionGroup
            description="Work is charged to one of these. A task cannot be created without one."
            title="Cost centres"
          >
            <div
              className="flex flex-col gap-3"
              data-testid="company-cost-centres"
            >
              {profile.costCentres.map((centre, index) => (
                <div className="flex items-center gap-2" key={centre.id}>
                  <Input
                    aria-label={`Cost centre name for ${centre.id}`}
                    onChange={(event) =>
                      patchCostCentre(index, { name: event.target.value })
                    }
                    value={centre.name}
                  />
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {centre.id}
                  </span>
                </div>
              ))}
            </div>
          </SettingsOptionGroup>

          <div>
            <Button
              data-testid="company-settings-save"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
