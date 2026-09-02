import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { createInitiativeFromForm } from "@/features/company/createInitiative";
import type { CostCentre, Initiative } from "@/features/company/contracts";
import {
  MAX_INITIATIVE_TITLE_LEN,
  validateNewInitiativeInput,
} from "@/features/company/newInitiativeModel";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

const FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";
const FIELD_CONTROL_CLASS =
  "border-0 bg-transparent shadow-none outline-none ring-0 placeholder:text-muted-foreground/55 focus-visible:ring-0";
const SELECT_CLASS =
  "h-11 w-full rounded-xl border border-input bg-muted/40 px-3 text-sm transition-colors hover:border-muted-foreground/40 focus-visible:border-muted-foreground/50 focus-visible:outline-none";
const LABEL_CLASS = "text-sm font-medium text-foreground";

type NewInitiativeDialogProps = {
  /** Channels the caller is a member of. One of them hosts the initiative. */
  channels: Channel[];
  costCentres: CostCentre[];
  onCreated: (initiative: Initiative) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/**
 * "New initiative" - a body of work an owner names in their own words,
 * rather than one blueprint approval or a template fan-out proposes.
 *
 * It is created `proposed`, not started: describing work is not committing to
 * it, and starting it is a separate owner decision on the initiative's own
 * card. A cost centre is asked for rather than defaulted, because the
 * backend's fallback is the company's internal centre and a client project
 * charged to overhead is wrong in a way nothing downstream reports.
 */
export function NewInitiativeDialog({
  channels,
  costCentres,
  onCreated,
  onOpenChange,
  open,
}: NewInitiativeDialogProps) {
  const [channelId, setChannelId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [summary, setSummary] = React.useState("");
  const [costCentreId, setCostCentreId] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  // Minted once per genuine create attempt and reused across retries of that
  // same attempt, so a resubmit after a lost receipt asks for the same
  // initiative rather than starting a second one.
  const requestIdRef = React.useRef<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: {
      channelId: string;
      title: string;
      summary: string;
      costCentreId: string;
      requestId: string;
    }) => createInitiativeFromForm(input),
  });
  const isCreating = createMutation.isPending;

  React.useEffect(() => {
    if (!open) return;
    setChannelId("");
    setTitle("");
    setSummary("");
    setCostCentreId("");
    setErrorMessage(null);
    requestIdRef.current = null;
    const timerId = globalThis.setTimeout(() => {
      titleInputRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating) return;

    const validation = validateNewInitiativeInput({
      channelId,
      title,
      summary,
      costCentreId,
    });
    if (!validation.ok) {
      setErrorMessage(validation.message);
      return;
    }
    setErrorMessage(null);
    if (!requestIdRef.current) {
      requestIdRef.current = crypto.randomUUID();
    }

    try {
      const initiative = await createMutation.mutateAsync({
        channelId: validation.channelId,
        title: validation.title,
        summary,
        costCentreId: validation.costCentreId,
        requestId: requestIdRef.current,
      });
      toast.success("Initiative proposed. Start it when you are ready.");
      onCreated(initiative);
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create initiative.",
      );
    }
  }

  const canSubmit =
    channelId !== "" &&
    title.trim().length > 0 &&
    costCentreId !== "" &&
    !isCreating;

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isCreating) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <ChooserDialogContent
        className="max-w-lg"
        contentClassName="pt-3"
        data-testid="new-initiative-dialog"
        description="Name a body of work. It starts as proposed, and starting it is a separate decision."
        footer={
          <div className="flex w-full justify-end">
            <Button
              data-testid="new-initiative-submit"
              disabled={!canSubmit}
              form="new-initiative-form"
              type="submit"
            >
              {isCreating ? "Creating…" : "Create initiative"}
            </Button>
          </div>
        }
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        title="New initiative"
      >
        <form
          className="space-y-5"
          id="new-initiative-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className="space-y-1.5">
            <label className={LABEL_CLASS} htmlFor="new-initiative-title">
              Title
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                FIELD_SHELL_CLASS,
              )}
            >
              <Input
                className={cn("h-8 px-0", FIELD_CONTROL_CLASS)}
                data-testid="new-initiative-title"
                disabled={isCreating}
                id="new-initiative-title"
                maxLength={MAX_INITIATIVE_TITLE_LEN}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder="What body of work is this"
                ref={titleInputRef}
                value={title}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className={LABEL_CLASS} htmlFor="new-initiative-summary">
              Description
            </label>
            <Textarea
              className={cn("min-h-20 px-3 py-2", FIELD_SHELL_CLASS)}
              data-testid="new-initiative-summary"
              disabled={isCreating}
              id="new-initiative-summary"
              onChange={(event) => {
                setSummary(event.target.value);
                setErrorMessage(null);
              }}
              placeholder="What this covers, and what done looks like"
              value={summary}
            />
          </div>

          <div className="space-y-1.5">
            <label className={LABEL_CLASS} htmlFor="new-initiative-channel">
              Channel
            </label>
            <select
              className={SELECT_CLASS}
              data-testid="new-initiative-channel"
              disabled={isCreating}
              id="new-initiative-channel"
              onChange={(event) => {
                setChannelId(event.target.value);
                setErrorMessage(null);
              }}
              value={channelId}
            >
              <option value="">Choose a channel</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className={LABEL_CLASS} htmlFor="new-initiative-cost-centre">
              Cost centre
            </label>
            <select
              className={SELECT_CLASS}
              data-testid="new-initiative-cost-centre"
              disabled={isCreating}
              id="new-initiative-cost-centre"
              onChange={(event) => {
                setCostCentreId(event.target.value);
                setErrorMessage(null);
              }}
              value={costCentreId}
            >
              <option value="">Choose a cost centre</option>
              {costCentres.map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.name}
                </option>
              ))}
            </select>
          </div>

          {errorMessage ? (
            <p
              className="text-sm text-destructive"
              data-testid="new-initiative-error"
            >
              {errorMessage}
            </p>
          ) : null}
        </form>
      </ChooserDialogContent>
    </Dialog>
  );
}
