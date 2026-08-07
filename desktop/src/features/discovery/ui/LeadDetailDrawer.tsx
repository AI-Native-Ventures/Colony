import * as React from "react";
import {
  AlertCircle,
  Building2,
  CalendarDays,
  ExternalLink,
  Globe2,
  Link2,
  Mail,
  MapPin,
  Phone,
  UserRound,
} from "lucide-react";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/shared/ui/avatar";
import { Badge, type BadgeProps } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Separator } from "@/shared/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { LeadDetail, LeadFunnelStatus } from "../types";

const STATUS_LABELS: Record<LeadFunnelStatus, string> = {
  candidate: "Candidate",
  accepted: "Accepted",
  qualified: "Qualified",
  dormant: "Dormant",
  disqualified: "Disqualified",
  client_active: "Client (active)",
};

function statusVariant(status: LeadFunnelStatus): BadgeProps["variant"] {
  if (status === "qualified" || status === "client_active") return "success";
  if (status === "accepted") return "info";
  if (status === "dormant") return "warning";
  if (status === "disqualified") return "destructive";
  return "secondary";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function leadName(lead: LeadDetail) {
  if (lead.personName) return lead.personName;
  return lead.companyName ?? lead.contactName ?? "Unnamed lead";
}

function ownerLabel(lead: LeadDetail) {
  return lead.owner?.trim() || "Unassigned";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-foreground">{children}</dd>
    </div>
  );
}

function ContactLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <a
      className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground hover:text-primary"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {icon}
      <span className="truncate">{label}</span>
      <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
    </a>
  );
}

