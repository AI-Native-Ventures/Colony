import { Check, PencilLine, Store } from "lucide-react";
import { useId, type ReactNode } from "react";

import type {
  ExistingWebsiteState,
  ScoutOnboardingDispatch,
  ScoutOnboardingState,
} from "./types";
import {
  Actions,
  BackAction,
  ContextNote,
  Field,
  InlineCard,
  NoWebsiteNotice,
  OptionButton,
  PrimaryAction,
  ScoutLinkButton,
  StageFrame,
} from "./shared";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

const PRIORITIES = [
  { id: "customers" as const, label: "Get more customers" },
  { id: "delivery" as const, label: "Make delivery easier" },
  { id: "next" as const, label: "Decide what to do next" },
  { id: "other" as const, label: "Something else to discuss" },
];

function WebsiteDetail({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.existing;
  const websiteId = useId();
  const isProvided = route.websiteState === "provided" && route.website.trim();
  const showEditor = route.websiteEditing || route.websiteState === "unknown";

  if (route.websiteState === "none" && !route.websiteEditing) {
    return (
      <div className="grid gap-2">
        <NoWebsiteNotice />
        <ScoutLinkButton
          onClick={() =>
            onChange({ type: "set-existing-website-editing", value: true })
          }
        >
          Add a website
        </ScoutLinkButton>
      </div>
    );
  }

  if (isProvided && !route.websiteEditing) {
    return (
      <ContextNote>
        <strong className="font-medium text-foreground">
          Website supplied earlier
        </strong>
        <code className="mt-1 block break-words text-foreground">
          {route.website}
        </code>
        <span className="mt-1 block text-2xs">
          Prepared for confirmation only. Scout will not inspect it here.
        </span>
        <span className="mt-2 block">
          <ScoutLinkButton
            onClick={() =>
              onChange({ type: "set-existing-website-editing", value: true })
            }
          >
            Use a different website
          </ScoutLinkButton>
        </span>
      </ContextNote>
    );
  }

  if (!showEditor) return null;
  return (
    <div className="grid gap-2">
      <Field
        help="A website is optional. Scout will treat it as a detail you provide."
        htmlFor={websiteId}
        label="Website (optional)"
      >
        <Input
          id={websiteId}
          maxLength={240}
          onChange={(event) =>
            onChange({
              type: "set-existing-answer",
              field: "website",
              value: event.target.value,
            })
          }
          placeholder="https://your-business.example"
          type="url"
          value={route.website}
        />
      </Field>
      <Actions>
        <ButtonLike
          onClick={() =>
            onChange({ type: "set-existing-website-editing", value: false })
          }
        >
          Save website detail
        </ButtonLike>
        <ScoutLinkButton
          onClick={() =>
            onChange({ type: "set-existing-website-state", value: "none" })
          }
        >
          I don&apos;t have one
        </ScoutLinkButton>
      </Actions>
    </div>
  );
}

function ButtonLike({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/70 bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function ExistingPersonStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.existing;
  const businessId = useId();
  const personId = useId();
  const hasBusiness = route.business.trim().length > 0;
  return (
    <StageFrame
      ownerMessage={route.person ? route.person : undefined}
      scoutMessage="Is this the business we’re setting up?"
      state={state}
    >
      <InlineCard
        description="Scout will reuse the business details already supplied, then ask what you want to change first."
        eyebrow="Existing business"
        icon={Store}
      >
        {route.businessEditing || !hasBusiness ? (
          <div className="grid gap-2">
            <Field
              help="Only the details shown here are carried forward."
              htmlFor={businessId}
              label="Business details from earlier onboarding"
            >
              <Textarea
                id={businessId}
                maxLength={1200}
                onChange={(event) =>
                  onChange({
                    type: "set-existing-answer",
                    field: "business",
                    value: event.target.value,
                  })
                }
                placeholder="Tell Scout which business you mean, in your own words."
                value={route.business}
              />
            </Field>
            <Actions>
              <ButtonLike
                onClick={() =>
                  onChange({
                    type: "set-existing-business-editing",
                    value: false,
                  })
                }
              >
                Save business details
              </ButtonLike>
            </Actions>
          </div>
        ) : (
          <ContextNote>
            <strong className="font-medium text-foreground">
              Business details supplied earlier
            </strong>
            <span className="mt-1 block break-words">{route.business}</span>
            <span className="mt-1 block text-2xs">
              Review these details before confirming the route.
            </span>
            <span className="mt-2 block">
              <ScoutLinkButton
                onClick={() =>
                  onChange({
                    type: "set-existing-business-editing",
                    value: true,
                  })
                }
              >
                Edit business details
              </ScoutLinkButton>
            </span>
          </ContextNote>
        )}

        <div className="mt-4 grid gap-3">
          <WebsiteDetail onChange={onChange} state={state} />
          <Field
            help="This remains optional and editable."
            htmlFor={personId}
            label="About you (optional)"
          >
            <Textarea
              id={personId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-existing-answer",
                  field: "person",
                  value: event.target.value,
                })
              }
              placeholder="What should Scout keep in view about you as the owner?"
              value={route.person}
            />
          </Field>
        </div>

        <Actions>
          <BackAction
            onClick={() => onChange({ type: "go-back", stage: "arrival" })}
          />
          <PrimaryAction
            disabled={!hasBusiness}
            onClick={() => onChange({ type: "confirm-existing" })}
          >
            Yes, this is the business
          </PrimaryAction>
        </Actions>
      </InlineCard>
    </StageFrame>
  );
}

