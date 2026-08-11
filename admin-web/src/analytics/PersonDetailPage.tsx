import { personPath } from "./api";
import {
  AnalyticsContentState,
  DataTable,
  DefinitionsLink,
  EmptyState,
  EnvelopeFreshness,
  MetricCard,
  SectionHeader,
  personActivitySummary,
  personLastActivity,
  personMembershipRows,
  personRecord,
  personLabel,
  sessionCommunity,
  sessionId,
  formatCount,
  formatDate,
  shortPubkey,
} from "./components";
import {
  useAnalyticsFilters,
  useAnalyticsResource,
  useOperatorSigner,
} from "./hooks";
import type { PersonDetail } from "./types";

export function PersonDetailPage({ pubkey }: { pubkey: string }) {
  const signer = useOperatorSigner();
  const filters = useAnalyticsFilters();
  const resource = useAnalyticsResource<PersonDetail>(
    personPath(pubkey, filters.query),
    { signer, pollMs: 60_000, enabled: Boolean(signer) },
  );
  return (
    <AnalyticsContentState resource={resource}>
      {(detail, envelope) => {
        const person = personRecord(detail);
        const memberships = personMembershipRows(detail);
        const activity = personActivitySummary(detail.activity);
        const sessions = detail.sessions ?? [];
        const channels = detail.channels ?? [];
        const threadCount = (detail.thread_participation ?? []).reduce(
          (sum, row) => sum + row.thread_count,
          0,
        );
        return (
          <div className="analytics-page analytics-person-page">
            <div className="analytics-freshness-row">
              <a
                className="back-link analytics-back-link"
                href="/analytics/people"
              >
                ← Back to people
              </a>
              <EnvelopeFreshness envelope={envelope} />
            </div>
            <section className="analytics-panel person-profile-panel">
              <div className="person-profile-heading">
                <div className="person-avatar" aria-hidden="true">
                  {personLabel(person).slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <p className="analytics-kicker">Profile</p>
                  <h2>{personLabel(person)}</h2>
                  {person.nip05 ? (
                    <p className="person-nip05">{person.nip05}</p>
                  ) : null}
                  <code>{person.pubkey}</code>
                </div>
                <span className={`person-type person-${person.person_type}`}>
                  {person.person_type}
                </span>
              </div>
              <dl className="metadata-grid">
                <div>
                  <dt>First seen</dt>
                  <dd>{formatDate(person.first_seen)}</dd>
                </div>
                <div>
                  <dt>Last meaningful activity</dt>
                  <dd>{formatDate(personLastActivity(person))}</dd>
                </div>
                <div>
                  <dt>Community memberships</dt>
                  <dd>{formatCount(person.membership_count)}</dd>
                </div>
                <div>
                  <dt>Channels</dt>
                  <dd>{formatCount(person.channel_count)}</dd>
                </div>
                <div>
                  <dt>Owned agents</dt>
                  <dd>{formatCount(person.owned_agent_count)}</dd>
                </div>
                <div>
                  <dt>Deactivated</dt>
                  <dd>{person.deactivated ? "Yes" : "No"}</dd>
                </div>
              </dl>
            </section>

            <section className="analytics-panel">
              <SectionHeader title="Memberships and context">
                <DefinitionsLink />
              </SectionHeader>
              <div className="analytics-metric-grid analytics-context-metrics">
                <MetricCard
                  label="Channels"
                  value={person.channel_count ?? channels.length}
                  definition="Authoritative channel memberships"
                />
                <MetricCard
                  label="Threads"
                  value={threadCount}
                  definition="Thread participation metadata"
                />
              </div>
              {memberships.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      Community memberships and context
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Community</th>
                        <th scope="col">Role</th>
                        <th scope="col">Status</th>
                        <th scope="col">Channels</th>
                        <th scope="col">Threads</th>
                        <th scope="col">Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {memberships.map((membership) => (
                        <tr key={membership.community_id}>
                          <th scope="row">
                            {membership.community_name ||
                              membership.community_host}
                            <small>{membership.community_host}</small>
                          </th>
                          <td>{membership.role || "Member"}</td>
                          <td>{membership.status || "Active"}</td>
                          <td>{formatCount(membership.channel_count)}</td>
                          <td>{formatCount(membership.thread_count)}</td>
                          <td>{formatDate(membership.joined_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              ) : (
                <EmptyState
                  title="No memberships"
                  description="This identity has no active membership rows in the selected scope."
                />
              )}
            </section>

            <section className="analytics-panel">
              <SectionHeader title="Activity">
                <DefinitionsLink />
              </SectionHeader>
              <div className="analytics-metric-grid analytics-person-metrics">
                <MetricCard label="DAU" value={activity.dau} />
                <MetricCard label="WAU" value={activity.wau} />
                <MetricCard label="MAU" value={activity.mau} />
                <MetricCard
                  label="Activity volume"
                  value={activity.event_count}
                />
              </div>
              {activity.families?.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      Activity families
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Family</th>
                        <th scope="col">Events</th>
                        <th scope="col">Active days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.families.map((family) => (
                        <tr key={family.family}>
                          <th scope="row">{family.family}</th>
                          <td>{formatCount(family.event_count)}</td>
                          <td>{formatCount(family.unique_days)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              ) : (
                <p className="panel-note">
                  No qualifying activity families in this window.
                </p>
              )}
            </section>

            <section className="analytics-panel">
              <SectionHeader title="Sessions">
                <a className="panel-action" href="/analytics/sessions">
                  Open session view
                </a>
              </SectionHeader>
              {sessions.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      Current session metadata
                    </caption>
                    <thead>
                      <tr>
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
                        <tr key={session.session_id}>
                          <th scope="row">{sessionCommunity(session)}</th>
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
              ) : (
                <EmptyState
                  title="No active sessions"
                  description="This person has no fresh authenticated session leases."
                />
              )}
            </section>
          </div>
        );
      }}
    </AnalyticsContentState>
  );
}
