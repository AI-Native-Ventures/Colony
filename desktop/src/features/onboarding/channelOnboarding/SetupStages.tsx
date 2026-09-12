import {
  Bookmark,
  Check,
  CircleAlert,
  GitBranch,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Pin,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef } from "react";

import type {
  ScoutApproveSetup,
  ScoutOnboardingDispatch,
  ScoutOnboardingState,
  ScoutSetupInput,
  ScoutSetupProof,
} from "./types";
import { getScoutOnboardingSummary, getScoutSetupInput } from "./selectors";
import {
  Actions,
  BackAction,
  Field,
  InlineCard,
  OpenQuestions,
  OwnerBoundary,
  PrimaryAction,
  SecondaryAction,
  StageFrame,
} from "./shared";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

export function SetupStage({
  state,
  onChange,
  onApproveSetup,
  onRetry,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
  onApproveSetup: ScoutApproveSetup;
  onRetry?: ScoutApproveSetup;
}) {
  const input = getScoutSetupInput(state);
  const nameId = useId();
  const descriptionId = useId();
  const requestCounter = useRef(0);
  const attemptInFlight = useRef(false);

  if (!input) {
    return (
      <StageFrame
        scoutMessage="Confirm your editable understanding before reviewing a workspace setup."
        state={state}
      >
        <InlineCard eyebrow="Workspace setup" icon={LockKeyhole}>
          <div className="flex items-start gap-2 rounded-lg bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            <LockKeyhole
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            <span>Workspace setup opens only after owner confirmation.</span>
          </div>
          <Actions>
            <BackAction
              onClick={() =>
                onChange({ type: "go-back", stage: "understanding" })
              }
            >
              Return to understanding
            </BackAction>
          </Actions>
        </InlineCard>
      </StageFrame>
    );
  }

  const draft = state.setupDrafts[input.route];
  const begin = async (retry: boolean) => {
    if (attemptInFlight.current || state.setup.phase === "saving") return;
    attemptInFlight.current = true;
    const snapshot: ScoutSetupInput = state.setup.input ?? input;
    const requestId =
      retry && state.setup.requestId
        ? state.setup.requestId
        : createSetupRequestId(++requestCounter.current);
    onChange({ type: "approve-setup-started", requestId });
    try {
      const callback = retry ? (onRetry ?? onApproveSetup) : onApproveSetup;
      const proof = await callback(snapshot, requestId);
      onChange({
        type: "approve-setup-succeeded",
        requestId,
        proof: validProof(proof),
      });
    } catch (error) {
      onChange({
        type: "approve-setup-failed",
        requestId,
        error:
          error instanceof Error ? error.message : "Setup could not be saved.",
      });
    } finally {
      attemptInFlight.current = false;
    }
  };

  return (
    <StageFrame
      ownerMessage={input.summary.businessOrIdea || "Context still open"}
      scoutMessage="Now that you have confirmed the understanding, here is the smallest workspace setup that fits it."
      state={state}
    >
      <InlineCard
        description="This saves the context you reviewed and keeps future work in conversations and threads."
        eyebrow="Workspace setup"
        icon={LayoutDashboard}
        title="Keep the workspace simple."
      >
        <div className="grid gap-3">
          <Field
            help="Editable before saving. Leave unnamed when a name is not useful yet."
            htmlFor={nameId}
            label="Workspace context name"
          >
            <Input
              id={nameId}
              maxLength={120}
              onChange={(event) =>
                onChange({
                  type: "set-setup-draft",
                  field: "name",
                  value: event.target.value,
                })
              }
              placeholder="Leave unnamed for now."
              value={input.setupName}
            />
          </Field>
          <Field
            help="Context only; it does not create a task."
            htmlFor={descriptionId}
            label="Context Scout carries"
          >
            <Textarea
              id={descriptionId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-setup-draft",
                  field: "description",
                  value: event.target.value,
                })
              }
              placeholder="The confirmed context Scout should keep close."
              value={input.setupDescription}
            />
          </Field>
        </div>

        <SetupBoundary />
        <OpenQuestions
          items={input.summary.unknowns.map((item) => ({
            label: item,
            detail: "Unknown for now",
          }))}
        />
        <OwnerBoundary>
          Approving this proposal saves the context you reviewed so Scout can
          use it in the Welcome conversation.
        </OwnerBoundary>
        <Actions>
          <BackAction
            onClick={() =>
              onChange({ type: "go-back", stage: "understanding" })
            }
          >
            Change the understanding
          </BackAction>
          <PrimaryAction onClick={() => void begin(false)}>
            Approve this workspace setup
          </PrimaryAction>
        </Actions>
        {draft.nameEdited || draft.descriptionEdited ? (
          <p className="mt-2 text-2xs text-muted-foreground">
            Your edits are kept verbatim.
          </p>
        ) : null}
      </InlineCard>
    </StageFrame>
  );
}

