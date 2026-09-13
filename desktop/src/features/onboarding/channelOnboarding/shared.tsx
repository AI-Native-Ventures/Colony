import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  FilePenLine,
  Hash,
  LayoutDashboard,
  LockKeyhole,
  MessageCircle,
  PencilLine,
  Route,
  Sprout,
  Store,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type {
  ScoutOnboardingState,
  ScoutOnboardingStage,
  ScoutRoute,
} from "./types";
import { scoutStageNumber } from "./selectors";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

export const ROUTE_LABELS: Record<ScoutRoute, string> = {
  new: "Start a new business",
  existing: "Help with my existing business",
  deciding: "Help me decide what to start",
};

export const STAGE_TITLES: Record<ScoutOnboardingStage, string> = {
  arrival: "Welcome",
  person: "Your starting point",
  business: "The idea or business",
  "follow-up": "One useful priority",
  understanding: "Editable understanding",
  setup: "Smallest useful setup",
  "setting-up": "Saving your setup",
  ready: "Ready for the next conversation",
};

const STAGE_ICONS: Record<ScoutOnboardingStage, LucideIcon> = {
  arrival: Route,
  person: UserRound,
  business: Sprout,
  "follow-up": Compass,
  understanding: FilePenLine,
  setup: LayoutDashboard,
  "setting-up": LockKeyhole,
  ready: MessageCircle,
};

export function StageFrame({
  state,
  scoutMessage,
  ownerMessage,
  children,
}: {
  state: ScoutOnboardingState;
  scoutMessage: ReactNode;
  ownerMessage?: ReactNode;
  children: ReactNode;
}) {
  const Icon = STAGE_ICONS[state.stage];
  const stageNumber = scoutStageNumber(state.stage);
  return (
    <section
      aria-label="Scout onboarding conversation"
      className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-4 px-4 py-5 @sm:px-6 @sm:py-7"
    >
      <div className="flex min-w-0 items-center gap-2 text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5 text-primary" />
        <span className="min-w-0">{STAGE_TITLES[state.stage]}</span>
        <span className="ml-auto tabular-nums text-muted-foreground/70">
          {stageNumber} / 8
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        {ownerMessage ? <OwnerMessage>{ownerMessage}</OwnerMessage> : null}
        <ScoutMessage>{scoutMessage}</ScoutMessage>
      </div>

      {children}

      {state.notice ? (
        <p
          aria-live="polite"
          className="min-w-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {state.notice}
        </p>
      ) : null}
    </section>
  );
}

export function ScoutMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-primary/10 text-xs font-medium text-primary"
      >
        S
      </span>
      <div className="min-w-0 max-w-[42rem] flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <strong className="text-xs font-medium text-foreground">Scout</strong>
          <span className="text-2xs text-muted-foreground">guide</span>
        </div>
        <div className="rounded-[4px_12px_12px_12px] border border-border/60 bg-card/80 px-3 py-2.5 text-sm leading-relaxed text-foreground shadow-xs">
          {children}
        </div>
      </div>
    </div>
  );
}

export function OwnerMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-end gap-2.5">
      <div className="min-w-0 max-w-[42rem] flex-1">
        <div className="mb-1 flex justify-end gap-2 text-right">
          <span className="text-2xs text-muted-foreground">owner</span>
          <strong className="text-xs font-medium text-foreground">You</strong>
        </div>
        <div className="rounded-[12px_4px_12px_12px] bg-primary/10 px-3 py-2.5 text-left text-sm leading-relaxed text-foreground">
          {children}
        </div>
      </div>
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
      >
        <UserRound className="size-4" />
      </span>
    </div>
  );
}

