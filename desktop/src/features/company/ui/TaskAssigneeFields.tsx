import type { AssigneeOption } from "@/features/company/taskAssignees";
import { cn } from "@/shared/lib/cn";
import { Checkbox } from "@/shared/ui/checkbox";

const FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";

type TaskAssigneeFieldsProps = {
  assigneePersonaId: string;
  disabled: boolean;
  onAssigneeChange: (personaId: string) => void;
  onWatchersChange: (personaIds: string[]) => void;
  options: AssigneeOption[];
  watcherPersonaIds: string[];
};

/**
 * "Who does this" and "who else should see it" for the New task dialog.
 *
 * Split out of `NewTaskDialog` so the dialog stays under the file-size
 * ratchet, and because the empty case carries its own explanation: with no
 * team personas there is nobody to assign to, and saying so beats an empty
 * dropdown that looks broken.
 */
export function TaskAssigneeFields({
  assigneePersonaId,
  disabled,
  onAssigneeChange,
  onWatchersChange,
  options,
  watcherPersonaIds,
}: TaskAssigneeFieldsProps) {
  const watchers = new Set(watcherPersonaIds);
  const watcherOptions = options.filter(
    (option) => option.personaId !== assigneePersonaId,
  );

  function toggleWatcher(personaId: string, checked: boolean) {
    const next = new Set(watchers);
    if (checked) next.add(personaId);
    else next.delete(personaId);
    onWatchersChange([...next]);
  }

  if (options.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="new-task-no-assignees"
      >
        Nobody on a team yet, so there is nobody to give this to. Add an agent
        to a team from the org chart on the Agents page first.
      </p>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="new-task-assignee"
        >
          Assign to
        </label>
        <div
          className={cn("flex min-h-11 items-center px-3", FIELD_SHELL_CLASS)}
        >
          <select
            className="h-8 w-full bg-transparent text-sm outline-hidden"
            data-testid="new-task-assignee"
            disabled={disabled}
            id="new-task-assignee"
            onChange={(event) => onAssigneeChange(event.target.value)}
            value={assigneePersonaId}
          >
            <option value="">Choose who does this</option>
            {options.map((option) => (
              <option key={option.personaId} value={option.personaId}>
                {option.pubkey
                  ? option.label
                  : `${option.label} (not deployed)`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-sm font-medium text-foreground">
          Also mention <span className="text-muted-foreground">(optional)</span>
        </span>
        <div
          className={cn("max-h-40 overflow-y-auto p-2", FIELD_SHELL_CLASS)}
          data-testid="new-task-watchers"
        >
          {watcherOptions.length === 0 ? (
            <p className="px-1 py-1 text-sm text-muted-foreground">
              Nobody else to mention.
            </p>
          ) : (
            watcherOptions.map((option) => (
              <div
                className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-muted/60"
                key={option.personaId}
              >
                <Checkbox
                  checked={watchers.has(option.personaId)}
                  disabled={disabled}
                  id={`new-task-watcher-${option.personaId}`}
                  onCheckedChange={(checked) =>
                    toggleWatcher(option.personaId, checked === true)
                  }
                />
                <label
                  className="truncate"
                  htmlFor={`new-task-watcher-${option.personaId}`}
                >
                  {option.label}
                </label>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
