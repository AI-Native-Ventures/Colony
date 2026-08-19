import * as React from "react";

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

export type CreateProjectWorkItemDialogInput = {
  title: string;
  body: string;
};

export function CreateProjectWorkItemDialog({
  bodyPlaceholder,
  children,
  description,
  isCreating,
  itemName,
  onCreate,
  onOpenChange,
  open,
  submitDisabled = false,
  title,
  titlePlaceholder,
}: {
  bodyPlaceholder: string;
  children?: React.ReactNode;
  description: string;
  isCreating: boolean;
  itemName: "issue" | "pull-request";
  onCreate: (input: CreateProjectWorkItemDialogInput) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  submitDisabled?: boolean;
  title: string;
  titlePlaceholder: string;
}) {
  const [workItemTitle, setWorkItemTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const submitInFlightRef = React.useRef(false);
  const testIdPrefix = `create-${itemName}`;
  const itemLabel = itemName === "issue" ? "issue" : "pull request";

  React.useEffect(() => {
    if (!open) return;
    setWorkItemTitle("");
    setBody("");
    setErrorMessage(null);
    // Deferred so it wins against the dialog's own mount-time focus handling.
    // Only take focus if nothing inside the dialog has it yet: by the time this
    // fires the user may already be typing in the description, and yanking the
    // caret back mid-word loses their text into the title. That is also what
    // made project-pr-review.spec.ts flaky, with a subject tag that read
    // "Document the broken workflowThe project workflow needs a clear repair
    // path." (CI run 32153129885).
    const timerId = globalThis.setTimeout(() => {
      const title = titleInputRef.current;
      const active = title?.ownerDocument.activeElement ?? null;
      // Stand down only if the user is already typing in another FIELD. The
      // dialog itself takes focus on open (Radix focuses its content), so
      // checking "is focus anywhere inside the dialog" would cancel the very
      // autofocus this timer exists for.
      const typingElsewhere =
        active !== null &&
        active !== title &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement ||
          (active as HTMLElement).isContentEditable);
      if (typingElsewhere) return;
      title?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating || submitDisabled || submitInFlightRef.current) return;
    const trimmedTitle = workItemTitle.trim();
    if (!trimmedTitle) return;
    submitInFlightRef.current = true;
    setErrorMessage(null);
    try {
      await onCreate({ title: trimmedTitle, body: body.trim() });
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : `Failed to create ${itemLabel}.`,
      );
    } finally {
      submitInFlightRef.current = false;
    }
  }

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
        data-testid={`${testIdPrefix}-dialog`}
        description={description}
        footer={
          <div className="flex w-full justify-end">
            <Button
              data-testid={`${testIdPrefix}-submit`}
              disabled={
                isCreating ||
                submitDisabled ||
                workItemTitle.trim().length === 0
              }
              form={`${testIdPrefix}-form`}
              type="submit"
            >
              {isCreating ? "Creating…" : `Create ${itemLabel}`}
            </Button>
          </div>
        }
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        title={title}
      >
        <form
          className="space-y-5"
          id={`${testIdPrefix}-form`}
          onSubmit={(event) => void handleSubmit(event)}
        >
          {children}
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={`${testIdPrefix}-title`}
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
                data-testid={`${testIdPrefix}-title`}
                disabled={isCreating}
                id={`${testIdPrefix}-title`}
                maxLength={256}
                onChange={(event) => {
                  setWorkItemTitle(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder={titlePlaceholder}
                ref={titleInputRef}
                value={workItemTitle}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={`${testIdPrefix}-body`}
            >
              Description
              <span className="ml-1 text-xs font-normal text-muted-foreground/50">
                Optional
              </span>
            </label>
            <div className={FIELD_SHELL_CLASS}>
              <Textarea
                className={cn(
                  "min-h-28 resize-y px-3 py-3",
                  FIELD_CONTROL_CLASS,
                )}
                data-testid={`${testIdPrefix}-body`}
                disabled={isCreating}
                id={`${testIdPrefix}-body`}
                onChange={(event) => {
                  setBody(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder={bodyPlaceholder}
                value={body}
              />
            </div>
          </div>
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}
        </form>
      </ChooserDialogContent>
    </Dialog>
  );
}
