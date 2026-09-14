import type * as React from "react";
import { X } from "lucide-react";

import type { CompanyTask } from "@/features/company/contracts";
import {
  ArtifactRow,
  DetailRow,
  keyedArtifacts,
} from "@/features/company/ui/TaskDetailSheet";
import { useTaskThreadContext } from "@/features/company/useTaskThreadContext";
import { shortIdLabel } from "@/features/company/workListModel";
import type { TaskExecutionState } from "@/features/company/taskThreadModel";
import { AssigneeChip } from "@/features/factory/ui/BoardTileColumns";
import { buildMessageLink } from "@/features/messages/lib/messageLink";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";

/**
 * The board's right pane: one ticket, read live.
 *
 * The card that opened it holds the task as the board list saw it; this pane
 * re-reads that task and its run through `useTaskThreadContext`, so a ticket
 * left open while an agent works on it keeps up rather than freezing at the
 * moment it was clicked. The rows are `TaskDetailSheet`'s own, imported
 * rather than copied, so a fact never reads differently in the two places.
 */
export function BoardTileDetail({
  channelId,
  channelName,
  execution,
  onClose,
  task: seedTask,
}: {
  channelId: string;
  channelName: string;
  execution: TaskExecutionState;
  onClose: () => void;
  task: CompanyTask;
}): React.JSX.Element {
  // A task opened outside a thread (created by hand on the board) has no
  // thread root; its source event is the next best anchor, and an empty
  // string simply reads back no run.
  const threadId = seedTask.threadRoot ?? seedTask.sourceEventId ?? "";
  const { taskQuery, runQuery } = useTaskThreadContext({
    channelId,
    taskId: seedTask.id,
    threadId,
  });
  const live = taskQuery.data ?? null;
  const task = live ?? seedTask;
  const run = runQuery.data ?? null;
  const artifacts = run?.artifacts ?? [];

  return (
    <aside
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-background"
      data-task-id={task.id}
      data-testid="factory-board-detail"
    >
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            {task.title}
          </h2>
          <div className="mt-1 flex items-center gap-1.5">
            {task.assigneePersonaIds.map((personaId) => (
              <AssigneeChip key={personaId} personaId={personaId} />
            ))}
            {task.assigneePersonaIds.length === 0 ? (
              <span className="text-2xs text-muted-foreground">Unassigned</span>
            ) : null}
          </div>
        </div>
        <Button
          data-testid="factory-board-detail-close"
          onClick={onClose}
          size="xs"
          title="Close ticket"
          variant="ghost"
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      </div>

      <dl className="px-3">
        <DetailRow
          label="Accountable owner"
          value={shortIdLabel(task.owningTeamId)}
        />
        <DetailRow
          label="QA owner"
          value={
            task.qaPersonaId ? shortIdLabel(task.qaPersonaId) : "Owner review"
          }
        />
        <DetailRow label="Task state" value={task.status} />
        <DetailRow label="Execution" value={execution.label} />
        <DetailRow
          label="Expected deliverable"
          value={run?.instruction ?? task.title}
        />
        <DetailRow label="Task ID" value={task.id} />
      </dl>

      {artifacts.length > 0 ? (
        <section className="px-3 pb-3">
          <h3 className="text-sm font-semibold text-foreground">
            Delivery evidence
          </h3>
          <ul className="mt-2 space-y-2">
            {keyedArtifacts([...artifacts]).map(({ artifact, key }, index) => (
              <ArtifactRow
                artifact={artifact}
                key={key}
                primary={index === 0}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mx-3 mb-3 rounded-lg border border-border/70 p-3">
        <h3 className="text-sm font-semibold text-foreground">Thread</h3>
        <div className="mt-2 text-xs text-muted-foreground">
          {threadId === ""
            ? `#${channelName} · no thread yet`
            : `#${channelName} · thread ${threadId.slice(0, 12)}…`}
        </div>
        {threadId === "" ? null : (
          <Markdown
            className="mt-2 text-sm"
            content={`[Open the ticket thread](${buildMessageLink({
              channelId,
              messageId: threadId,
            })})`}
            interactive
          />
        )}
      </section>
    </aside>
  );
}
