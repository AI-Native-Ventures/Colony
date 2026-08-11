import { analyticsPath } from "./api";
import {
  AnalyticsContentState,
  DataTable,
  EmptyState,
  EnvelopeFreshness,
  SectionHeader,
} from "./components";
import { useAnalyticsResource, useOperatorSigner } from "./hooks";
import type { DefinitionsData } from "./types";

export function DefinitionsPage() {
  const signer = useOperatorSigner();
  const resource = useAnalyticsResource<DefinitionsData>(
    analyticsPath("definitions"),
    { signer, pollMs: 0, enabled: Boolean(signer) },
  );
  return (
    <AnalyticsContentState resource={resource}>
      {(data, envelope) => (
        <div className="analytics-page">
          <div className="analytics-freshness-row">
            <EnvelopeFreshness envelope={envelope} />
            <span className="analytics-as-of">
              Definitions version {data.version || envelope.definitions_version}
            </span>
          </div>
          <section className="analytics-panel">
            <SectionHeader title="Metric definitions" />
            <p className="definitions-intro">
              These definitions describe deployment truth, not product signup or
              a client-side analytics vendor. Dates are UTC, people are
              deduplicated by pubkey, and each source reports its own freshness
              watermark.
            </p>
            {data.metrics?.length ? (
              <DataTable>
                <table>
                  <caption className="visually-hidden">
                    Analytics metric definitions
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Definition</th>
                      <th scope="col">Source</th>
                      <th scope="col">Exclusions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.metrics.map((metric) => (
                      <tr key={metric.key}>
                        <th scope="row">{metric.label}</th>
                        <td>{metric.definition}</td>
                        <td>{metric.source}</td>
                        <td>{metric.exclusions?.join(" · ") || "None"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            ) : (
              <EmptyState title="Definitions unavailable" />
            )}
          </section>
          <div className="analytics-panel-grid">
            <section className="analytics-panel">
              <SectionHeader title="Activity families" />
              {data.families?.length ? (
                <DataTable>
                  <table>
                    <caption className="visually-hidden">
                      Versioned activity families
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Family</th>
                        <th scope="col">Kinds</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.families.map((family) => (
                        <tr key={family.family}>
                          <th scope="row">{family.label || family.family}</th>
                          <td>{family.kinds.join(", ")}</td>
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
              <SectionHeader title="Excluded from meaningful activity" />
              {data.exclusions?.length ? (
                <ul className="definition-list">
                  {data.exclusions.map((exclusion) => (
                    <li key={exclusion}>{exclusion}</li>
                  ))}
                </ul>
              ) : (
                <p className="panel-note">No exclusions supplied.</p>
              )}
              <p className="panel-note">
                Client-local configuration is not deployment analytics unless
                the relay supplies an authoritative record.
              </p>
            </section>
          </div>
          {data.sources?.length ? (
            <section className="analytics-panel">
              <SectionHeader title="Authoritative sources" />
              <ul className="definition-list">
                {data.sources.map((source) => (
                  <li key={source}>{source}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </AnalyticsContentState>
  );
}
