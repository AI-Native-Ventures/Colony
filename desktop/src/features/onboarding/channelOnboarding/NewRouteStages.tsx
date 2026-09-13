import {
  BriefcaseBusiness,
  Compass,
  MapPin,
  Monitor,
  Package,
  PencilLine,
  Sprout,
} from "lucide-react";
import { useId } from "react";

import type {
  NewBusinessCategory,
  NewBusinessStage,
  ScoutOnboardingDispatch,
  ScoutOnboardingState,
} from "./types";
import { CATEGORY_LABELS, STAGE_LABELS } from "./constants";
import {
  Actions,
  BackAction,
  Field,
  InlineCard,
  OptionButton,
  PrimaryAction,
  StageFrame,
} from "./shared";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

const CATEGORIES: readonly {
  id: NewBusinessCategory;
  detail: string;
  icon: typeof Sprout;
}[] = [
  { id: "local-services", detail: "Work done for people nearby", icon: MapPin },
  {
    id: "professional",
    detail: "Advice, expertise, or support",
    icon: BriefcaseBusiness,
  },
  {
    id: "products",
    detail: "A product, shop, or physical offer",
    icon: Package,
  },
  { id: "digital", detail: "A digital or remote offer", icon: Monitor },
  {
    id: "other",
    detail: "Describe the category in your own words",
    icon: PencilLine,
  },
];

const BUSINESS_STAGES: readonly {
  id: NewBusinessStage;
  detail: string;
}[] = [
  { id: "idea", detail: "The details are open." },
  { id: "preparing", detail: "Getting ready to learn more." },
  { id: "testing", detail: "Checking a small first signal." },
];

const PRIORITIES = [
  { id: "demand" as const, detail: "Learn whether people want it" },
  { id: "offer" as const, detail: "Shape the first offer" },
  { id: "test" as const, detail: "Plan a small first test" },
  { id: "other" as const, detail: "Something else to discuss" },
];

export function NewPersonStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.new;
  const descriptionId = useId();
  const ownerId = useId();
  return (
    <StageFrame
      ownerMessage={route.person ? route.person : undefined}
      scoutMessage="What kind of business are you considering?"
      state={state}
    >
      <InlineCard
        description="Start broad. Scout will use the category and your short description as context for the next question."
        eyebrow="New business"
        icon={Sprout}
      >
        <div className="grid gap-2 @sm:grid-cols-2">
          {CATEGORIES.map(({ id, detail, icon: Icon }) => (
            <OptionButton
              detail={detail}
              icon={Icon}
              key={id}
              label={CATEGORY_LABELS[id]}
              onClick={() =>
                onChange({
                  type: "set-new-answer",
                  field: "category",
                  value: id,
                })
              }
              selected={route.category === id}
            />
          ))}
        </div>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ type: "advance-new-intake" });
          }}
        >
          <Field
            help={
              route.category === "other"
                ? "Add a few words so Scout can understand this category."
                : "A category is enough to continue; add words when a category needs more shape."
            }
            htmlFor={descriptionId}
            label={
              route.category === "other"
                ? "Short description (required)"
                : "Short custom description (optional)"
            }
          >
            <Textarea
              id={descriptionId}
              maxLength={600}
              onChange={(event) =>
                onChange({
                  type: "set-new-answer",
                  field: "description",
                  value: event.target.value,
                })
              }
              placeholder="A few words about the business or offer."
              value={route.description}
            />
          </Field>
          <Field
            help="This can be your motivation, experience, or a blank answer."
            htmlFor={ownerId}
            label="About you (optional)"
          >
            <Textarea
              id={ownerId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-new-answer",
                  field: "person",
                  value: event.target.value,
                })
              }
              placeholder="What experience or motivation should Scout keep in view?"
              value={route.person}
            />
          </Field>
          <Actions>
            <BackAction
              onClick={() => onChange({ type: "go-back", stage: "arrival" })}
            />
            <PrimaryAction
              disabled={
                !route.category ||
                (route.category === "other" && !route.description.trim())
              }
              type="submit"
            >
              Continue to the idea stage
            </PrimaryAction>
          </Actions>
        </form>
      </InlineCard>
    </StageFrame>
  );
}

