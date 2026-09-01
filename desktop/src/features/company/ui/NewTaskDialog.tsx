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

import {
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import { useTeamsQuery } from "@/features/agents/teamHooks";
import { createTaskFromForm } from "@/features/company/createTask";
import type { CompanyTask } from "@/features/company/contracts";
import {
  MAX_TASK_TITLE_LEN,
  validateNewTaskInput,
} from "@/features/company/newTaskModel";
import {
  buildAssigneeOptions,
  buildKickoffMessage,
} from "@/features/company/taskAssignees";
import { TaskAssigneeFields } from "@/features/company/ui/TaskAssigneeFields";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useSendMessageMutation } from "@/features/messages/hooks";

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
 * initiative kickoff. The backend fills in owning team, cost centre, QA
 * persona and status with its own defaults, and `CompanyTask` has no
 * description field to fill in.
 *
 * An assignee is asked for rather than defaulted. `plan_user_task` accepts an
 * empty assignee list, so a task created without one is stored, listed, and
 * never done by anyone - a state nothing downstream reports as wrong.
 * Creating an assigned task also posts a kickoff message mentioning them,
 * because an agent only acts on a turn it was mentioned in.
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
  const [assigneePersonaId, setAssigneePersonaId] = React.useState("");
  const [watcherPersonaIds, setWatcherPersonaIds] = React.useState<string[]>(
    [],
  );
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const personasQuery = usePersonasQuery({ enabled: open });
  const teamsQuery = useTeamsQuery();
  const agentsQuery = useManagedAgentsQuery({ enabled: open });
  const identityQuery = useIdentityQuery();
  const assigneeOptions = React.useMemo(
    () =>
      buildAssigneeOptions(
        personasQuery.data,
        teamsQuery.data,
        agentsQuery.data,
      ),
    [personasQuery.data, teamsQuery.data, agentsQuery.data],
  );
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
      assigneePersonaId: string;
      requestId: string;
    }) => createTaskFromForm(input),
  });
  const sendMessageMutation = useSendMessageMutation(
    null,
    identityQuery.data ?? undefined,
  );

  React.useEffect(() => {
    if (!open) return;
    setChannelId(defaultChannelId ?? "");
    setTitle("");
    setAssigneePersonaId("");
    setWatcherPersonaIds([]);
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

    const validation = validateNewTaskInput({
      channelId,
      title,
      assigneePersonaId,
      watcherPersonaIds,
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
      const task = await createMutation.mutateAsync({
        channelId,
        title: validation.title,
        assigneePersonaId: validation.assigneePersonaId,
        requestId: requestIdRef.current,
      });
      const assignee = assigneeOptions.find(
        (option) => option.personaId === validation.assigneePersonaId,
      );
      const kickoff = assignee
        ? buildKickoffMessage(
            validation.title,
            assignee,
            assigneeOptions.filter((option) =>
              validation.watcherPersonaIds.includes(option.personaId),
            ),
          )
        : null;
      if (kickoff) {
        // The task is already recorded. A kickoff that fails to send leaves
        // work nobody was told about, which is worth saying out loud, but it
        // is not a reason to report the create itself as failed.
        try {
          await sendMessageMutation.mutateAsync({
            channelId,
            content: kickoff.content,
            mentionPubkeys: kickoff.mentionPubkeys,
          });
          toast.success("Task created and assigned.");
        } catch {
          toast.warning(
            "Task created, but nobody could be notified. Mention them in the channel to start it.",
          );
        }
      } else {
        toast.success(
          "Task created. Its assignee has no deployed agent yet, so nothing will start until one is.",
        );
      }
      onCreated(task);
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create task.",
      );
    }
  }

  const isCreating = createMutation.isPending || sendMessageMutation.isPending;
  const canSubmit =
    channelId !== "" &&
    title.trim().length > 0 &&
    assigneePersonaId !== "" &&
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
        data-testid="new-task-dialog"
        description="Create a task directly. It starts at Ready and its assignee is mentioned in the channel so they can pick it up."
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

          <TaskAssigneeFields
            assigneePersonaId={assigneePersonaId}
            disabled={isCreating}
            onAssigneeChange={(personaId) => {
              setAssigneePersonaId(personaId);
              setWatcherPersonaIds((current) =>
                current.filter((id) => id !== personaId),
              );
              setErrorMessage(null);
            }}
            onWatchersChange={(personaIds) => {
              setWatcherPersonaIds(personaIds);
              setErrorMessage(null);
            }}
            options={assigneeOptions}
            watcherPersonaIds={watcherPersonaIds}
          />

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