export function ExistingBusinessStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.existing;
  const goalId = useId();
  if (!route.confirmed) {
    return (
      <StageFrame
        scoutMessage="Confirm the existing business details before continuing."
        state={state}
      >
        <InlineCard eyebrow="Existing business" icon={Store}>
          <ContextNote>
            Return to the previous question and confirm the business context.
          </ContextNote>
          <Actions>
            <BackAction
              onClick={() => onChange({ type: "go-back", stage: "person" })}
            >
              Return to business confirmation
            </BackAction>
          </Actions>
        </InlineCard>
      </StageFrame>
    );
  }
  return (
    <StageFrame
      ownerMessage={route.business}
      scoutMessage="What would you like this business to change or improve first?"
      state={state}
    >
      <InlineCard
        description="Use your own words. Scout will use the later choice to organize the review."
        eyebrow="Current priority"
        icon={Store}
      >
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ type: "advance-existing-business" });
          }}
        >
          <Field
            help="A priority choice comes next; leave this open when you do not have more detail yet."
            htmlFor={goalId}
            label="What matters now (optional)"
          >
            <Textarea
              id={goalId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-existing-answer",
                  field: "goal",
                  value: event.target.value,
                })
              }
              placeholder="What would you like to change, improve, or understand?"
              value={route.goal}
            />
          </Field>
          <Actions>
            <BackAction
              onClick={() => onChange({ type: "go-back", stage: "person" })}
            />
            <PrimaryAction type="submit">Continue to priorities</PrimaryAction>
          </Actions>
        </form>
      </InlineCard>
    </StageFrame>
  );
}

export function ExistingFollowUpStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.existing;
  return (
    <StageFrame
      ownerMessage={route.goal || "No current priority shared yet."}
      scoutMessage="What should change first, if anything?"
      state={state}
    >
      <InlineCard
        description="Choose the outcome that matters most right now; Scout will carry the rest as open."
        eyebrow="Useful priority"
        icon={Store}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {PRIORITIES.map(({ id, label }) => (
            <OptionButton
              icon={id === "other" ? PencilLine : Check}
              key={id}
              label={label}
              onClick={() =>
                onChange({
                  type: "set-existing-answer",
                  field: "priority",
                  value: id,
                })
              }
              selected={route.priority === id}
            />
          ))}
        </div>
        <Actions>
          <BackAction
            onClick={() => onChange({ type: "go-back", stage: "business" })}
          />
          <PrimaryAction
            disabled={!route.priority}
            onClick={() => onChange({ type: "advance-existing-follow-up" })}
          >
            Review the understanding
          </PrimaryAction>
        </Actions>
      </InlineCard>
    </StageFrame>
  );
}

export function websiteStateLabel(state: ExistingWebsiteState) {
  return state === "provided"
    ? "supplied"
    : state === "none"
      ? "not supplied"
      : "open";
}
