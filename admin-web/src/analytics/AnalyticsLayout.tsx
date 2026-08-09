import { type ReactNode, useMemo } from "react";
import { analyticsPath } from "./api";
import {
  FreshnessBadge,
  ScopeControls,
  communityKey,
  formatDate,
} from "./components";
import {
  useAnalyticsFilters,
  useAnalyticsResource,
  useOperatorSigner,
} from "./hooks";
import type { CommunitiesData } from "./types";

const navigation = [
  ["/analytics", "Overview"],
  ["/analytics/communities", "Communities"],
  ["/analytics/people", "People"],
  ["/analytics/activity", "Activity"],
  ["/analytics/sessions", "Sessions"],
  ["/analytics/definitions", "Definitions"],
] as const;

export function AnalyticsLayout({
  children,
  title,
  description,
}: {
  children: ReactNode;
  title: string;
  description: string;
}) {
  const signer = useOperatorSigner();
  const filters = useAnalyticsFilters();
  const communities = useAnalyticsResource<CommunitiesData>(
    analyticsPath("communities", { limit: 200 }),
    { signer, pollMs: 60_000, enabled: Boolean(signer) },
  );
  const communityOptions = useMemo(() => {
    const items =
      communities.data?.data.items ?? communities.data?.data.rows ?? [];
    return items.map((item) => ({
      id: communityKey(item),
      host: item.host,
      name: item.name,
    }));
  }, [communities.data]);
  const pathname = location.pathname;

  return (
    <div className="analytics-shell">
      <aside className="analytics-sidebar" aria-label="Analytics navigation">
        <div className="analytics-sidebar-heading">
          <span className="analytics-kicker">Command Center</span>
          <strong>Deployment analytics</strong>
        </div>
        <nav className="analytics-nav">
          {navigation.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="analytics-nav-link"
              aria-current={
                pathname === href ||
                (href !== "/analytics" && pathname.startsWith(`${href}/`))
                  ? "page"
                  : undefined
              }
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="analytics-sidebar-note">
          <span>Read-only operational view</span>
          <span>Metadata-only view</span>
        </div>
      </aside>
      <section className="analytics-content">
        <header className="analytics-page-header">
          <div>
            <p className="analytics-kicker">Colony / Analytics</p>
            <h1>{title}</h1>
            <p className="analytics-description">{description}</p>
          </div>
          <div className="analytics-header-meta">
            <span>As of {formatDate(new Date().toISOString())}</span>
            <span className="analytics-utc-label">All timestamps UTC</span>
          </div>
        </header>
        <ScopeControls
          query={filters.query}
          range={filters.range}
          communities={communityOptions}
          onChange={filters.update}
        />
        {!signer ? (
          <div className="analytics-auth-card" role="alert">
            <span className="analytics-auth-icon" aria-hidden="true">
              ↗
            </span>
            <div>
              <h2>Connect an operator signer</h2>
              <p>
                Analytics uses a fresh NIP-98 signature for every request.
                Connect an allowlisted NIP-07 wallet or the Colony remote signer
                bridge; private keys never enter this page.
              </p>
            </div>
          </div>
        ) : (
          children
        )}
        {communities.data ? (
          <div className="analytics-source-strip">
            <FreshnessBadge
              source={communities.data.freshness.historical}
              label="Directory"
            />
            {communities.data.warnings?.length ? (
              <span>{communities.data.warnings[0]}</span>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
