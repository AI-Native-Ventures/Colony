import { TriangleAlert } from "lucide-react";

import type { BlockPermission } from "@/features/blocks/contracts";
import { cn } from "@/shared/lib/cn";

/**
 * The two facts about a Block that can change someone's mind before they press
 * one of its buttons: that the publisher is untrusted, and any capability the
 * Block asks for. Version, usage, publisher key, compatible clients and
 * primitive contracts are deliberately absent: they are protocol trivia to the
 * person making the decision, and belong in the workshop where a block is being
 * inspected rather than acted on.
 *
 * Used by the catalog shelf, the message timeline, and the Action Center so the
 * same disclosure appears wherever a decision is actually taken.
 */
export function BlockDisclosure({
  className,
  permissionLabels,
  untrusted,
}: {
  className?: string;
  permissionLabels: readonly string[];
  untrusted: boolean;
}) {
  if (!untrusted && permissionLabels.length === 0) return null;
  return (
    <div
      className={cn("space-y-1.5", className)}
      data-block-disclosure={untrusted ? "untrusted" : "capabilities"}
    >
      {untrusted ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          Untrusted publisher
        </p>
      ) : null}
      {permissionLabels.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Requires {permissionLabels.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/** Capability names a Block declares, in manifest order, without duplicates. */
export function blockPermissionLabels(
  permissions: readonly BlockPermission[],
): string[] {
  const labels: string[] = [];
  for (const permission of permissions) {
    const capability = permission.capability.trim();
    if (capability !== "" && !labels.includes(capability)) {
      labels.push(capability);
    }
  }
  return labels;
}