function SetupBoundary() {
  return (
    <div className="grid gap-2 border-t border-border/60 pt-3">
      {[
        [
          "Keep #welcome for talking with Scout.",
          "The existing Welcome channel stays in place.",
        ],
        [
          "Keep the context you reviewed nearby.",
          "Your answers remain easy to find.",
        ],
        [
          "Keep future work in its own thread.",
          "Decisions and results stay together.",
        ],
        [
          "Keep Scout as your guide.",
          "You can add help later when it makes sense.",
        ],
      ].map(([title, detail]) => (
        <div className="flex items-start gap-2 text-xs" key={title}>
          <Check
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
          <span>
            <strong className="font-medium text-foreground">{title}</strong>
            <small className="mt-0.5 block text-2xs text-muted-foreground">
              {detail}
            </small>
          </span>
        </div>
      ))}
      <p className="text-2xs text-muted-foreground">
        Nothing starts automatically here. You choose what to do next.
      </p>
    </div>
  );
}

export function SettingUpStage({
  state,
  onChange,
  onApproveSetup,
  onRetry,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
  onApproveSetup: ScoutApproveSetup;
  onRetry?: ScoutApproveSetup;
}) {
  const requestCounter = useRef(0);
  const attemptInFlight = useRef(false);
  const retry = async () => {
    if (attemptInFlight.current || state.setup.phase === "saving") return;
    attemptInFlight.current = true;
    const snapshot = state.setup.input ?? getScoutSetupInput(state);
    if (!snapshot) {
      onChange({ type: "go-back", stage: "understanding" });
      attemptInFlight.current = false;
      return;
    }
    const requestId =
      state.setup.requestId ?? createSetupRequestId(++requestCounter.current);
    onChange({ type: "approve-setup-started", requestId });
    try {
      const proof = await (onRetry ?? onApproveSetup)(snapshot, requestId);
      onChange({
        type: "approve-setup-succeeded",
        requestId,
        proof: validProof(proof),
      });
    } catch (error) {
      onChange({
        type: "approve-setup-failed",
        requestId,
        error:
          error instanceof Error ? error.message : "Setup could not be saved.",
      });
    } finally {
      attemptInFlight.current = false;
    }
  };
  const isError = state.setup.phase === "error";
  const input = state.setup.input ?? getScoutSetupInput(state);
  return (
    <StageFrame
      ownerMessage={input?.summary.businessOrIdea || "Confirmed understanding"}
      scoutMessage={
        isError
          ? "Your context could not be saved yet. Your answers are still here."
          : "I’m saving the context you reviewed so Scout can use it in Welcome."
      }
      state={state}
    >
      <InlineCard
        description="This may take a moment. You can retry if something gets in the way."
        eyebrow="Saving your context"
        icon={isError ? CircleAlert : LoaderCircle}
        title={isError ? "Let’s try that again." : "Saving your context"}
      >
        <ProgressRow
          detail={
            isError
              ? state.setup.error || "Your context was not saved."
              : "Preparing Scout for your next conversation."
          }
          icon={isError ? CircleAlert : LoaderCircle}
          title={isError ? "Your context needs another try" : "Preparing Scout"}
          active={!isError}
        />
        {isError ? (
          <p
            className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300"
            role="alert"
          >
            <strong className="font-medium text-foreground">
              We couldn’t save your context.
            </strong>{" "}
            Check your connection and try again.
          </p>
        ) : null}
        <OwnerBoundary>
          Your answers stay here while Scout prepares your Welcome conversation.
        </OwnerBoundary>
        <Actions>
          {isError ? (
            <PrimaryAction onClick={() => void retry()}>
              Retry setup
            </PrimaryAction>
          ) : null}
          <SecondaryAction
            onClick={() => onChange({ type: "go-back", stage: "setup" })}
          >
            Return to workspace setup
          </SecondaryAction>
        </Actions>
      </InlineCard>
    </StageFrame>
  );
}

