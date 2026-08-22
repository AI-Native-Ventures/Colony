import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

import type { BlockQuestionOption } from "../../contracts";
import {
  resolveQuestionOptions,
  type QuestionOptionsResult,
} from "../../questionOptions";
import type { BlockActionEnvironment, BlockQuestionNode } from "./types";
import { resolveBlockTemplate } from "./resolvers";

export { resolveQuestionOptions } from "../../questionOptions";

export function resolveQuestionSubmission({
  customInput,
  node,
  options = node.options ?? [],
  selected,
}: {
  customInput: string;
  node: BlockQuestionNode;
  options?: readonly BlockQuestionOption[];
  selected: ReadonlySet<string>;
}):
  | { ok: true; input: { selected: string[]; custom_input?: string } }
  | { ok: false; reason: string } {
  const knownOptions = new Set(options.map((option) => option.id));
  const chosen = [...selected].filter((id) => knownOptions.has(id));
  if (chosen.length < node.min_selections) {
    return {
      ok: false,
      reason: `Choose at least ${node.min_selections} option${node.min_selections === 1 ? "" : "s"}.`,
    };
  }
  if (chosen.length > node.max_selections) {
    return {
      ok: false,
      reason: `Choose no more than ${node.max_selections} options.`,
    };
  }
  const custom = customInput.trim();
  if (node.require_custom_input && custom === "") {
    return { ok: false, reason: "Add a short explanation before submitting." };
  }
  return {
    ok: true,
    input:
      custom === ""
        ? { selected: chosen }
        : { selected: chosen, custom_input: custom },
  };
}

export function BlockQuestion({
  data,
  environment,
  node,
}: {
  data?: unknown;
  environment?: BlockActionEnvironment;
  node: BlockQuestionNode;
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [customInput, setCustomInput] = React.useState("");
  const [localPending, setLocalPending] = React.useState(false);
  const optionsResult: QuestionOptionsResult = React.useMemo(
    () => resolveQuestionOptions(node, data),
    [data, node],
  );
  const options = optionsResult.ok ? optionsResult.options : [];
  const prompt = resolveBlockTemplate(node.prompt, data);
  const submission = resolveQuestionSubmission({
    customInput,
    node,
    options,
    selected,
  });
  const actionDeclared =
    environment?.declaredActionIds.has(node.submit_action) ?? false;
  const completed =
    environment?.completedActionIds?.has(node.submit_action) ?? false;
  const answered =
    completed || environment?.pendingActionId === node.submit_action;
  const disabledReason =
    environment?.disabledReason ??
    (!optionsResult.ok
      ? optionsResult.reason
      : !environment?.trusted
        ? "This question is disabled because its publisher is not trusted."
        : !actionDeclared
          ? "This question references an undeclared action."
          : undefined);
  const disabled = Boolean(disabledReason) || localPending || answered;

  const toggle = (id: string) => {
    if (disabled) return;
    setSelected((current) => {
      if (node.mode === "single-select") return new Set([id]);
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < node.max_selections) {
        next.add(id);
      }
      return next;
    });
  };

  const submit = async () => {
    if (!submission.ok || disabled || !environment?.submitSigned) return;
    setLocalPending(true);
    try {
      await environment.submitSigned(
        {
          type: "signed",
          action_id: node.submit_action,
          resolves_attention:
            environment.resolvingActionIds?.has(node.submit_action) ?? false,
        },
        submission.input,
      );
    } finally {
      setLocalPending(false);
    }
  };

  return (
    <fieldset
      className="space-y-3"
      data-block-primitive="question"
      disabled={disabled}
    >
      <legend className="text-sm font-medium text-foreground">{prompt}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const active = selected.has(option.id);
          return (
            <button
              aria-pressed={active}
              className={cn(
                "flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                active
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border/70 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground",
              )}
              key={option.id}
              onClick={() => toggle(option.id)}
              type="button"
            >
              <span className="min-w-0">
                <span className="block font-medium text-foreground">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {active ? <Check aria-hidden="true" className="size-4" /> : null}
            </button>
          );
        })}
      </div>
      {node.allow_custom ? (
        <Textarea
          aria-label="Something else"
          disabled={disabled}
          onChange={(event) => setCustomInput(event.target.value)}
          placeholder={
            node.require_custom_input
              ? "Add a short explanation…"
              : "Something else (optional)…"
          }
          rows={2}
          value={customInput}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || !submission.ok}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {answered ? "Answered" : localPending ? "Submitting…" : "Submit"}
        </Button>
        {disabledReason ? (
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
        ) : !answered && !submission.ok ? (
          <p className="text-xs text-muted-foreground">{submission.reason}</p>
        ) : null}
      </div>
    </fieldset>
  );
}
