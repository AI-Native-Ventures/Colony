import { useState } from "react";
import { useMyRelayMembershipQuery } from "@/features/community-members/hooks";
import { Button } from "@/shared/ui/button";
import { openOperatorConsole } from "@/shared/api/operatorConsoleApi";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import {
  buttonLabel,
  checkingAccessMessage,
  consoleOpenErrorMessage,
  isOperatorRole,
  noAccessMessage,
} from "./operatorConsole";

/**
 * Operator console launcher: opens the deployment admin dashboard (users,
 * communities, analytics) in its own window, authenticated with this desktop
 * identity. The relay's operator allowlist remains the real authority; this
 * gate only avoids showing a button that would end in a 401.
 */
export function OperatorConsoleCard() {
  const membershipQuery = useMyRelayMembershipQuery();
  const role = membershipQuery.data?.role;
  const isOperator = isOperatorRole(role);

  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    setOpening(true);
    openOperatorConsole()
      .catch((cause: unknown) => {
        setError(consoleOpenErrorMessage(cause));
      })
      .finally(() => {
        setOpening(false);
      });
  };

  return (
    <section className="min-w-0" data-testid="settings-operator-console">
      <SettingsSectionHeader
        title="Admin console"
        description="Open the deployment admin dashboard to see community and people metrics. Visible to community admins only."
      />

      {!isOperator ? (
        membershipQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">
            {checkingAccessMessage()}
          </p>
        ) : (
          <p className="rounded-lg border border-dashed border-border/70 bg-background/40 px-3 py-6 text-center text-sm text-muted-foreground">
            {noAccessMessage()}
          </p>
        )
      ) : (
        <div className="space-y-2">
          <Button
            data-testid="operator-console-open"
            disabled={opening}
            onClick={open}
            variant="outline"
          >
            {buttonLabel(opening)}
          </Button>
          <p className="text-xs text-muted-foreground/70" data-settings-subcopy>
            Opens in a separate window and signs you in with this identity. No
            extension or key paste needed.
          </p>
          {error ? (
            <p
              className="text-xs text-destructive"
              data-testid="operator-console-error"
            >
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
