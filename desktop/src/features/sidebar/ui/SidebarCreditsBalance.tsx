import { useQuery } from "@tanstack/react-query";
import { ChevronRight, LoaderCircle, WalletCards } from "lucide-react";

import { useGlobalAgentConfig } from "@/features/agents/useGlobalAgentConfig";
import type { SettingsSection } from "@/features/settings/ui/SettingsPanels";
import {
  formatNanousdAsUsd,
  getColonyCreditsAccount,
  getColonyCreditsStatus,
} from "@/shared/api/tauriProvisionedCredits";
import { cn } from "@/shared/lib/cn";

export function SidebarCreditsBalance({
  onOpenSettings,
}: {
  onOpenSettings: (section?: SettingsSection) => void;
}) {
  const { globalConfig } = useGlobalAgentConfig();
  const enabled = globalConfig.credential_mode === "colony_credits";
  const accountQuery = useQuery({
    enabled,
    queryFn: getColonyCreditsAccount,
    queryKey: ["colonyCreditsAccount"],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  if (!enabled) return null;

  const status = accountQuery.data
    ? getColonyCreditsStatus(accountQuery.data.balance_nanousd)
    : null;
  const label = accountQuery.isPending
    ? "Credits loading"
    : accountQuery.isError || !accountQuery.data
      ? "Balance unavailable"
      : `Credits ${formatNanousdAsUsd(accountQuery.data.balance_nanousd)}`;

  return (
    <button
      aria-label={`${label}. Open Colony Credits settings`}
      className={cn(
        "mt-2 flex w-full items-center gap-2 rounded-lg border border-sidebar-border/55 px-2.5 py-1.5 text-xs text-sidebar-foreground/75 transition-colors hover:bg-sidebar-border/35 hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden",
        status === "depleted" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
      )}
      data-testid="sidebar-credits-balance"
      onClick={(event) => {
        event.stopPropagation();
        onOpenSettings("agents");
      }}
      type="button"
    >
      {accountQuery.isPending ? (
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        <WalletCards aria-hidden="true" className="size-3.5" />
      )}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <ChevronRight aria-hidden="true" className="size-3.5 opacity-60" />
    </button>
  );
}
