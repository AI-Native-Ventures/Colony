import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

import { formatNanousd } from "../contracts";
import type { CommercialPurpose } from "../contracts";
import {
  COMMERCIAL_PURPOSE_LABELS,
  COMMERCIAL_PURPOSE_OPTIONS,
  type CorrectionRequest,
  correctionProblem,
} from "../corrections";
import type { LedgerEntry } from "../report";

/**
 * Charging one call to the part of the company that actually incurred it.
 *
 * The dialog states plainly that nothing is overwritten, because that is the
 * property that makes this safe to use: the original classification survives
 * and the correction is appended, so a wrong correction is itself
 * correctable and the history stays readable.
 */

/**
 * A labelled control.
 *
 * The label is bound by `htmlFor` rather than by wrapping, so the
 * association survives the control being nested for layout and a screen
 * reader announces the right name.
 */
function Field({
  children,
  hint,
  htmlFor,
  label,
}: {
  children: React.ReactNode;
  hint?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="block">
      <label
        className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
        htmlFor={htmlFor}
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? (
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

export function CorrectionDialog({
  entry,
  isSubmitting,
  onOpenChange,
  onSubmit,
  submitError,
}: {
  entry: LedgerEntry | null;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: CorrectionRequest) => void;
  submitError: Error | null;
}) {
  const [companyId, setCompanyId] = React.useState("");
  const [costCentreId, setCostCentreId] = React.useState("");
  const [owningTeamId, setOwningTeamId] = React.useState("");
  const [commercialPurpose, setCommercialPurpose] =
    React.useState<CommercialPurpose>("internalProduct");
  const [clientOrganizationId, setClientOrganizationId] = React.useState("");
  const [taskId, setTaskId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const fieldId = React.useId();

  // Reopening for a different entry must not carry the previous answers
  // over; a correction filed against the wrong record is hard to notice.
  const eventId = entry?.eventId ?? null;
  React.useEffect(() => {
    if (!eventId) return;
    const existing = entry?.effectiveAssignment ?? null;
    setCompanyId(existing?.companyId ?? "");
    setCostCentreId(existing?.costCentreId ?? "");
    setOwningTeamId(existing?.owningTeamId ?? "");
    setCommercialPurpose(existing?.commercialPurpose ?? "internalProduct");
    setClientOrganizationId(existing?.clientOrganizationId ?? "");
    setTaskId(existing?.taskId ?? "");
    setReason("");
  }, [entry, eventId]);

  if (!entry) return null;

  const request: CorrectionRequest = {
    clientOrganizationId: clientOrganizationId || null,
    commercialPurpose,
    companyId,
    costCentreId,
    owningTeamId,
    reason,
    taskId: taskId || null,
    usageRecordEventId: entry.eventId,
  };
  const problem = correctionProblem(request);

  return (
    <Dialog onOpenChange={onOpenChange} open={entry !== null}>
      <DialogContent
        className="max-w-lg"
        data-testid="ledger-correction-dialog"
      >
        <DialogHeader>
          <DialogTitle>Attribute this spend</DialogTitle>
          <DialogDescription>
            {entry.model ?? entry.provider} on {entry.day}
            {entry.costNanousd === null
              ? ", cost not yet known"
              : `, ${formatNanousd(entry.costNanousd)}`}
            . The original record is never changed: this is recorded alongside
            it, and the ledger applies it when it computes spend.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field htmlFor={`${fieldId}-company`} label="Company">
            <Input
              onChange={(event) => setCompanyId(event.target.value)}
              id={`${fieldId}-company`}
              placeholder="horizon-labs"
              value={companyId}
            />
          </Field>
          <Field htmlFor={`${fieldId}-cost-centre`} label="Cost centre">
            <Input
              onChange={(event) => setCostCentreId(event.target.value)}
              id={`${fieldId}-cost-centre`}
              placeholder="web-delivery"
              value={costCentreId}
            />
          </Field>
          <Field htmlFor={`${fieldId}-team`} label="Owning team">
            <Input
              onChange={(event) => setOwningTeamId(event.target.value)}
              id={`${fieldId}-team`}
              placeholder="web-team"
              value={owningTeamId}
            />
          </Field>
          <Field
            hint="Client delivery becomes cost of delivery in the accounts; everything else is operating expense."
            htmlFor={`${fieldId}-purpose`}
            label="Commercial purpose"
          >
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              id={`${fieldId}-purpose`}
              onChange={(event) =>
                setCommercialPurpose(event.target.value as CommercialPurpose)
              }
              value={commercialPurpose}
            >
              {COMMERCIAL_PURPOSE_OPTIONS.map((purpose) => (
                <option key={purpose} value={purpose}>
                  {COMMERCIAL_PURPOSE_LABELS[purpose]}
                </option>
              ))}
            </select>
          </Field>
          {commercialPurpose === "clientDelivery" ? (
            <Field htmlFor={`${fieldId}-client`} label="Client">
              <Input
                onChange={(event) =>
                  setClientOrganizationId(event.target.value)
                }
                id={`${fieldId}-client`}
                placeholder="tennant-group"
                value={clientOrganizationId}
              />
            </Field>
          ) : null}
          <Field htmlFor={`${fieldId}-task`} label="Task (optional)">
            <Input
              id={`${fieldId}-task`}
              onChange={(event) => setTaskId(event.target.value)}
              value={taskId}
            />
          </Field>
          <Field
            hint="Kept with the correction, permanently."
            htmlFor={`${fieldId}-reason`}
            label="Reason"
          >
            <Textarea
              id={`${fieldId}-reason`}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Was billable client work, misfiled as internal."
              rows={3}
              value={reason}
            />
          </Field>
        </div>

        {submitError ? (
          <p className="text-sm text-destructive" role="alert">
            {submitError.message}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            data-testid="ledger-correction-submit"
            disabled={problem !== null || isSubmitting}
            onClick={() => onSubmit(request)}
            title={problem ?? undefined}
            type="button"
          >
            {isSubmitting ? "Recording…" : "Record correction"}
          </Button>
        </DialogFooter>
        {problem ? (
          <p className="text-xs text-muted-foreground">{problem}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
