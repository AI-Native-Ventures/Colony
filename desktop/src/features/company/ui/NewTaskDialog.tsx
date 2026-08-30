import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { ChannelCombobox } from "@/features/workflows/ui/ChannelCombobox";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

import { createTaskFromForm } from "@/features/company/createTask";
import type { CompanyTask } from "@/features/company/contracts";
import {
  MAX_TASK_TITLE_LEN,
  validateNewTaskInput,
} from "@/features/company/newTaskModel";

const FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";
const FIELD_CONTROL_CLASS =
  "border-0 bg-transparent shadow-none outline-none ring-0 placeholder:text-muted-foreground/55 focus-visible:ring-0";

type NewTaskDialogProps = {
  channels: Channel[];
  /** Pre-select a channel (e.g. the one the user is currently in). Empty when none applies. */
  defaultChannelId?: string | null;
  onCreated: (task: CompanyTask) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/**
 * "New task" - a Task created by hand, outside of chat and outside an
 * initiative kickoff. Channel and title only: the backend fills in every
 * other field (owning team, cost centre, QA persona, status) with its own
 * defaults, and `CompanyTask` has no description field to fill in anyway.
 */
export function NewTaskDialog({
  channels,
  defaultChannelId,
  onCreated,
  onOpenChange,
  open,
}: NewTaskDialogProps) {
  const [channelId, setChannelId] = React.useState(defaultChannelId ?? "");
  const [title, setTitle] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  // Minted once per genuine create attempt, reused across retries of that
  // same attempt (a rejected submit, a lost receipt), cleared whenever the
  // dialog opens fresh - reusing it across two different attempts would ask
  // the backend to update the first Task instead of creating a second.
  const requestIdRef = React.useRef<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: {
      channelId: string;
      title: string;
      requestId: string;
    }) => createTaskFromForm(input),
  });

  React.useEffect(() => {
    if (!open) return;
    setChannelId(defaultChannelId ?? "");
    setTitle("");
    setErrorMessage(null);
    requestIdRef.current = null;
    const timerId = globalThis.setTimeout(() => {
      titleInputRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open, defaultChannelId]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createMutation.isPending) return;

    const validation = validateNewTaskInput({ channelId, title });
    if (!validation.ok) {
      setErrorMessage(validation.message);
      return;
    }
    setErrorMessage(null);
    if (!requestIdRef.current) {
      requestIdRef.current = crypto.randomUUID();
    }

    try {
      const task = await createMutation.mutateAsync({
        channelId,
        title: validation.title,
        requestId: requestIdRef.current,
      });
      toast.success("Task created.");
      onCreated(task);
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create task.",
      );
    }
  }

  const isCreating = createMutation.isPending;
  const canSubmit = channelId !== "" && title.trim().length > 0 && !isCreating;

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
        data-testid="new-task-dialog"
        description="Create a task directly. It starts at Ready, owned by the coordination team by default."
        footer={
          <div className="flex w-full justify-end">
            <Button
              data-testid="new-task-submit"
              disabled={!canSubmit}
              form="new-task-form"
              type="submit"
            >
              {isCreating ? "Creating…" : "Create task"}
            </Button>
          </div>
        }
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        title="New task"
      >
        <form
          className="space-y-5"
          id="new-task-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="new-task-channel"
            >
              Channel
            </label>
            <ChannelCombobox
              channels={channels}
              disabled={isCreating}
              id="new-task-channel"
              onChange={(value) => {
                setChannelId(value);
                setErrorMessage(null);
              }}
              value={channelId}
            />
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="new-task-title"
            >
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
                data-testid="new-task-title"
                disabled={isCreating}
                id="new-task-title"
                maxLength={MAX_TASK_TITLE_LEN}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder="What needs to get done"
                ref={titleInputRef}
                value={title}
              />
            </div>
          </div>

          {errorMessage ? (
            <p
              className="text-sm text-destructive"
              data-testid="new-task-error"
            >
              {errorMessage}
            </p>
          ) : null}
        </form>
      </ChooserDialogContent>
    </Dialog>
  );
}
