import type { ReactNode } from "react";
import type { AnalyticsResource } from "./hooks";
import type {
  AnalyticsEnvelope,
  AnalyticsQuery,
  AnalyticsMetricSet,
  CommunitySummary,
  FreshnessSource,
  OverviewData,
  PersonActivitySummary,
  PersonDetail,
  PersonMembership,
  PersonSummary,
  PersonActivityTotal,
} from "./types";

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return new Intl.NumberFormat().format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Not available";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Not available"
    : parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

export function shortPubkey(value: string): string {
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function labelForStatus(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function overviewMetrics(data: OverviewData): AnalyticsMetricSet {
  const metrics = data.metrics ?? {};
  const population: Partial<NonNullable<OverviewData["population"]>> =
    data.population ?? {};
  const live: Partial<NonNullable<OverviewData["live"]>> = data.live ?? {};
  const engagement: Partial<NonNullable<OverviewData["engagement"]>> =
    data.engagement ?? {};
  return {
    unique_people: metrics.unique_people ?? population.unique_people ?? 0,
    memberships: metrics.memberships ?? population.memberships ?? 0,
    first_seen_people: metrics.first_seen_people ?? population.first_seen ?? 0,
    new_memberships: metrics.new_memberships ?? population.new_memberships ?? 0,
    online_people: metrics.online_people ?? live.online_people ?? 0,
    authenticated_sessions:
      metrics.authenticated_sessions ?? live.authenticated_sessions ?? 0,
    open_connections: metrics.open_connections ?? live.open_connections ?? 0,
    dau: metrics.dau ?? engagement.dau ?? 0,
    wau: metrics.wau ?? engagement.wau ?? 0,
    mau: metrics.mau ?? engagement.mau ?? 0,
    activity_volume: metrics.activity_volume,
    active_channels: metrics.active_channels,
    threads: metrics.threads,
  };
}

export function communityRows(data: {
  items?: CommunitySummary[];
  rows?: CommunitySummary[];
}) {
  return data.items ?? data.rows ?? [];
}

export function communityKey(community: CommunitySummary): string {
  return community.id ?? community.community_id ?? community.host;
}

export function communityPeople(
  community: CommunitySummary,
): number | undefined {
  return community.unique_people ?? community.people;
}

export function communityLastActivity(
  community: CommunitySummary,
): string | null | undefined {
  return community.last_activity_at ?? community.last_activity;
}

export function personLabel(person: {
  display_name?: string | null;
  profile_label?: string | null;
  pubkey: string;
}): string {
  return (
    person.display_name ?? person.profile_label ?? shortPubkey(person.pubkey)
  );
}

export function personLastActivity(person: {
  last_activity_at?: string | null;
  last_meaningful_activity?: string | null;
}): string | null | undefined {
  return person.last_activity_at ?? person.last_meaningful_activity;
}

export function personRecord(detail: PersonDetail): PersonSummary {
  return detail.person ?? detail;
}

export function personMembershipRows(detail: PersonDetail): PersonMembership[] {
  return (detail.memberships ?? []).map((membership) => ({
    ...membership,
    community_host:
      membership.community_host || membership.host || "Unknown community",
    joined_at: membership.joined_at ?? membership.created_at,
  }));
}

export function personActivitySummary(
  activity: PersonDetail["activity"],
): PersonActivitySummary {
  if (!Array.isArray(activity)) {
    return activity ?? { dau: 0, wau: 0, mau: 0, event_count: 0 };
  }
  const totals = activity as PersonActivityTotal[];
  return {
    event_count: totals.reduce((sum, row) => sum + row.event_count, 0),
    families: totals.map((row) => ({
      family: row.activity_family,
      event_count: row.event_count,
    })),
  };
}

export function sessionId(session: {
  session_id?: string | null;
  connection_id?: string | null;
  pubkey: string;
}): string {
  return session.session_id ?? session.connection_id ?? session.pubkey;
}

export function sessionCommunity(session: {
  community_host?: string | null;
  host?: string | null;
}): string {
  return session.community_host ?? session.host ?? "Unknown community";
}

export function activityFamilyName(row: {
  family?: string;
  activity_family?: string;
}): string {
  return row.family ?? row.activity_family ?? "unknown";
}

export function MetricCard({
  label,
  value,
  hint,
  definition,
  className = "",
}: {
  label: string;
  value: number | null | undefined;
  hint?: string;
  definition?: string;
  className?: string;
}) {
  return (
    <article className={`analytics-metric-card ${className}`.trim()}>
      <div className="metric-card-label">{label}</div>
      <strong>{formatCount(value)}</strong>
      {hint ? <span>{hint}</span> : null}
      {definition ? <small>{definition}</small> : null}
    </article>
  );
}

export function FreshnessBadge({
  source,
  label,
}: {
  source?: FreshnessSource;
  label?: string;
}) {
  const status = source?.status ?? "unavailable";
  return (
    <span
      className={`freshness-badge freshness-${status}`}
      title={source?.message ?? undefined}
    >
      <span className="freshness-dot" aria-hidden="true" />
      {label ? `${label}: ` : ""}
      {labelForStatus(status)}
      {source?.lag_seconds && source.lag_seconds > 0
        ? ` · ${Math.round(source.lag_seconds)}s lag`
        : ""}
    </span>
  );
}

export function EnvelopeFreshness<T>({
  envelope,
  live = false,
}: {
  envelope?: AnalyticsEnvelope<T>;
  live?: boolean;
}) {
  if (!envelope) return null;
  return (
    <FreshnessBadge
      source={live ? envelope.freshness.live : envelope.freshness.historical}
      label={live ? "Live" : "Historical"}
    />
  );
}

export function ScopeControls({
  query,
  range,
  communities,
  onChange,
}: {
  query: AnalyticsQuery;
  range: string;
  communities?: Array<{ id: string; host: string; name?: string | null }>;
  onChange: (next: Partial<AnalyticsQuery> & { range?: string }) => void;
}) {
  return (
    <fieldset className="analytics-controls">
      <legend className="visually-hidden">Analytics scope controls</legend>
      <label>
        <span>Scope</span>
        <select
          aria-label="Community scope"
          value={query.community ?? "all"}
          onChange={(event) =>
            onChange({
              community:
                event.target.value === "all" ? undefined : event.target.value,
            })
          }
        >
          <option value="all">All active communities</option>
          {communities?.map((community) => (
            <option key={community.id} value={community.id}>
              {community.name || community.host}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>UTC range</span>
        <select
          aria-label="UTC date range"
          value={range}
          onChange={(event) => onChange({ range: event.target.value })}
        >
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
      </label>
      <span className="utc-note">UTC · end exclusive</span>
    </fieldset>
  );
}

export function AnalyticsState<T>({
  resource,
  children,
}: {
  resource: {
    data?: AnalyticsEnvelope<T>;
    error?: Error;
    loading: boolean;
    refetch: () => void;
  };
  children: (data: AnalyticsEnvelope<T>) => ReactNode;
}) {
  if (resource.error && !resource.data) {
    const unavailable = resource.error.message.includes("unavailable");
    const denied = resource.error.message.includes("not authorized");
    return unavailable ? (
      <UnavailableState onRetry={resource.refetch} />
    ) : (
      <div className="analytics-state analytics-error" role="alert">
        <h2>
          {denied
            ? "Access denied"
            : resource.error.message.includes("signer")
              ? "Connect operator signer"
              : "Could not load analytics"}
        </h2>
        <p>
          {denied
            ? "This operator signer is not allowlisted for deployment analytics."
            : resource.error.message.includes("signer")
              ? "Analytics requests require an allowlisted NIP-07 or remote operator signer. No key is stored by this page."
              : resource.error.message}
        </p>
        <button type="button" onClick={resource.refetch}>
          Retry
        </button>
      </div>
    );
  }
  if (!resource.data) {
    return <div className="analytics-state">Loading analytics…</div>;
  }
  return (
    <>
      {resource.loading ? (
        <div className="refreshing-note" role="status">
          Refreshing…
        </div>
      ) : null}
      {children(resource.data)}
    </>
  );
}

export function AnalyticsContentState<T>({
  resource,
  children,
}: {
  resource: AnalyticsResource<T>;
  children: (data: T, envelope: AnalyticsEnvelope<T>) => ReactNode;
}) {
  return (
    <AnalyticsState resource={resource}>
      {(envelope) => children(envelope.data, envelope)}
    </AnalyticsState>
  );
}

export function EmptyState({
  title = "Nothing to show yet",
  description = "There are no records for this scope and time window.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="analytics-state analytics-empty">
      <h2>{title}</h2>
      <p>{description}</p>
      <DefinitionsLink />
    </div>
  );
}

export function UnavailableState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="analytics-state analytics-unavailable" role="status">
      <h2>Source unavailable</h2>
      <p>
        Live analytics are unavailable. Historical data is not replaced with a
        single-pod estimate.
      </p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function DefinitionsLink() {
  return (
    <a className="definitions-link" href="/analytics/definitions">
      How is this defined?
    </a>
  );
}

export function DataTable({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`analytics-table-wrap ${className}`.trim()}>{children}</div>
  );
}

export function AnalyticsMetricGrid({
  metrics,
}: {
  metrics: AnalyticsMetricSet;
}) {
  return (
    <div className="analytics-metric-grid">
      <MetricCard
        label="Unique people"
        value={metrics.unique_people}
        definition="Distinct pubkeys"
      />
      <MetricCard
        label="Memberships"
        value={metrics.memberships}
        definition="Active community memberships"
      />
      <MetricCard
        label="Online people"
        value={metrics.online_people}
        definition="Fresh authenticated leases"
      />
      <MetricCard
        label="Authenticated sessions"
        value={metrics.authenticated_sessions}
        definition="Fresh connections"
      />
      <MetricCard
        label="Open connections"
        value={metrics.open_connections}
        definition="Raw WebSocket load"
      />
      <MetricCard
        label="DAU"
        value={metrics.dau}
        hint="24h"
        definition="Meaningful activity"
      />
      <MetricCard
        label="WAU"
        value={metrics.wau}
        hint="7d"
        definition="Meaningful activity"
      />
      <MetricCard
        label="MAU"
        value={metrics.mau}
        hint="30d"
        definition="Meaningful activity"
      />
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="analytics-section-header">
      <div>
        {eyebrow ? <p>{eyebrow}</p> : null}
        <h2>{title}</h2>
      </div>
      {children}
    </header>
  );
}
