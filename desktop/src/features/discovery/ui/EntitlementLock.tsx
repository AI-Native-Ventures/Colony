import * as React from "react";
import { CheckCircle2, LockKeyhole, TriangleAlert } from "lucide-react";

import { canStartDiscovery, type DiscoveryEntitlement } from "../entitlement";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

export type EntitlementLockProps = {
  entitlement: DiscoveryEntitlement | null;
  onRun: () => void;
  onRetry?: () => void;
  actionLabel?: string;
  className?: string;
};

export function EntitlementLock({
  entitlement,
  onRun,
  onRetry,
  actionLabel = "Run discovery",
  className,
}: EntitlementLockProps) {
  const [open, setOpen] = React.useState(false);
  const state = entitlement?.state ?? "loading";

  if (canStartDiscovery({ state })) {
    return (
      <Button
        className={cn(
          "bg-foreground text-background hover:bg-foreground/90",
          className,
        )}
        onClick={onRun}
        type="button"
      >
        <CheckCircle2 aria-hidden="true" />
        {actionLabel}
      </Button>
    );
  }

  if (state === "loading") {
    return (
      <Button disabled type="button" variant="outline">
        <LockKeyhole aria-hidden="true" />
        Checking Discovery access…
      </Button>
    );
  }

  if (state === "error") {
    return (
      <div className="space-y-1.5">
        {onRetry ? (
          <Button onClick={onRetry} type="button" variant="outline">
            <TriangleAlert aria-hidden="true" />
            Retry Discovery access
          </Button>
        ) : (
          <Button disabled type="button" variant="outline">
            <TriangleAlert aria-hidden="true" />
            Discovery access unavailable
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          We could not confirm this workspace&apos;s entitlement.
        </p>
      </div>
    );
  }

  const planName = entitlement?.planName ?? "LAKA";
  return (
    <>
      <Button
        aria-haspopup="dialog"
        className={className}
        onClick={() => setOpen(true)}
        type="button"
        variant="outline"
      >
        <LockKeyhole aria-hidden="true" />
        Unlock with {planName}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          aria-describedby="discovery-entitlement-description"
          aria-labelledby="discovery-entitlement-title"
          role="dialog"
        >
          <DialogHeader>
            <DialogTitle id="discovery-entitlement-title">
              Discovery is part of {planName}
            </DialogTitle>
            <DialogDescription id="discovery-entitlement-description">
              This workspace can browse industries, verticals, and campaign
              setup. Activate the {planName} plan to run a discovery search.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
            Plan activation is handled outside this screen. No billing or
            checkout happens here.
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                aria-label="Close Discovery activation dialog"
                type="button"
                variant="outline"
              >
                Close
              </Button>
            </DialogClose>
            <Button disabled type="button">
              LAKA access required
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