export function InlineCard({
  eyebrow,
  icon: Icon,
  title,
  description,
  children,
}: {
  eyebrow: string;
  icon: LucideIcon;
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="@container min-w-0 w-full rounded-xl border border-border/70 bg-card/80 p-4 shadow-xs @sm:p-5">
      <div className="flex min-w-0 items-center gap-2 text-2xs font-medium uppercase tracking-[0.08em] text-primary">
        <Icon aria-hidden="true" className="size-3.5" />
        <span className="min-w-0">{eyebrow}</span>
      </div>
      {title ? (
        <h2 className="mt-2 text-xl font-medium leading-tight tracking-tight text-foreground">
          {title}
        </h2>
      ) : null}
      {description ? (
        <p className="mt-1.5 max-w-[62ch] text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="mt-4 min-w-0">{children}</div>
    </section>
  );
}

export function ChoiceButton({
  icon: Icon,
  title,
  detail,
  selected = false,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  selected?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "group flex min-h-12 w-full items-center gap-3 border-b border-border/60 py-3 text-left transition-colors last:border-b-0 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "text-primary",
      )}
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-primary transition-colors",
          selected && "bg-primary text-primary-foreground",
        )}
      >
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium text-foreground group-hover:text-primary">
          {title}
        </span>
        {detail ? (
          <span className="text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="ml-auto size-4 shrink-0 text-muted-foreground/70"
      />
    </button>
  );
}

export function OptionButton({
  label,
  detail,
  selected,
  onClick,
  icon: Icon = Check,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onClick: () => void;
  icon?: LucideIcon;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-2.5 text-left text-xs transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary bg-primary/10 text-primary",
      )}
      onClick={onClick}
      type="button"
    >
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-primary"
      />
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{label}</span>
        {detail ? (
          <span className="mt-0.5 block text-2xs text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function Field({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-medium text-foreground" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help ? <p className="text-2xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 w-full flex-col items-stretch gap-2 pt-1 @sm:flex-row @sm:items-center [&>button]:h-auto [&>button]:min-h-9 [&>button]:min-w-0 [&>button]:max-w-full [&>button]:w-full [&>button]:whitespace-normal @sm:[&>button]:w-auto">
      {children}
    </div>
  );
}

export function PrimaryAction({
  children,
  disabled,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <Button
      className="min-w-0 max-w-full gap-2"
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
      <ArrowRight aria-hidden="true" className="size-4" />
    </Button>
  );
}

export function SecondaryAction({
  children,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <Button
      className="min-w-0 max-w-full"
      onClick={onClick}
      type={type}
      variant="outline"
    >
      {children}
    </Button>
  );
}

export function QuietAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button onClick={onClick} type="button" variant="ghost">
      {children}
    </Button>
  );
}

export function BackAction({
  children = "Back",
  onClick,
}: {
  children?: ReactNode;
  onClick: () => void;
}) {
  return (
    <QuietAction onClick={onClick}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      {children}
    </QuietAction>
  );
}

export function HistoryBlock({
  items,
}: {
  items: readonly { label: string; value: ReactNode }[];
}) {
  return (
    <details className="border-y border-border/60 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5" />
        <span>Earlier in this conversation</span>
        <span className="ml-auto text-2xs">{items.length} notes</span>
      </summary>
      <div className="grid gap-2 pb-3">
        {items.map((item) => (
          <div className="flex min-w-0 gap-2" key={item.label}>
            <strong className="shrink-0 font-medium text-foreground">
              {item.label}
            </strong>
            <span className="min-w-0 break-words">{item.value}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

export function ContextNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function OpenQuestions({
  items,
}: {
  items: readonly { label: string; detail: string }[];
}) {
  return (
    <div className="grid min-w-0 gap-2 bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <CircleHelp aria-hidden="true" className="size-4 text-primary" />
        Still to understand
      </div>
      <ul className="m-0 grid list-none gap-2 p-0">
        {items.map((item) => (
          <li
            className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/60 pb-2 text-2xs last:border-b-0 last:pb-0"
            key={item.label}
          >
            <strong className="min-w-0 font-medium text-foreground">
              {item.label}
            </strong>
            <span className="min-w-0 break-words text-right text-muted-foreground">
              {item.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OwnerBoundary({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg bg-primary/10 px-3 py-2.5 text-xs text-muted-foreground">
      <strong className="font-medium text-foreground">Owner review:</strong>{" "}
      {children}
    </p>
  );
}

export function NoWebsiteNotice() {
  return (
    <ContextNote>
      <strong className="font-medium text-foreground">
        No website supplied.
      </strong>{" "}
      Scout can continue with the business details you provide.
    </ContextNote>
  );
}

export function ScoutLinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="text-left text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export const routeIcons: Record<ScoutRoute, LucideIcon> = {
  new: Sprout,
  existing: Store,
  deciding: Compass,
};

export const channelIcon = Hash;
export const editIcon = PencilLine;
