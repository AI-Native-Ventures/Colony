import { useState } from "react";
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
  personLabel,
  personLastActivity,
  shortPubkey,
} from "./components";
import {
  useAnalyticsFilters,
  useAnalyticsResource,
  useOperatorSigner,
} from "./hooks";
import type { PeopleData, PersonType } from "./types";

export function PeoplePage() {
  const signer = useOperatorSigner();
  const filters = useAnalyticsFilters();
  const [search, setSearch] = useState(filters.query.search ?? "");
  const resource = useAnalyticsResource<PeopleData>(
    analyticsPath("people", { ...filters.query, limit: 50 }),
    { signer, pollMs: 60_000, enabled: Boolean(signer) },
  );
  const applySearch = (value: string) => {
    setSearch(value);
    filters.update({ search: value });
  };
  return (
    <AnalyticsContentState resource={resource}>
      {(data, envelope) => {
        const people = data.items ?? data.rows ?? [];
        return (
          <div className="analytics-page">
            <section className="analytics-panel analytics-directory-panel">
              <SectionHeader title="People directory">
                <DefinitionsLink />
              </SectionHeader>
              <div className="directory-filters">
                <label className="search-field analytics-search-field">
                  <span>Search display name, NIP-05, or pubkey</span>
                  <input
                    type="search"
                    aria-label="Search people"
                    placeholder="Search people"
                    value={search}
                    onChange={(event) => applySearch(event.target.value)}
                  />
                </label>
                <label>
                  <span>Type</span>
                  <select
                    aria-label="Person type"
                    value={filters.query.type ?? "all"}
                    onChange={(event) =>
                      filters.update({
                        type:
                          event.target.value === "all"
                            ? undefined
                            : (event.target.value as PersonType),
                      })
                    }
                  >
                    <option value="all">All types</option>
                    <option value="human">Human</option>
                    <option value="agent">Agent</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </label>
                <label className="inline-toggle directory-online-toggle">
                  <input
                    type="checkbox"
                    checked={filters.query.online ?? false}
                    onChange={(event) =>
                      filters.update({
                        online: event.target.checked ? true : undefined,
                      })
                    }
                  />
                  Online now
                </label>
              </div>
              <div className="analytics-freshness-row">
                <EnvelopeFreshness envelope={envelope} />
                <span className="analytics-as-of">
                  {data.total === undefined
                    ? `${people.length} visible people`
                    : `${formatCount(data.total)} people`}
                </span>
              </div>
              {people.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      People and activity metadata
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Person</th>
                        <th scope="col">Type</th>
                        <th scope="col">Communities</th>
                        <th scope="col">Channels</th>
                        <th scope="col">Owned agents</th>
                        <th scope="col">First seen</th>
                        <th scope="col">Last activity</th>
                        <th scope="col">Sessions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((person) => (
                        <tr key={person.pubkey}>
                          <th scope="row">
                            <a
                              href={`/analytics/people/${encodeURIComponent(person.pubkey)}`}
                            >
                              {personLabel(person)}
                            </a>
                            {person.nip05 ? (
                              <small>{person.nip05}</small>
                            ) : (
                              <small>{shortPubkey(person.pubkey)}</small>
                            )}
                          </th>
                          <td>
                            <span
                              className={`person-type person-${person.person_type}`}
                            >
                              {person.person_type}
                            </span>
                          </td>
                          <td>
                            {formatCount(person.community_count)} /{" "}
                            {formatCount(person.membership_count)} memberships
                          </td>
                          <td>{formatCount(person.channel_count)}</td>
                          <td>{formatCount(person.owned_agent_count)}</td>
                          <td>{formatDate(person.first_seen)}</td>
                          <td>{formatDate(personLastActivity(person))}</td>
                          <td>
                            <span
                              className={
                                person.online ? "online-state" : "offline-state"
                              }
                            >
                              {person.online ? "Online" : "Offline"}
                            </span>{" "}
                            · {formatCount(person.session_count)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              ) : (
                <EmptyState
                  title={search ? "No matching people" : "No people in scope"}
                  description="People rows contain metadata only."
                />
              )}
              {data.next_cursor ? (
                <p className="cursor-note">
                  More people are available through the bounded cursor.
                </p>
              ) : null}
            </section>
          </div>
        );
      }}
    </AnalyticsContentState>
  );
}
