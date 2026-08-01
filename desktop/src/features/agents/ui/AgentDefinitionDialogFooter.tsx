import { Button } from "@/shared/ui/button";

export type SecondaryAction = {
  label: string;
  onSelect: () => void;
};

type AgentDefinitionDialogFooterProps = {
  canSubmit: boolean;
  isAvatarUploadPending: boolean;
  isPending: boolean;
  onCancel: () => void;
  publishesCatalogUpdates: boolean;
  secondaryAction?: SecondaryAction;
  submitBlockReason: string | null;
  submitLabel: string;
};

export function AgentDefinitionDialogFooter({
  canSubmit,
  isAvatarUploadPending,
  isPending,
  onCancel,
  publishesCatalogUpdates,
  secondaryAction,
  submitBlockReason,
  submitLabel,
}: AgentDefinitionDialogFooterProps) {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3">
      <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-3">
        {submitBlockReason ? (
          <p
            className="text-2xs text-muted-foreground"
            data-testid="persona-dialog-submit-reason"
          >
            {submitBlockReason}
          </p>
        ) : null}
        {publishesCatalogUpdates ? (
          <p
            className="max-w-sm text-xs text-muted-foreground"
            data-testid="persona-dialog-catalog-publish-notice"
          >
            This agent is in the community catalog. Your changes will be
            published when you save.
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {secondaryAction ? (
          <Button
            disabled={isPending || isAvatarUploadPending}
            onClick={secondaryAction.onSelect}
            type="button"
            variant="ghost"
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          disabled={isPending || isAvatarUploadPending}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          data-testid="persona-dialog-submit"
          disabled={!canSubmit}
          form="persona-dialog-form"
          type="submit"
        >
          {isPending
            ? "Saving..."
            : isAvatarUploadPending
              ? "Uploading..."
              : publishesCatalogUpdates
                ? "Save and publish"
                : submitLabel}
        </Button>
      </div>
    </div>
  );
}
