import {
  BriefcaseBusiness,
  Check,
  Compass,
  FlaskConical,
  FolderKanban,
  Lightbulb,
  MessageCircle,
  UsersRound,
} from "lucide-react";
import { useId } from "react";

import type {
  DecideDirection,
  ScoutOnboardingDispatch,
  ScoutOnboardingState,
  ScoutSkill,
} from "./types";
import { DIRECTION_LABELS, PRIORITY_LABELS } from "./constants";
import {
  Actions,
  BackAction,
  Field,
  InlineCard,
  OptionButton,
  PrimaryAction,
  StageFrame,
} from "./shared";
import { Textarea } from "@/shared/ui/textarea";

const SKILLS: readonly {
  id: ScoutSkill;
  label: string;
  detail: string;
  icon: typeof Compass;
}[] = [
  {
    id: "operations",
    label: "Operations",
    detail: "Running systems and improving how work gets done",
    icon: BriefcaseBusiness,
  },
  {
    id: "people",
    label: "Working with people",
    detail: "Helping, serving, or coordinating people",
    icon: UsersRound,
  },
  {
    id: "making",
    label: "Making or building things",
    detail: "Creating tangible things or practical offers",
    icon: FolderKanban,
  },
  {
    id: "teaching",
    label: "Teaching or explaining",
    detail: "Making ideas clearer for someone else",
    icon: MessageCircle,
  },
  {
    id: "organizing",
    label: "Organizing and planning",
    detail: "Bringing structure to a moving target",
    icon: Check,
  },
  {
    id: "curious",
    label: "Learning and exploring",
    detail: "Following questions and testing possibilities",
    icon: Lightbulb,
  },
];

const DIRECTIONS: readonly {
  id: DecideDirection;
  detail: string;
}[] = [
  { id: "experience", detail: "Use what I already know." },
  { id: "group", detail: "Start with a specific audience." },
  { id: "flexible", detail: "Keep the first step small." },
  { id: "project", detail: "Work around defined outcomes." },
  { id: "still-exploring", detail: "Keep the possibilities open." },
];

const PRIORITIES = [
  { id: "compare" as const, icon: Compass },
  { id: "test" as const, icon: FlaskConical },
  { id: "clarify" as const, icon: MessageCircle },
];

function skillLabel(skill: ScoutSkill) {
  return SKILLS.find((item) => item.id === skill)?.label ?? skill;
}

export function DecidingPersonStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.deciding;
  const personId = useId();
  return (
    <StageFrame
      ownerMessage={route.person ? route.person : undefined}
      scoutMessage="What experience, skills, or interests could a business build around?"
      state={state}
    >
      <InlineCard
        description="Choose one or more starting points. They help Scout compare directions without choosing for you."
        eyebrow="Decide what to start"
        icon={Compass}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {SKILLS.map(({ id, label, detail, icon: Icon }) => (
            <OptionButton
              detail={detail}
              icon={Icon}
              key={id}
              label={label}
              onClick={() =>
                onChange({ type: "toggle-deciding-skill", skill: id })
              }
              selected={route.skills.includes(id)}
            />
          ))}
        </div>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ type: "advance-deciding-intake" });
          }}
        >
          <Field
            help="This remains optional and can be edited in the readback."
            htmlFor={personId}
            label="About you (optional)"
          >
            <Textarea
              id={personId}
              maxLength={1200}
              onChange={(event) =>
                onChange({
                  type: "set-deciding-person",
                  value: event.target.value,
                })
              }
              placeholder="What have you done, or what are you curious to try?"
              value={route.person}
            />
          </Field>
          <Actions>
            <BackAction
              onClick={() => onChange({ type: "go-back", stage: "arrival" })}
            />
            <PrimaryAction disabled={!route.skills.length} type="submit">
              Continue to possible directions
            </PrimaryAction>
          </Actions>
        </form>
      </InlineCard>
    </StageFrame>
  );
}

export function DecidingBusinessStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.deciding;
  return (
    <StageFrame
      ownerMessage={
        route.skills.length
          ? `Starting points selected: ${route.skills.map(skillLabel).join(", ")}`
          : undefined
      }
      scoutMessage="Based on those starting points, which direction feels worth exploring?"
      state={state}
    >
      <InlineCard
        description="These are comparison directions, not finished businesses. Choose the preference that feels useful to explore."
        eyebrow="Possible direction"
        icon={Compass}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {DIRECTIONS.map(({ id, detail }) => (
            <OptionButton
              detail={detail}
              key={id}
              label={DIRECTION_LABELS[id]}
              onClick={() =>
                onChange({ type: "set-deciding-direction", value: id })
              }
              selected={route.direction === id}
            />
          ))}
        </div>
        <Actions>
          <BackAction
            onClick={() => onChange({ type: "go-back", stage: "person" })}
          />
          <PrimaryAction
            disabled={!route.direction}
            onClick={() => onChange({ type: "advance-deciding-business" })}
          >
            Continue to useful priorities
          </PrimaryAction>
        </Actions>
      </InlineCard>
    </StageFrame>
  );
}

export function DecidingFollowUpStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const route = state.routes.deciding;
  return (
    <StageFrame
      ownerMessage={
        route.direction
          ? (DIRECTION_LABELS[route.direction as DecideDirection] ??
            route.direction)
          : undefined
      }
      scoutMessage="Which next focus would help you decide with more confidence?"
      state={state}
    >
      <InlineCard
        description="Keep the next conversation concrete without pretending the business is already decided."
        eyebrow="Useful priority"
        icon={Compass}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {PRIORITIES.map(({ id, icon: Icon }) => (
            <OptionButton
              icon={Icon}
              key={id}
              label={PRIORITY_LABELS[id]}
              onClick={() =>
                onChange({ type: "set-deciding-priority", value: id })
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
            onClick={() => onChange({ type: "advance-deciding-follow-up" })}
          >
            Review the understanding
          </PrimaryAction>
        </Actions>
      </InlineCard>
    </StageFrame>
  );
}
