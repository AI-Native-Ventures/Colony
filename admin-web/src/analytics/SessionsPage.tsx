import { analyticsPath } from "./api";
import {
  AnalyticsContentState,
  DataTable,
  EmptyState,
  EnvelopeFreshness,
  MetricCard,
  SectionHeader,
  UnavailableState,
  formatDate,
  sessionCommunity,
  sessionId,
  shortPubkey,
} from "./components";
import {
  useAnalyticsFilters,
  useAnalyticsResource,
  useOperatorSigner,
} from "./hooks";
import type { SessionData } from "./types";

export function SessionsPage() {
  const signer = useOperatorSigner();
  const filters = useAnalyticsFilters();
  const resource = useAnalyticsResource<SessionData>(
    analyticsPath("sessions", {
      ...filters.query,
      status: "active",
      limit: 200,
    }),
    { signer, pollMs: 15_000, enabled: Boolean(signer) },
  );
  return (
    <AnalyticsContentState resource={resource}>
      {(data, envelope) => {
        const liveUnavailable =
          envelope.freshness.live.status === "unavailable";
        const sessions = data.items ?? data.rows ?? [];
        return (
          <div className="analytics-page">
            <section className="analytics-panel">
              <SectionHeader title="Live sessions">
                <EnvelopeFreshness envelope={envelope} live />
              </SectionHeader>
              {liveUnavailable ? <UnavailableState /> : null}
              <div className="analytics-metric-grid session-summary-grid">
                <MetricCard label="Online people" value={data.online_people} />
                <MetricCard
                  label="Authenticated sessions"
                  value={data.authenticated_sessions}
                />
                <MetricCard
                  label="Open connections"
                  value={data.open_connections}
                />
              </div>
              <p className="panel-note">
                A person with multiple connections counts once online, once per
                session, and once per raw connection.
              </p>
              {sessions.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      Authenticated connection leases
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Person</th>
                        <th scope="col">Community</th>
                        <th scope="col">Session</th>
                        <th scope="col">Started</th>
                        <th scope="col">Last heartbeat</th>
                        <th scope="col">Pod</th>
                        <th scope="col">Network</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((session) => (
                        <tr key={sessionId(session)}>
                          <th scope="row">
                            <a
                              href={`/analytics/people/${encodeURIComponent(session.pubkey)}`}
                            >
                              {shortPubkey(session.pubkey)}
                            </a>
                          </th>
                          <td>{sessionCommunity(session)}</td>
                          <td>
                            <code>{shortPubkey(sessionId(session))}</code>
                          </td>
                          <td>{formatDate(session.started_at)}</td>
                          <td>{formatDate(session.last_seen_at)}</td>
                          <td>
                            {session.pod || session.pod_id || "Not available"}
                          </td>
                          <td>
                            {session.network ||
                              session.network_cidr ||
                              "Not available"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              ) : liveUnavailable ? null : (
                <EmptyState
                  title="No active sessions"
                  description="No fresh authenticated session leases are in scope."
                />
              )}
            </section>
          </div>
        );
      }}
    </AnalyticsContentState>
  );
}