function LeadDetailBody({ lead }: { lead: LeadDetail }) {
  const name = leadName(lead);
  const isPerson = lead.entityType === "person" || Boolean(lead.personName);
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <Avatar className="h-12 w-12 rounded-xl">
          {lead.avatarUrl ? <AvatarImage alt="" src={lead.avatarUrl} /> : null}
          <AvatarFallback className="rounded-xl bg-primary/10 text-sm font-semibold text-primary">
            {initials(name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">
            {name}
          </h2>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span className="truncate">{lead.location}</span>
          </p>
        </div>
        <Badge variant={statusVariant(lead.status)}>
          {STATUS_LABELS[lead.status]}
        </Badge>
      </div>

      <div className="space-y-2">
        {lead.website ? (
          <ContactLink
            href={lead.website}
            icon={<Globe2 aria-hidden="true" className="h-4 w-4 shrink-0" />}
            label={lead.website}
          />
        ) : null}
        {lead.email ? (
          <ContactLink
            href={`mailto:${lead.email}`}
            icon={<Mail aria-hidden="true" className="h-4 w-4 shrink-0" />}
            label={lead.email}
          />
        ) : null}
        {lead.phone ? (
          <ContactLink
            href={`tel:${lead.phone}`}
            icon={<Phone aria-hidden="true" className="h-4 w-4 shrink-0" />}
            label={lead.phone}
          />
        ) : null}
        {lead.linkedinUrl ? (
          <ContactLink
            href={lead.linkedinUrl}
            icon={<Link2 aria-hidden="true" className="h-4 w-4 shrink-0" />}
            label="LinkedIn"
          />
        ) : null}
      </div>

      <Separator />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Field label="Source">{lead.sourceLabel || lead.source}</Field>
        <Field label="Owner">{ownerLabel(lead)}</Field>
        <Field label="Fit score">
          <span className="font-semibold tabular-nums">{lead.score}</span>
        </Field>
        <Field label="Contacts">{lead.contacts}</Field>
        {isPerson ? (
          <>
            <Field label="Title">
              {lead.roleName ?? lead.contactTitle ?? "Unavailable"}
            </Field>
            <Field label="Current company">
              {lead.currentCompany ?? "Unavailable"}
            </Field>
            <Field label="Seniority">{lead.seniority ?? "Unavailable"}</Field>
          </>
        ) : (
          <>
            <Field label="Contact">{lead.contactName ?? "Unavailable"}</Field>
            <Field label="Title">{lead.contactTitle ?? "Unavailable"}</Field>
          </>
        )}
        <Field label="Discovered">{formatDate(lead.addedAt)}</Field>
        {lead.updatedAt ? (
          <Field label="Updated">{formatDate(lead.updatedAt)}</Field>
        ) : null}
      </dl>

      {lead.campaignIds.length > 0 ? (
        <>
          <Separator />
          <section>
            <h3 className="flex items-center gap-1.5 text-2xs uppercase tracking-[0.14em] text-muted-foreground">
              <Building2 aria-hidden="true" className="h-3 w-3" />
              Campaign origin
            </h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {lead.campaignIds.map((campaignId) => (
                <Badge key={campaignId} variant="outline">
                  {campaignId}
                </Badge>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {lead.notes ? (
        <>
          <Separator />
          <section>
            <h3 className="text-2xs uppercase tracking-[0.14em] text-muted-foreground">
              Notes
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
              {lead.notes}
            </p>
          </section>
        </>
      ) : null}

      <Separator />

      <section>
        <h3 className="flex items-center gap-1.5 text-2xs uppercase tracking-[0.14em] text-muted-foreground">
          <CalendarDays aria-hidden="true" className="h-3 w-3" />
          Provenance
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Retained from {lead.sourceLabel || lead.source} on{" "}
          {formatDate(lead.addedAt)}.
          {lead.updatedAt
            ? ` Profile last updated ${formatDate(lead.updatedAt)}.`
            : ""}
        </p>
        {lead.partyHandle ? (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <UserRound aria-hidden="true" className="h-3 w-3" />
            Linked to Party {lead.partyHandle}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function LoadingBody() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="h-16 animate-pulse rounded-xl bg-muted/40" />
      <div className="h-24 animate-pulse rounded-xl bg-muted/35" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-16 animate-pulse rounded-xl bg-muted/35" />
        <div className="h-16 animate-pulse rounded-xl bg-muted/35" />
      </div>
      <span className="sr-only">Loading lead details</span>
    </div>
  );
}

function ErrorBody({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle aria-hidden="true" className="h-6 w-6" />
      </div>
      <h3 className="text-base font-semibold text-foreground">
        Lead unavailable
      </h3>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      <Button
        className="mt-2"
        data-testid="lead-detail-error-close"
        onClick={onClose}
        size="sm"
        type="button"
        variant="outline"
      >
        Close
      </Button>
    </div>
  );
}

type LeadDetailDrawerProps = {
  dataSource: DiscoveryDataSource;
  search: DiscoverySearch;
};

type LeadDetailState =
  | { status: "loading" }
  | { status: "ready"; lead: LeadDetail }
  | { status: "error"; message: string };

/**
 * The read-only lead detail drawer.
 *
 * The URL is the source of truth: the drawer opens whenever `leadId` is in
 * Discovery search state, so it survives reloads and community remounts.
 * Closing navigates `leadId` out of the URL and leaves every other search
 * param untouched.
 */
export function LeadDetailDrawer({
  dataSource,
  search,
}: LeadDetailDrawerProps) {
  const { goDiscovery } = useAppNavigation();
  const leadId = search.leadId;
  const [state, setState] = React.useState<LeadDetailState>({
    status: "loading",
  });

  React.useEffect(() => {
    if (!leadId) {
      setState({ status: "loading" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void dataSource
      .getLead(leadId)
      .then((lead) => {
        if (!cancelled) setState({ status: "ready", lead });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, leadId]);

  const close = React.useCallback(() => {
    void goDiscovery({ ...search, leadId: undefined });
  }, [goDiscovery, search]);

  const title =
    state.status === "ready"
      ? leadName(state.lead)
      : state.status === "error"
        ? "Lead unavailable"
        : "Lead details";
  const description =
    state.status === "ready"
      ? `${state.lead.location} - ${STATUS_LABELS[state.lead.status]}`
      : state.status === "error"
        ? "This lead could not be loaded."
        : "Loading lead details";

  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open={Boolean(leadId)}
    >
      <SheetContent
        aria-describedby="lead-detail-description"
        aria-labelledby="lead-detail-title"
        className="flex h-full w-full max-w-md flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        data-testid="lead-detail-drawer"
        side="right"
      >
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle className="text-base" id="lead-detail-title">
            {title}
          </SheetTitle>
          <SheetDescription id="lead-detail-description">
            {description}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {state.status === "loading" ? <LoadingBody /> : null}
          {state.status === "ready" ? (
            <LeadDetailBody lead={state.lead} />
          ) : null}
          {state.status === "error" ? (
            <ErrorBody message={state.message} onClose={close} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