function ProgressRow({
  title,
  detail,
  icon: Icon,
  active,
}: {
  title: string;
  detail: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5 border-b border-border/60 py-3 last:border-b-0">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon
          aria-hidden="true"
          className={`size-3.5 ${active ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
      </span>
      <span className="grid gap-0.5">
        <strong className="text-xs font-medium text-foreground">{title}</strong>
        <small className="text-2xs text-muted-foreground">{detail}</small>
      </span>
    </div>
  );
}

export function ReadyStage({
  state,
  onContinueInWelcome,
}: {
  state: ScoutOnboardingState;
  onContinueInWelcome?: () => void;
}) {
  const input = state.setup.input;
  const summary = input?.summary ?? getScoutOnboardingSummary(state);
  const proof = state.setup.proof;
  if (state.setup.phase !== "ready" || !proof || !summary) {
    return (
      <StageFrame
        scoutMessage="The workspace is still being prepared."
        state={state}
      >
        <InlineCard eyebrow="Workspace not ready" icon={CircleAlert}>
          <p className="text-xs text-muted-foreground">
            Scout will appear here after your context has been saved.
          </p>
        </InlineCard>
      </StageFrame>
    );
  }

  const unknown = summary.unknowns.length
    ? summary.unknowns.join(" · ")
    : "Nothing new is open yet.";
  return (
    <StageFrame
      ownerMessage={summary.businessOrIdea || "Confirmed understanding"}
      scoutMessage="Your Colony workspace is ready. Scout is here in #welcome with the context you approved."
      state={state}
    >
      <InlineCard
        eyebrow="Context saved"
        icon={Pin}
        title="Ready for the next conversation."
      >
        <div className="grid gap-3 bg-primary/10 p-3.5">
          <div className="flex items-start gap-2">
            <Bookmark
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            <div>
              <strong className="text-sm font-medium text-foreground">
                {input?.setupName || "Your workspace context"}
              </strong>
              <small className="mt-0.5 block text-2xs text-muted-foreground">
                Visible to Scout in this workspace
              </small>
            </div>
          </div>
          <dl className="m-0 grid gap-2">
            <Fact
              label="Business or idea"
              value={summary.businessOrIdea || "Still open"}
            />
            <Fact
              label="What matters now"
              value={summary.priority || "Still open"}
            />
            <Fact label="Still unknown" value={unknown} />
            {summary.location ? (
              <Fact label="Area" value={summary.location} />
            ) : null}
            {summary.website ? (
              <Fact label="Website" value={summary.website} />
            ) : null}
          </dl>
        </div>
        <div className="mt-3 grid border-t border-border/60">
          <OrientationRow
            detail="Add context or decide what matters next when you are ready."
            icon={MessageCircle}
            title="Talk to Scout in #welcome."
          />
          <OrientationRow
            detail="Keep decisions and results with the conversation that produced them."
            icon={GitBranch}
            title="Give future work its own thread."
          />
          <OrientationRow
            detail="Nothing starts until you choose what to do next."
            icon={LockKeyhole}
            title="You stay in control."
          />
        </div>
        <OwnerBoundary>
          Your reviewed context is saved. Start the next conversation in Welcome
          when you are ready.
        </OwnerBoundary>
        <Actions>
          <PrimaryAction onClick={onContinueInWelcome}>
            Continue in #welcome
          </PrimaryAction>
        </Actions>
      </InlineCard>
    </StageFrame>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 border-b border-foreground/10 pb-2 text-xs last:border-b-0 last:pb-0 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 break-words text-foreground">{value}</dd>
    </div>
  );
}

function OrientationRow({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-border/60 py-2.5 last:border-b-0">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-primary"
      />
      <span>
        <strong className="text-xs font-medium text-foreground">{title}</strong>
        <small className="mt-0.5 block text-2xs text-muted-foreground">
          {detail}
        </small>
      </span>
    </div>
  );
}

function createSetupRequestId(attempt: number) {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) return randomUUID;

  // Match crypto.randomUUID's shape so the saved setup action can use the
  // request identity unchanged.
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    const seed = Date.now() + attempt;
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (seed + index * 47) & 0xff;
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function validProof(value: ScoutSetupProof): ScoutSetupProof {
  return typeof value?.proofId === "string" ? value : { proofId: "" };
}
