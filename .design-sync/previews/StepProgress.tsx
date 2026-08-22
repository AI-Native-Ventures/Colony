import { StepProgress } from "buzz";

export function Default() {
  return (
    <div className="flex w-[420px] flex-col items-center gap-3">
      <StepProgress currentStep={2} />
      <p className="text-sm text-muted-foreground">
        Step 2 of 5, Name your community
      </p>
    </div>
  );
}

export function Progression() {
  return (
    <div className="flex w-[420px] flex-col gap-3">
      {[
        { label: "Choose a relay", step: 1 },
        { label: "Name your community", step: 2 },
        { label: "Invite your first members", step: 3 },
        { label: "Create channels", step: 4 },
        { label: "You are live", step: 5 },
      ].map((row) => (
        <div className="flex items-center gap-4" key={row.step}>
          <StepProgress className="justify-start" currentStep={row.step} />
          <span className="text-sm text-muted-foreground">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

export function OnboardingCard() {
  return (
    <div className="flex w-[420px] flex-col gap-4 rounded-lg border border-border p-5">
      <StepProgress currentStep={3} />
      <div className="flex flex-col gap-1 text-center">
        <h3 className="text-base font-medium text-foreground">
          Invite your first members
        </h3>
        <p className="text-sm text-muted-foreground">
          Share an invite link, or add teammates by their public key. Anyone who
          joins lands in #general.
        </p>
      </div>
    </div>
  );
}

export function CustomTotal() {
  return (
    <div className="flex w-[420px] flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">
          Device pairing, 1 of 3
        </span>
        <StepProgress className="justify-start" currentStep={1} totalSteps={3} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">
          Agent setup, 5 of 8
        </span>
        <StepProgress className="justify-start" currentStep={5} totalSteps={8} />
      </div>
    </div>
  );
}
