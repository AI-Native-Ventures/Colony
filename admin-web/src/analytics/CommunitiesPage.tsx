import { analyticsPath } from "./api";
import {
  AnalyticsContentState,
  DataTable,
  DefinitionsLink,
  EmptyState,
  EnvelopeFreshness,
  SectionHeader,
  formatCount,
  formatDate,
  labelForStatus,
  communityKey,
  communityPeople,
  communityRows,
} from "./components";
import {
  useAnalyticsFilters,
  useAnalyticsResource,
  useOperatorSigner,
} from "./hooks";
import type { CommunitiesData } from "./types";

export function CommunitiesPage() {
  const signer = useOperatorSigner();
  const filters = useAnalyticsFilters();
  const resource = useAnalyticsResource<CommunitiesData>(
    analyticsPath("communities", { ...filters.query, limit: 200 }),
    { signer, pollMs: 60_000, enabled: Boolean(signer) },
  );
  return (
    <AnalyticsContentState resource={resource}>
      {(data, envelope) => {
        const communities = communityRows(data);
        return (
          <div className="analytics-page">
            <div className="analytics-freshness-row">
              <EnvelopeFreshness envelope={envelope} />
              <span className="analytics-as-of">
                Source observed {formatDate(envelope.as_of)}
              </span>
              <label className="inline-toggle">
                <input
                  type="checkbox"
                  checked={filters.query.include_archived ?? false}
                  onChange={(event) =>
                    filters.update({ include_archived: event.target.checked })
                  }
                />
                Include archived
              </label>
            </div>
            <section className="analytics-panel">
              <SectionHeader title="Community fleet">
                <DefinitionsLink />
              </SectionHeader>
              {communities.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      Community fleet metrics
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Community</th>
                        <th scope="col">Status</th>
                        <th scope="col">Created</th>
                        <th scope="col">People</th>
                        <th scope="col">Memberships</th>
                        <th scope="col">Channels</th>
                        <th scope="col">Threads</th>
                        <th scope="col">Online</th>
                        <th scope="col">DAU / WAU / MAU</th>
                        <th scope="col">Activity</th>
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
                          <td>{formatDate(community.created_at)}</td>
                          <td>{formatCount(communityPeople(community))}</td>
                          <td>{formatCount(community.memberships)}</td>
                          <td>{formatCount(community.channels)}</td>
                          <td>{formatCount(community.threads)}</td>
                          <td>{formatCount(community.online_people)}</td>
                          <td>
                            {formatCount(community.dau)} /{" "}
                            {formatCount(community.wau)} /{" "}
                            {formatCount(community.mau)}
                          </td>
                          <td>{formatCount(community.activity_volume)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              ) : (
                <EmptyState
                  title="No communities in scope"
                  description="Try including archived communities or changing the scope."
                />
              )}
              {data.next_cursor ? (
                <p className="cursor-note">
                  More communities are available through the bounded cursor.
                </p>
              ) : null}
            </section>
          </div>
        );
      }}
    </AnalyticsContentState>
  );
}
