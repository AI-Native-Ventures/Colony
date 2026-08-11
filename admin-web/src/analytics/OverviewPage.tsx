import { analyticsPath } from "./api";
import {
  AnalyticsContentState,
  AnalyticsMetricGrid,
  DataTable,
  DefinitionsLink,
  EmptyState,
  EnvelopeFreshness,
  FreshnessBadge,
  MetricCard,
  SectionHeader,
  formatCount,
  formatDate,
  labelForStatus,
  communityKey,
  communityLastActivity,
  communityPeople,
  overviewMetrics,
} from "./components";
import {
  useAnalyticsFilters,
  useAnalyticsResource,
  useOperatorSigner,
} from "./hooks";
import type { OverviewData } from "./types";

export function OverviewPage() {
  const signer = useOperatorSigner();
  const filters = useAnalyticsFilters();
  const resource = useAnalyticsResource<OverviewData>(
    analyticsPath("overview", filters.query),
    { signer, pollMs: 60_000, enabled: Boolean(signer) },
  );
  return (
    <AnalyticsContentState resource={resource}>
      {(data, envelope) => {
        const metrics = overviewMetrics(data);
        const trend = data.trend ?? [];
        const communities = data.communities ?? [];
        return (
          <div className="analytics-page analytics-overview-page">
            <div className="analytics-freshness-row">
              <EnvelopeFreshness envelope={envelope} />
              <EnvelopeFreshness envelope={envelope} live />
              <span className="analytics-as-of">
                Source observed {formatDate(envelope.as_of)}
              </span>
            </div>
            {envelope.freshness.historical.status === "stale" ? (
              <div className="analytics-warning" role="status">
                Historical cards are showing the latest available rollup
                watermark ({formatDate(envelope.freshness.historical.watermark)}
                ).
              </div>
            ) : null}
            {envelope.freshness.live.status === "unavailable" ? (
              <div
                className="analytics-warning analytics-warning-live"
                role="status"
              >
                Live session data is unavailable. Historical values remain
                visible; no single-pod estimate is substituted.
              </div>
            ) : null}
            {envelope.warnings?.length ? (
              <div className="analytics-warning" role="status">
                {envelope.warnings.join(" · ")}
              </div>
            ) : null}
            <AnalyticsMetricGrid metrics={metrics} />
            <div className="analytics-metric-grid analytics-secondary-metrics">
              <MetricCard
                label="First seen"
                value={metrics.first_seen_people}
                definition="Minimum durable identity timestamp"
              />
              <MetricCard
                label="New memberships"
                value={metrics.new_memberships}
                definition="Community admission rows"
              />
              <MetricCard
                label="Active channels"
                value={metrics.active_channels}
                definition="Channels with qualifying activity"
              />
              <MetricCard
                label="Threads"
                value={metrics.threads}
                definition="Thread metadata counts"
              />
            </div>
            <div className="analytics-panel-grid analytics-panel-grid-wide">
              <section className="analytics-panel">
                <SectionHeader title="Engagement trend">
                  <DefinitionsLink />
                </SectionHeader>
                {trend.length ? (
                  <DataTable className="trend-table">
                    <table>
                      <caption className="visually-hidden">
                        Daily meaningful activity
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">UTC day</th>
                          <th scope="col">Unique people</th>
                          <th scope="col">Activity volume</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trend.map((point) => (
                          <tr key={point.utc_day}>
                            <th scope="row">{point.utc_day}</th>
                            <td>{formatCount(point.unique_people)}</td>
                            <td>{formatCount(point.activity_volume)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                ) : (
                  <EmptyState title="No activity in this window" />
                )}
              </section>
              <section className="analytics-panel analytics-live-panel">
                <SectionHeader title="Live pulse">
                  <FreshnessBadge source={envelope.freshness.live} />
                </SectionHeader>
                <div className="live-pulse-grid">
                  <div>
                    <span>People online</span>
                    <strong>{formatCount(metrics.online_people)}</strong>
                  </div>
                  <div>
                    <span>Sessions</span>
                    <strong>
                      {formatCount(metrics.authenticated_sessions)}
                    </strong>
                  </div>
                  <div>
                    <span>Connections</span>
                    <strong>{formatCount(metrics.open_connections)}</strong>
                  </div>
                </div>
                <p className="panel-note">
                  Online people are deduplicated; sessions and connections are
                  counted separately.
                </p>
              </section>
            </div>
            <section className="analytics-panel">
              <SectionHeader title="Community health">
                <a className="panel-action" href="/analytics/communities">
                  View all communities
                </a>
              </SectionHeader>
              {communities.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      Community health metrics
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Community</th>
                        <th scope="col">Status</th>
                        <th scope="col">People</th>
                        <th scope="col">Memberships</th>
                        <th scope="col">Online</th>
                        <th scope="col">DAU</th>
                        <th scope="col">Last activity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {communities.map((community) => (
                        <tr key={communityKey(community)}>
                          <th scope="row">
                            <a
                              href={`/analytics/communities?community=${encodeURIComponent(communityKey(community))}`}
                            >
                              {community.name || community.host}
                            </a>
                            <small>{community.host}</small>
                          </th>
                          <td>
                            <span className="status-pill">
                              {labelForStatus(community.status ?? "active")}
                            </span>
                          </td>
                          <td>{formatCount(communityPeople(community))}</td>
                          <td>{formatCount(community.memberships)}</td>
                          <td>{formatCount(community.online_people)}</td>
                          <td>{formatCount(community.dau)}</td>
                          <td>
                            {formatDate(communityLastActivity(community))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              ) : (
                <EmptyState
                  title="No active communities"
                  description="This deployment has no community metrics for the selected scope."
                />
              )}
            </section>
          </div>
        );
      }}
    </AnalyticsContentState>
  );
}
