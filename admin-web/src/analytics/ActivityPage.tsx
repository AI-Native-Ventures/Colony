import { analyticsPath } from "./api";
import {
  AnalyticsContentState,
  DataTable,
  DefinitionsLink,
  EmptyState,
  EnvelopeFreshness,
  SectionHeader,
  activityFamilyName,
  formatCount,
} from "./components";
import {
  useAnalyticsFilters,
  useAnalyticsResource,
  useOperatorSigner,
} from "./hooks";
import type { ActivityData, ActivityFamily } from "./types";

const families: Array<ActivityFamily | "all"> = [
  "all",
  "message",
  "thread",
  "reaction",
  "channel",
  "command",
  "workflow",
  "git",
  "huddle",
];

export function ActivityPage() {
  const signer = useOperatorSigner();
  const filters = useAnalyticsFilters();
  const resource = useAnalyticsResource<ActivityData>(
    analyticsPath("activity", filters.query),
    { signer, pollMs: 60_000, enabled: Boolean(signer) },
  );
  return (
    <AnalyticsContentState resource={resource}>
      {(data, envelope) => {
        const points = data.points ?? [];
        const familyRows = data.families ?? [];
        const maxVolume = Math.max(
          1,
          ...points.map((point) => point.activity_volume),
        );
        return (
          <div className="analytics-page">
            <section className="analytics-panel">
              <SectionHeader title="Meaningful activity">
                <DefinitionsLink />
              </SectionHeader>
              <div className="directory-filters activity-filters">
                <label>
                  <span>Activity family</span>
                  <select
                    aria-label="Activity family"
                    value={filters.query.family ?? "all"}
                    onChange={(event) =>
                      filters.update({
                        family:
                          event.target.value === "all"
                            ? undefined
                            : (event.target.value as ActivityFamily),
                      })
                    }
                  >
                    {families.map((family) => (
                      <option key={family} value={family}>
                        {family === "all" ? "All families" : family}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="panel-note">
                  Presence, typing, authentication, and transport heartbeats are
                  excluded.
                </p>
              </div>
              <div className="analytics-freshness-row">
                <EnvelopeFreshness envelope={envelope} />
                <span className="analytics-as-of">
                  {envelope.definitions_version} definitions
                </span>
              </div>
              {points.length ? (
                <section
                  className="activity-chart"
                  aria-label="Daily activity chart"
                >
                  {points.map((point) => (
                    <div className="activity-bar-row" key={point.utc_day}>
                      <span>{point.utc_day}</span>
                      <div className="activity-bar-track">
                        <div
                          className="activity-bar"
                          style={{
                            width: `${Math.max(2, (point.activity_volume / maxVolume) * 100)}%`,
                          }}
                        />
                      </div>
                      <strong>{formatCount(point.activity_volume)}</strong>
                    </div>
                  ))}
                </section>
              ) : (
                <EmptyState
                  title="No meaningful activity"
                  description="No qualifying accepted activity exists for this window."
                />
              )}
            </section>
            <div className="analytics-panel-grid">
              <section className="analytics-panel">
                <SectionHeader title="Activity families">
                  <DefinitionsLink />
                </SectionHeader>
                {familyRows.length ? (
                  <DataTable>
                    <table>
                      <caption className="visually-hidden">
                        Activity family breakdown
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Family</th>
                          <th scope="col">Events</th>
                          <th scope="col">Unique people</th>
                        </tr>
                      </thead>
                      <tbody>
                        {familyRows.map((row) => (
                          <tr key={activityFamilyName(row)}>
                            <th scope="row">{activityFamilyName(row)}</th>
                            <td>{formatCount(row.event_count)}</td>
                            <td>{formatCount(row.unique_people)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                ) : (
                  <EmptyState title="No activity families" />
                )}
              </section>
              <section className="analytics-panel">
                <SectionHeader title="Identity mix">
                  <DefinitionsLink />
                </SectionHeader>
                {data.people?.length ? (
                  <DataTable>
                    <table>
                      <caption className="visually-hidden">
                        Human, agent, and unknown activity
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Type</th>
                          <th scope="col">Events</th>
                          <th scope="col">Unique people</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.people.map((row) => (
                          <tr key={row.person_type}>
                            <th scope="row">{row.person_type}</th>
                            <td>{formatCount(row.event_count)}</td>
                            <td>{formatCount(row.unique_people)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                ) : (
                  <EmptyState title="No identity slices" />
                )}
              </section>
            </div>
          </div>
        );
      }}
    </AnalyticsContentState>
  );
}
