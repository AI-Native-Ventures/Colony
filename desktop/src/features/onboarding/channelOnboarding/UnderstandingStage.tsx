import { FilePenLine } from "lucide-react";
import { useId } from "react";

import type {
  NewBusinessStage,
  ScoutOnboardingDispatch,
  ScoutOnboardingState,
  ScoutOnboardingSummary,
} from "./types";
import { DIRECTION_LABELS, STAGE_LABELS } from "./constants";
import { getScoutOnboardingSummary, scoutPriorityLabel } from "./selectors";
import {
  Actions,
  BackAction,
  ContextNote,
  Field,
  HistoryBlock,
  InlineCard,
  NoWebsiteNotice,
  OpenQuestions,
  OwnerBoundary,
  PrimaryAction,
  ScoutLinkButton,
  StageFrame,
} from "./shared";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

export function UnderstandingStage({
  state,
  onChange,
  onConfirm,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
  onConfirm?: (summary: ScoutOnboardingSummary) => void;
}) {
  const personId = useId();
  const ideaId = useId();
  const priorityId = useId();
  const stageId = useId();
  const locationId = useId();
  const websiteId = useId();
  if (!state.route) {
    return (
      <StageFrame
        scoutMessage="Choose one of the three starting points first."
        state={state}
      >
        <InlineCard eyebrow="Editable understanding" icon={FilePenLine}>
          <ContextNote>
            The route-specific intake appears after you choose a starting point.
          </ContextNote>
        </InlineCard>
      </StageFrame>
    );
  }

  const route = state.routes[state.route];
  const isNew = state.route === "new";
  const isExisting = state.route === "existing";
  const isDeciding = state.route === "deciding";
  const person = route.person;
  const businessOrIdea = isNew
    ? state.routes.new.edited.idea
      ? state.routes.new.idea
      : state.routes.new.idea || state.routes.new.description
    : isExisting
      ? state.routes.existing.business
      : state.routes.deciding.edited.direction
        ? state.routes.deciding.direction
        : (DIRECTION_LABELS[
            state.routes.deciding.direction as keyof typeof DIRECTION_LABELS
          ] ?? state.routes.deciding.direction);
  const priority = isDeciding
    ? scoutPriorityLabel(state.routes.deciding.priority)
    : "goal" in route
      ? route.edited.goal || route.edited.priority
        ? route.goal
        : scoutPriorityLabel(route.priority)
      : "";
  const summary = getScoutOnboardingSummary(state);
  const routeDetail = isNew
    ? `Category: ${state.routes.new.category || "not chosen yet"} · Idea stage: ${STAGE_LABELS[state.routes.new.ideaStage as NewBusinessStage] || "not chosen yet"}`
    : isExisting
      ? `Existing business confirmed · Website: ${state.routes.existing.websiteState === "provided" ? "supplied" : state.routes.existing.websiteState === "none" ? "not supplied" : "open"}`
      : `Starting points: ${state.routes.deciding.skills.length || "none"} · Direction: ${state.routes.deciding.direction || "not chosen yet"}`;

  return (
    <StageFrame
      ownerMessage={summary ? undefined : person || undefined}
      scoutMessage="Here is the understanding I would carry forward. Edit any line; an unknown stays unknown."
      state={state}
    >
      <HistoryBlock
        items={[
          { label: "Route", value: routeDetail },
          { label: "Priority", value: priority || "Not supplied" },
        ]}
      />
      <InlineCard
        description="This readback carries your answers forward. It does not create a business, add people, or start work."
        eyebrow="Editable understanding"
        icon={FilePenLine}
        title="What I understand so far"
      >
        <div className="grid gap-3">
          <ContextNote>
            <strong className="font-medium text-foreground">
              {state.route === "new"
                ? "Start a new business"
                : state.route === "existing"
                  ? "Help with my existing business"
                  : "Help me decide what to start"}
            </strong>
            <span className="mt-1 block text-2xs">{routeDetail}</span>
          </ContextNote>

          <Field
            help="Kept verbatim and still optional."
            htmlFor={personId}
            label="About you (optional)"
          >
            <Textarea
              id={personId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-understanding-answer",
                  field: "person",
                  value: event.target.value,
                })
              }
              placeholder="Add your background or motivation in your own words."
              value={person}
            />
          </Field>

          <Field
            help="Carried from the route-specific intake; leave it open when you are still exploring."
            htmlFor={ideaId}
            label={isDeciding ? "Possible direction" : "Business or idea"}
          >
            <Textarea
              aria-label="Business or idea in your words"
              id={ideaId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-understanding-answer",
                  field: "businessOrIdea",
                  value: event.target.value,
                })
              }
              placeholder="Add what you know, or leave it open for now."
              value={businessOrIdea}
            />
          </Field>

          {isNew ? (
            <>
              <Field
                help="Owner choice · kept editable."
                htmlFor={stageId}
                label="Idea stage"
              >
                <select
                  className="flex h-9 w-full rounded-lg border border-input/40 bg-background px-3 py-1 text-base text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
                  id={stageId}
                  onChange={(event) =>
                    onChange({
                      type: "set-understanding-answer",
                      field: "ideaStage",
                      value: event.target.value,
                    })
                  }
                  value={state.routes.new.ideaStage}
                >
                  <option value="">Choose one</option>
                  {(Object.keys(STAGE_LABELS) as NewBusinessStage[]).map(
                    (stage) => (
                      <option key={stage} value={stage}>
                        {STAGE_LABELS[stage]}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              <Field
                help="Leave blank to keep the area unknown."
                htmlFor={locationId}
                label="Area or location (optional)"
              >
                <Input
                  id={locationId}
                  maxLength={240}
                  onChange={(event) =>
                    onChange({
                      type: "set-understanding-answer",
                      field: "location",
                      value: event.target.value,
                    })
                  }
                  placeholder="Leave blank to keep the area unknown."
                  value={state.routes.new.location}
                />
              </Field>
            </>
          ) : null}

          {isExisting ? (
            <WebsiteReadback
              onChange={onChange}
              state={state}
              websiteId={websiteId}
            />
          ) : null}

          <Field
            help="Your priority, readiness, or motivation remains optional."
            htmlFor={priorityId}
            label="What matters now (optional)"
          >
            <Textarea
              id={priorityId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-understanding-answer",
                  field: "priority",
                  value: event.target.value,
                })
              }
              placeholder="What should Scout keep in view?"
              value={priority}
            />
          </Field>

          <OpenQuestions
            items={
              summary?.unknowns.map((item) => ({
                label: item,
                detail: "Unknown for now",
              })) ?? [
                {
                  label: "Finish the route choices",
                  detail: "Needed before confirmation",
                },
              ]
            }
          />
          <OwnerBoundary>
            Nothing has been created, staffed, or started. Workspace setup comes
            only after you confirm this readback.
          </OwnerBoundary>
        </div>
        <Actions>
          <BackAction
            onClick={() =>
              onChange({
                type: "go-back",
                stage:
                  state.route === "new" ||
                  state.route === "existing" ||
                  state.route === "deciding"
                    ? "follow-up"
                    : "person",
              })
            }
          >
            Correct an earlier answer
          </BackAction>
          <PrimaryAction
            disabled={!summary}
            onClick={() => {
              if (!summary) {
                onChange({ type: "confirm-understanding" });
                return;
              }
              onChange({ type: "confirm-understanding" });
              onConfirm?.(summary);
            }}
          >
            This looks right
          </PrimaryAction>
        </Actions>
      </InlineCard>
    </StageFrame>
  );
}

function WebsiteReadback({
  state,
  onChange,
  websiteId,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
  websiteId: string;
}) {
  const route = state.routes.existing;
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
  return (
    <Field
      help="Owner detail only. Scout will not inspect it here."
      htmlFor={websiteId}
      label="Website (optional)"
    >
      <Input
        id={websiteId}
        maxLength={240}
        onChange={(event) =>
          onChange({
            type: "set-understanding-answer",
            field: "website",
            value: event.target.value,
          })
        }
        placeholder="Leave blank if you do not have one."
        type="url"
        value={route.website}
      />
      <div className="mt-1.5">
        <ScoutLinkButton
          onClick={() =>
            onChange({ type: "set-existing-website-state", value: "none" })
          }
        >
          I don&apos;t have one
        </ScoutLinkButton>
      </div>
    </Field>
  );
}