export function NewBusinessStageView({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.new;
  const ideaId = useId();
  return (
    <StageFrame
      ownerMessage={
        route.idea ||
        route.description ||
        "No specific business idea shared yet."
      }
      scoutMessage="Where is the idea today?"
      state={state}
    >
      <InlineCard
        description="Choose the readiness stage that fits. This keeps the conversation concrete without creating a plan."
        eyebrow="Idea stage"
        icon={Sprout}
      >
        <div className="grid gap-2 @sm:grid-cols-3">
          {BUSINESS_STAGES.map(({ id, detail }) => (
            <OptionButton
              detail={detail}
              key={id}
              label={STAGE_LABELS[id]}
              onClick={() =>
                onChange({
                  type: "set-new-answer",
                  field: "ideaStage",
                  value: id,
                })
              }
              selected={route.ideaStage === id}
            />
          ))}
        </div>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ type: "advance-new-business" });
          }}
        >
          <Field
            help="The category and stage remain useful when the idea is still forming."
            htmlFor={ideaId}
            label="Business or idea (optional)"
          >
            <Textarea
              id={ideaId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-new-answer",
                  field: "idea",
                  value: event.target.value,
                })
              }
              placeholder="Describe what you are considering, or leave it open for now."
              value={route.idea}
            />
          </Field>
          <Actions>
            <BackAction
              onClick={() => onChange({ type: "go-back", stage: "person" })}
            />
            <PrimaryAction disabled={!route.ideaStage} type="submit">
              Continue to one useful priority
            </PrimaryAction>
          </Actions>
        </form>
      </InlineCard>
    </StageFrame>
  );
}

export function NewFollowUpStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.new;
  const goalId = useId();
  const locationId = useId();
  return (
    <StageFrame
      ownerMessage={route.goal || "No current priority shared yet."}
      scoutMessage="What should Scout help you think through first?"
      state={state}
    >
      <InlineCard
        description="Choose the focus for the editable understanding. This does not start a business task."
        eyebrow="Useful priority"
        icon={Compass}
      >
        <div className="grid gap-2 @sm:grid-cols-2">
          {PRIORITIES.map(({ id, detail }) => (
            <OptionButton
              detail={detail}
              key={id}
              label={
                id === "demand"
                  ? "Learn whether people want it"
                  : id === "offer"
                    ? "Shape the first offer"
                    : id === "test"
                      ? "Plan a small first test"
                      : "Something else to discuss"
              }
              onClick={() =>
                onChange({
                  type: "set-new-answer",
                  field: "priority",
                  value: id,
                })
              }
              selected={route.priority === id}
            />
          ))}
        </div>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ type: "advance-new-follow-up" });
          }}
        >
          <Field
            htmlFor={goalId}
            label="What matters now (optional)"
            help="Leave this open when you do not have more detail yet."
          >
            <Textarea
              id={goalId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-new-answer",
                  field: "goal",
                  value: event.target.value,
                })
              }
              placeholder="What would you like to learn or decide first?"
              value={route.goal}
            />
          </Field>
          <Field
            htmlFor={locationId}
            label="Area or location (optional)"
            help="Scout will not infer an area from “near home”."
          >
            <Input
              id={locationId}
              maxLength={240}
              onChange={(event) =>
                onChange({
                  type: "set-new-answer",
                  field: "location",
                  value: event.target.value,
                })
              }
              placeholder="Leave blank to keep the area unknown."
              value={route.location}
            />
          </Field>
          <Actions>
            <BackAction
              onClick={() => onChange({ type: "go-back", stage: "business" })}
            />
            <PrimaryAction disabled={!route.priority} type="submit">
              Review the understanding
            </PrimaryAction>
          </Actions>
        </form>
      </InlineCard>
    </StageFrame>
  );
}
