import { Button, PageHeader, SectionHeader, SubsectionLabel } from "buzz";

export function Default() {
  return (
    <PageHeader
      description="Manage the agents that can act inside this community."
      title="Agents"
    />
  );
}

export function WithAction() {
  return (
    <PageHeader
      action={<Button size="sm">Invite member</Button>}
      description="People and agents with access to colony.ventures."
      title="Members"
    />
  );
}

export function Section() {
  return (
    <div className="w-full space-y-4">
      <SectionHeader
        description="Applied to every agent launched from this workspace unless overridden."
        title="Agent defaults"
      />
      <SectionHeader
        action={
          <Button size="sm" variant="outline">
            Add relay
          </Button>
        }
        description="Relays this community federates with."
        title="Connected relays"
      />
    </div>
  );
}

export function Subsection() {
  return (
    <div className="w-full space-y-3">
      <SubsectionLabel>Delegation grants</SubsectionLabel>
      <p className="text-sm text-muted-foreground">
        Owner-signed grants let a leader-tier agent decide without asking.
      </p>
      <SubsectionLabel>Audit trail</SubsectionLabel>
      <p className="text-sm text-muted-foreground">
        Every decision made under a grant is written to the hash-chain log.
      </p>
    </div>
  );
}

export function FullRamp() {
  return (
    <div className="w-full space-y-6">
      <PageHeader
        action={
          <Button size="sm" variant="outline">
            Export audit log
          </Button>
        }
        description="Everything the relay enforces for this community."
        title="Community settings"
      />
      <div className="space-y-3">
        <SectionHeader
          description="Who can join, and how they get approved."
          title="Membership"
        />
        <div className="space-y-1">
          <SubsectionLabel>Join policy</SubsectionLabel>
          <p className="text-sm text-foreground">
            Invite only. An owner approves every claim.
          </p>
        </div>
        <div className="space-y-1">
          <SubsectionLabel>Open invites</SubsectionLabel>
          <p className="text-sm text-foreground">
            3 unclaimed links, expiring in 6 days.
          </p>
        </div>
      </div>
    </div>
  );
}
