//! Embedded SQLx migrations for Buzz.
//!
//! Fresh deployments apply the checked-in SQL files under `migrations/`. The
//! multi-tenant rewrite owns a clean consolidated `0001`; legacy single-tenant
//! cutover/backfill is a separate operator script, not startup migration state.

use buzz_core::discovery_worker::{
    canonical_business_domain_digest, normalized_business_name_locality_digest,
    normalized_business_phone_digest,
};
use sqlx::{PgPool, Row};

use crate::Result;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

/// Run all pending Buzz database migrations.
pub async fn run_migrations(pool: &PgPool) -> Result<()> {
    reject_legacy_nip_rs_cardinality_ambiguity(pool).await?;
    MIGRATOR.run(pool).await?;
    backfill_discovery_dedupe_digests(pool).await?;
    // The replica-fence proof (see `replica_fence`) requires the commit-time
    // `created_at` floor trigger from migration 0021 — correctly shaped — on
    // the `events` parent and every partition. `CREATE TABLE .. PARTITION OF`
    // clones parent triggers, but a partition attached with `ATTACH
    // PARTITION` or created by an older code path would silently escape the
    // guard, so migration fails closed if any is missing. (The fence probe
    // re-runs this same check at startup on non-migrating relays.)
    crate::replica_fence::verify_floor_guard_catalog(pool).await?;
    Ok(())
}

/// Backfill pre-multi-source paid observations with the exact runtime
/// normalizers. The version cursor makes this bounded, restart-safe, and
/// idempotent even when multiple relay instances start together.
async fn backfill_discovery_dedupe_digests(pool: &PgPool) -> Result<()> {
    const BATCH_SIZE: i64 = 500;
    loop {
        let mut tx = pool.begin().await?;
        let rows = sqlx::query(
            "SELECT community_id,id,name,website,phone,city,state,country \
             FROM discovery_business_observations \
             WHERE dedupe_digest_version=0 \
             ORDER BY community_id,id FOR UPDATE SKIP LOCKED LIMIT $1",
        )
        .bind(BATCH_SIZE)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            tx.commit().await?;
            break;
        }

        let mut community_ids = Vec::with_capacity(rows.len());
        let mut observation_ids = Vec::with_capacity(rows.len());
        let mut domain_digests = Vec::with_capacity(rows.len());
        let mut phone_digests = Vec::with_capacity(rows.len());
        let mut name_locality_digests = Vec::with_capacity(rows.len());
        for row in rows {
            let community_id: uuid::Uuid = row.try_get("community_id")?;
            let observation_id: uuid::Uuid = row.try_get("id")?;
            let name: String = row.try_get("name")?;
            let website: Option<String> = row.try_get("website")?;
            let phone: Option<String> = row.try_get("phone")?;
            let city: Option<String> = row.try_get("city")?;
            let state: Option<String> = row.try_get("state")?;
            let country: Option<String> = row.try_get("country")?;
            let domain_digest = website
                .as_deref()
                .and_then(canonical_business_domain_digest);
            let phone_digest = phone.as_deref().and_then(normalized_business_phone_digest);
            let name_locality_digest = normalized_business_name_locality_digest(
                &name,
                city.as_deref(),
                state.as_deref(),
                country.as_deref(),
            );
            community_ids.push(community_id);
            observation_ids.push(observation_id);
            domain_digests.push(domain_digest.map(Vec::from));
            phone_digests.push(phone_digest.map(Vec::from));
            name_locality_digests.push(name_locality_digest.map(Vec::from));
        }
        sqlx::query(
            "UPDATE discovery_business_observations observation \
             SET canonical_domain_digest=batch.domain_digest, \
                 normalized_phone_digest=batch.phone_digest, \
                 normalized_name_locality_digest=batch.name_locality_digest, \
                 dedupe_digest_version=1 \
             FROM UNNEST($1::uuid[],$2::uuid[],$3::bytea[],$4::bytea[],$5::bytea[]) \
                  AS batch(community_id,id,domain_digest,phone_digest,name_locality_digest) \
             WHERE observation.community_id=batch.community_id \
               AND observation.id=batch.id AND observation.dedupe_digest_version=0",
        )
        .bind(&community_ids)
        .bind(&observation_ids)
        .bind(&domain_digests)
        .bind(&phone_digests)
        .bind(&name_locality_digests)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(())
}

/// Migration 0007 is checksum-frozen and predates exact NIP-RS tag-cardinality
/// enforcement. A populated database still on 0001-0006 must not let 0007
/// irreversibly purge duplicate-tag history. Fail before sqlx starts its
/// migration transaction so an operator can inspect and repair those rows.
async fn reject_legacy_nip_rs_cardinality_ambiguity(pool: &PgPool) -> Result<()> {
    let migrations_table: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations')::text")
            .fetch_one(pool)
            .await?;
    if migrations_table.is_none() {
        return Ok(());
    }
    let applied: Option<i64> =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success")
            .fetch_one(pool)
            .await?;
    if applied.is_none_or(|version| version >= 7) {
        return Ok(());
    }

    let ambiguous: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
             SELECT 1 FROM events e \
             WHERE e.kind = 30078 \
               AND e.d_tag ~ '^read-state:[0-9a-f]{32}$' \
               AND (\
                   jsonb_typeof(e.tags) IS DISTINCT FROM 'array' \
                   OR (\
                       EXISTS (\
                           SELECT 1 FROM jsonb_array_elements(\
                               CASE WHEN jsonb_typeof(e.tags) = 'array' THEN e.tags ELSE '[]'::jsonb END\
                           ) tag \
                           WHERE tag = '[\"t\", \"read-state\"]'::jsonb\
                       ) \
                       AND (\
                           (SELECT count(*) FROM jsonb_array_elements(\
                               CASE WHEN jsonb_typeof(e.tags) = 'array' THEN e.tags ELSE '[]'::jsonb END\
                            ) tag \
                            WHERE jsonb_typeof(tag) = 'array' \
                              AND tag->0 = '\"d\"'::jsonb) <> 1 \
                           OR NOT EXISTS (\
                               SELECT 1 FROM jsonb_array_elements(\
                                   CASE WHEN jsonb_typeof(e.tags) = 'array' THEN e.tags ELSE '[]'::jsonb END\
                               ) tag \
                               WHERE jsonb_typeof(tag) = 'array' \
                                 AND jsonb_array_length(tag) >= 2 \
                                 AND jsonb_typeof(tag->1) = 'string' \
                                 AND tag->>0 = 'd' \
                                 AND tag->>1 = e.d_tag\
                           ) \
                           OR (SELECT count(*) FROM jsonb_array_elements(\
                               CASE WHEN jsonb_typeof(e.tags) = 'array' THEN e.tags ELSE '[]'::jsonb END\
                           ) tag WHERE tag = '[\"t\", \"read-state\"]'::jsonb) <> 1\
                       )\
                   )\
               )\
         )",
    )
    .fetch_one(pool)
    .await?;

    if ambiguous {
        return Err(crate::DbError::InvalidData(
            "NIP-RS migration blocked: pre-0007 database contains kind-30078 rows with ambiguous d/t tag cardinality; repair or remove those nonconforming rows before retrying"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ConstraintKind {
        ForeignKey,
        PrimaryKey,
        Unique,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ConstraintLint {
        table: String,
        kind: ConstraintKind,
        description: String,
        columns: Vec<String>,
    }

    /// Concatenated SQL of every embedded migration, in version order.
    ///
    /// The tenant-isolation lints must cover objects introduced by *any*
    /// migration, not just the consolidated `0001`. Concatenating keeps that
    /// coverage honest as additive migrations (e.g. `0002_git_repo_names`) land.
    fn migration_sql() -> String {
        let mut migrations: Vec<_> = MIGRATOR.iter().collect();
        migrations.sort_by_key(|migration| migration.version);
        assert!(
            !migrations.is_empty(),
            "at least the initial migration must exist"
        );
        migrations
            .iter()
            .map(|migration| migration.sql.as_ref())
            .collect::<Vec<&str>>()
            .join("\n")
    }

    fn strip_sql_comments(sql: &str) -> String {
        sql.lines()
            .map(|line| line.split_once("--").map_or(line, |(before, _)| before))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn normalize_sql(sql: &str) -> String {
        strip_sql_comments(sql)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase()
    }

    fn split_sql_statements(sql: &str) -> Vec<String> {
        let sql = strip_sql_comments(sql);
        let bytes = sql.as_bytes();
        let mut statements = Vec::new();
        let mut start = 0usize;
        let mut idx = 0usize;
        let mut in_single_quote = false;
        let mut in_dollar_quote = false;

        while idx < bytes.len() {
            match bytes[idx] {
                b'\'' if !in_dollar_quote => {
                    in_single_quote = !in_single_quote;
                    idx += 1;
                }
                b'$' if !in_single_quote && idx + 1 < bytes.len() && bytes[idx + 1] == b'$' => {
                    in_dollar_quote = !in_dollar_quote;
                    idx += 2;
                }
                b';' if !in_single_quote && !in_dollar_quote => {
                    let statement = sql[start..idx].trim();
                    if !statement.is_empty() {
                        statements.push(statement.to_owned());
                    }
                    start = idx + 1;
                    idx += 1;
                }
                _ => idx += 1,
            }
        }

        let tail = sql[start..].trim();
        if !tail.is_empty() {
            statements.push(tail.to_owned());
        }

        statements
    }

    fn find_matching_paren(sql: &str, open: usize) -> Option<usize> {
        let mut depth = 0usize;
        for (offset, byte) in sql.as_bytes()[open..].iter().enumerate() {
            match byte {
                b'(' => depth += 1,
                b')' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(open + offset);
                    }
                }
                _ => {}
            }
        }
        None
    }

    fn split_top_level_csv(input: &str) -> Vec<String> {
        let mut parts = Vec::new();
        let mut start = 0usize;
        let mut depth = 0usize;
        for (idx, byte) in input.bytes().enumerate() {
            match byte {
                b'(' => depth += 1,
                b')' => depth = depth.saturating_sub(1),
                b',' if depth == 0 => {
                    parts.push(input[start..idx].trim().to_owned());
                    start = idx + 1;
                }
                _ => {}
            }
        }
        let tail = input[start..].trim();
        if !tail.is_empty() {
            parts.push(tail.to_owned());
        }
        parts
    }

    fn identifier_after_keyword(statement: &str, keyword: &str) -> Option<String> {
        let lower = statement.to_ascii_lowercase();
        let keyword_pos = lower.find(keyword)?;
        let mut remainder = statement[keyword_pos + keyword.len()..].trim_start();
        for prefix in ["if not exists", "if exists", "only"] {
            if remainder.to_ascii_lowercase().starts_with(prefix) {
                remainder = remainder[prefix.len()..].trim_start();
            }
        }

        let identifier = remainder
            .split(|ch: char| ch.is_whitespace() || ch == '(')
            .next()?
            .trim_matches('"')
            .rsplit('.')
            .next()?
            .trim_matches('"')
            .to_ascii_lowercase();
        (!identifier.is_empty()).then_some(identifier)
    }

    fn first_parenthesized_columns(input: &str) -> Vec<String> {
        let Some(open) = input.find('(') else {
            return Vec::new();
        };
        let Some(close) = find_matching_paren(input, open) else {
            return Vec::new();
        };

        split_top_level_csv(&input[open + 1..close])
            .into_iter()
            .filter_map(|column| {
                let name = column
                    .trim()
                    .trim_matches('"')
                    .split_whitespace()
                    .next()?
                    .trim_matches('"')
                    .to_ascii_lowercase();
                (!name.is_empty()).then_some(name)
            })
            .collect()
    }

    fn column_definition_name(definition: &str) -> Option<String> {
        let trimmed = definition.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("constraint ")
            || lower.starts_with("primary key")
            || lower.starts_with("foreign key")
            || lower.starts_with("unique")
            || lower.starts_with("check ")
            || lower.starts_with("exclude ")
        {
            return None;
        }

        let name = trimmed
            .split_whitespace()
            .next()?
            .trim_matches('"')
            .to_ascii_lowercase();
        (!name.is_empty()).then_some(name)
    }

    fn create_table_body(statement: &str) -> Option<(String, Vec<String>)> {
        let table = identifier_after_keyword(statement, "create table")?;
        let open = statement.find('(')?;
        let close = find_matching_paren(statement, open)?;
        Some((table, split_top_level_csv(&statement[open + 1..close])))
    }

    fn create_table_definitions(sql: &str) -> Vec<(String, Vec<String>)> {
        split_sql_statements(sql)
            .into_iter()
            .filter_map(|statement| {
                let normalized = statement.trim_start().to_ascii_lowercase();
                if !normalized.starts_with("create table") || normalized.contains(" partition of ")
                {
                    return None;
                }
                create_table_body(&statement)
            })
            .collect()
    }

    fn create_tables(sql: &str) -> BTreeSet<String> {
        create_table_definitions(sql)
            .into_iter()
            .map(|(table, _)| table)
            .collect()
    }

    fn table_has_not_null_community_id(definitions: &[String]) -> bool {
        definitions.iter().any(|definition| {
            column_definition_name(definition).as_deref() == Some("community_id")
                && normalize_sql(definition).contains("not null")
        })
    }

    fn operator_global_tables(sql: &str) -> BTreeSet<String> {
        let mut globals = BTreeSet::new();
        let normalized = normalize_sql(sql);
        let Some(insert_pos) = normalized.find("insert into _operator_global_tables") else {
            return globals;
        };

        for value in [
            "communities",
            "rate_limit_violations",
            "_operator_global_tables",
            "push_gateway_challenges",
            "push_gateway_installations",
            "push_gateway_delegations",
            "push_gateway_endpoint_quotas",
            "push_gateway_delivery_auth_replays",
            "push_gateway_delivery_request_replays",
            "product_feedback",
            "replica_heartbeat",
        ] {
            if normalized[insert_pos..].contains(&format!("'{value}'")) {
                globals.insert(value.to_owned());
            }
        }

        globals
    }

    fn scoped_tables(sql: &str) -> BTreeSet<String> {
        let globals = operator_global_tables(sql);
        create_tables(sql)
            .into_iter()
            .filter(|table| !globals.contains(table))
            .collect()
    }

    fn constraint_lint_for_definition(table: &str, definition: &str) -> Option<ConstraintLint> {
        let normalized = normalize_sql(definition);
        let definition_without_name = if normalized.starts_with("constraint ") {
            let after_constraint = definition
                .trim_start()
                .splitn(3, char::is_whitespace)
                .nth(2)
                .unwrap_or("");
            normalize_sql(after_constraint)
        } else {
            normalized.clone()
        };

        if definition_without_name.starts_with("primary key") {
            Some(ConstraintLint {
                table: table.to_owned(),
                kind: ConstraintKind::PrimaryKey,
                description: definition.to_owned(),
                columns: first_parenthesized_columns(&definition_without_name),
            })
        } else if definition_without_name.starts_with("unique") {
            Some(ConstraintLint {
                table: table.to_owned(),
                kind: ConstraintKind::Unique,
                description: definition.to_owned(),
                columns: first_parenthesized_columns(&definition_without_name),
            })
        } else if definition_without_name.starts_with("foreign key") {
            Some(ConstraintLint {
                table: table.to_owned(),
                kind: ConstraintKind::ForeignKey,
                description: definition.to_owned(),
                columns: first_parenthesized_columns(&definition_without_name),
            })
        } else if normalized.contains(" primary key") {
            column_definition_name(definition).map(|column| ConstraintLint {
                table: table.to_owned(),
                kind: ConstraintKind::PrimaryKey,
                description: definition.to_owned(),
                columns: vec![column],
            })
        } else if normalized.contains(" references ") {
            column_definition_name(definition).map(|column| ConstraintLint {
                table: table.to_owned(),
                kind: ConstraintKind::ForeignKey,
                description: definition.to_owned(),
                columns: vec![column],
            })
        } else if normalized.contains(" unique") {
            column_definition_name(definition).map(|column| ConstraintLint {
                table: table.to_owned(),
                kind: ConstraintKind::Unique,
                description: definition.to_owned(),
                columns: vec![column],
            })
        } else {
            None
        }
    }

    fn table_constraints(sql: &str, scoped_tables: &BTreeSet<String>) -> Vec<ConstraintLint> {
        create_table_definitions(sql)
            .into_iter()
            .filter(|(table, _)| scoped_tables.contains(table))
            .flat_map(|(table, definitions)| {
                definitions.into_iter().filter_map(move |definition| {
                    constraint_lint_for_definition(&table, &definition)
                })
            })
            .collect()
    }

    fn alter_table_constraints(sql: &str, scoped_tables: &BTreeSet<String>) -> Vec<ConstraintLint> {
        split_sql_statements(sql)
            .into_iter()
            .filter_map(|statement| {
                let normalized = normalize_sql(&statement);
                if !normalized.starts_with("alter table") {
                    return None;
                }

                let table = identifier_after_keyword(&statement, "alter table")?;
                if !scoped_tables.contains(&table) {
                    return None;
                }

                let add_pos = normalized.find(" add ")?;
                let definition = normalized[add_pos + " add ".len()..].trim();
                constraint_lint_for_definition(&table, definition)
            })
            .collect()
    }

    fn unique_indexes(sql: &str, scoped_tables: &BTreeSet<String>) -> Vec<ConstraintLint> {
        split_sql_statements(sql)
            .into_iter()
            .filter_map(|statement| {
                let normalized = normalize_sql(&statement);
                if !normalized.starts_with("create unique index") {
                    return None;
                }

                let lower_statement = statement.to_ascii_lowercase();
                let on_pos = lower_statement.find(" on ")?;
                let table = statement[on_pos + " on ".len()..]
                    .trim_start()
                    .split(|ch: char| ch.is_whitespace() || ch == '(')
                    .next()?
                    .trim_matches('"')
                    .rsplit('.')
                    .next()?
                    .trim_matches('"')
                    .to_ascii_lowercase();

                scoped_tables.contains(&table).then(|| ConstraintLint {
                    table,
                    kind: ConstraintKind::Unique,
                    description: statement.clone(),
                    columns: first_parenthesized_columns(&statement[on_pos + " on ".len()..]),
                })
            })
            .collect()
    }

    fn scoped_constraint_lints(sql: &str, scoped_tables: &BTreeSet<String>) -> Vec<ConstraintLint> {
        let mut constraints = table_constraints(sql, scoped_tables);
        constraints.extend(alter_table_constraints(sql, scoped_tables));
        constraints.extend(unique_indexes(sql, scoped_tables));
        constraints
    }

    fn is_allowed_partition_primary_key_exception(constraint: &ConstraintLint) -> bool {
        constraint.table == "delivery_log"
            && constraint.kind == ConstraintKind::PrimaryKey
            && constraint.columns == ["delivered_at", "id"]
    }

    fn scoped_constraint_violations(sql: &str) -> Vec<ConstraintLint> {
        let scoped_tables = scoped_tables(sql);
        scoped_constraint_lints(sql, &scoped_tables)
            .into_iter()
            .filter(|constraint| {
                if is_allowed_partition_primary_key_exception(constraint) {
                    return false;
                }
                constraint.columns.first().map(String::as_str) != Some("community_id")
            })
            .collect()
    }

    fn has_channels_community_id_immutability_guard(sql: &str) -> bool {
        let normalized = normalize_sql(sql);
        normalized.contains("create trigger")
            && normalized.contains("before update")
            && normalized.contains(" on channels")
            && normalized.contains("community_id")
            && normalized.contains("old.community_id")
            && normalized.contains("new.community_id")
            && normalized.contains("raise exception")
    }

    fn forbidden_channels_community_id_mutations(sql: &str) -> Vec<String> {
        split_sql_statements(sql)
            .into_iter()
            .filter(|statement| {
                let normalized = normalize_sql(statement);
                let updates_channels =
                    identifier_after_keyword(statement, "update").as_deref() == Some("channels");
                let update_assignments = normalized
                    .split_once(" set ")
                    .map(|(_, tail)| tail.split_once(" where ").map_or(tail, |(set, _)| set));
                let mutates_with_update = updates_channels
                    && update_assignments
                        .is_some_and(|assignments| assignments.contains("community_id"));
                let alters_channels = identifier_after_keyword(statement, "alter table").as_deref()
                    == Some("channels");
                let drops_channels = identifier_after_keyword(statement, "drop table").as_deref()
                    == Some("channels");
                let drops_or_rewrites_column = alters_channels
                    && (normalized.contains("drop column community_id")
                        || normalized.contains("alter column community_id")
                        || normalized.contains("rename column community_id")
                        || normalized.contains("rename community_id")
                        || normalized.contains("drop trigger")
                        || normalized.contains("disable trigger"));

                mutates_with_update || drops_or_rewrites_column || drops_channels
            })
            .collect()
    }

    #[test]
    fn embedded_migrator_contains_consolidated_initial_schema() {
        let mut migrations: Vec<_> = MIGRATOR.iter().collect();
        migrations.sort_by_key(|migration| migration.version);

        assert_eq!(migrations.len(), 43);
        assert_eq!(migrations[0].version, 1);
        assert_eq!(&*migrations[0].description, "initial schema");
        assert!(migrations[0]
            .sql
            .as_str()
            .contains("CREATE TABLE communities"));
        assert!(migrations[0].sql.as_str().contains("CREATE TABLE channels"));
        assert!(migrations[0]
            .sql
            .as_str()
            .contains("CREATE TABLE scheduled_workflow_fires"));
        assert!(migrations[0]
            .sql
            .as_str()
            .contains("CREATE TABLE audit_log"));
        assert_eq!(migrations[30].version, 31);
        assert!(migrations[30]
            .sql
            .as_str()
            .contains("CREATE TABLE discovery_runs"));
        assert_eq!(migrations[31].version, 32);
        assert!(migrations[31]
            .sql
            .as_str()
            .contains("CREATE TABLE discovery_worker_action_claims"));
        assert_eq!(migrations[32].version, 33);
        assert!(migrations[32]
            .sql
            .as_str()
            .contains("CREATE TABLE discovery_run_business_searches"));
        assert_eq!(migrations[33].version, 34);
        assert!(migrations[33]
            .sql
            .as_str()
            .contains("CREATE TABLE discovery_business_observations"));
        assert_eq!(migrations[34].version, 35);
        assert!(migrations[34]
            .sql
            .as_str()
            .contains("'store_observations', 'fail', 'complete'"));
        assert_eq!(migrations[35].version, 36);
        assert!(migrations[35]
            .sql
            .as_str()
            .contains("CREATE TABLE discovery_campaigns"));
        assert_eq!(migrations[38].version, 39);
        assert!(migrations[38]
            .sql
            .as_str()
            .contains("CREATE TABLE discovery_run_source_plans"));
        assert_eq!(migrations[39].version, 40);
        assert!(migrations[39].sql.as_str().contains("'source_progress'"));
        assert_eq!(migrations[40].version, 41);
        let discovery_trials = migrations[40].sql.as_str();
        assert!(discovery_trials.contains("ADD COLUMN expires_at TIMESTAMPTZ"));
        assert!(discovery_trials.contains("now() + interval '30 days'"));
        assert!(discovery_trials.contains("CREATE FUNCTION provision_discovery_trial"));
        assert!(discovery_trials.contains("AFTER INSERT ON communities"));
        assert!(discovery_trials.contains("communities_provision_discovery_trial"));
        assert!(migrations[0]
            .sql
            .as_str()
            .contains("CREATE TABLE _operator_global_tables"));
        assert!(migrations[0]
            .sql
            .as_str()
            .contains("search_tsv  TSVECTOR GENERATED ALWAYS"));

        // The git repo-name registry is an additive migration, never folded into
        // 0001 — folding it would change 0001's checksum and break brownfield
        // startup (sqlx VersionMismatch). It must live in its own version, and
        // 0001 must not carry it.
        assert_eq!(migrations[1].version, 2);
        assert!(migrations[1]
            .sql
            .as_str()
            .contains("CREATE TABLE git_repo_names"));
        assert!(!migrations[0].sql.as_str().contains("git_repo_names"));

        // Same additive-migration rule for the per-community workspace icon
        // (NIP-11 `icon`): its own version, never folded into 0001.
        assert_eq!(migrations[2].version, 3);
        assert!(migrations[2]
            .sql
            .as_str()
            .contains("ALTER TABLE communities ADD COLUMN icon"));
        assert!(!migrations[0].sql.as_str().contains("icon"));
        // Same additive-migration rule for the e-tag containment GIN index
        // (channel-window aux closure): its own version, never folded into 0001.
        assert_eq!(migrations[3].version, 4);
        assert!(migrations[3]
            .sql
            .as_str()
            .contains("CREATE INDEX idx_events_tags_gin"));
        assert!(!migrations[0].sql.as_str().contains("idx_events_tags_gin"));

        // NIP-AM (kind 44200) FTS exclusion: additive migration, never folded
        // into 0001 — folding would change 0001's checksum and break brownfield
        // startup. Migration 5 drops and re-adds the generated `search_tsv`
        // column with the extended kind-44200 exclusion. 0001 must NOT carry 44200.
        assert_eq!(migrations[4].version, 5);
        assert!(migrations[4].sql.as_str().contains("search_tsv"));
        assert!(migrations[4].sql.as_str().contains("44200"));
        assert!(!migrations[0].sql.as_str().contains("44200"));

        // Community moderation (reports/bans/audit): additive migration, never
        // folded into 0001 — same brownfield checksum rule as above.
        assert_eq!(migrations[5].version, 6);
        assert!(migrations[5]
            .sql
            .as_str()
            .contains("CREATE TABLE moderation_reports"));
        assert!(migrations[5]
            .sql
            .as_str()
            .contains("CREATE TABLE community_bans"));
        assert!(migrations[5]
            .sql
            .as_str()
            .contains("CREATE TABLE moderation_actions"));
        for action in crate::moderation::MODERATION_ACTION_CHECK_VOCAB {
            assert!(
                migrations[5].sql.as_str().contains(&format!("'{action}'")),
                "migration 0006 moderation_actions.action CHECK must allow {action}"
            );
        }
        assert!(!migrations[0].sql.as_str().contains("moderation_reports"));
        // NIP-RS retention is additive and boot-safe: seed replay watermarks
        // before deleting payload history, without rewriting search storage.
        assert_eq!(migrations[6].version, 7);
        assert!(migrations[6]
            .sql
            .as_str()
            .contains("LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE"));
        assert!(migrations[6]
            .sql
            .as_str()
            .contains("CREATE TABLE parameterized_event_watermarks"));
        assert!(migrations[6]
            .sql
            .as_str()
            .contains("INSERT INTO parameterized_event_watermarks"));
        assert!(migrations[6]
            .sql
            .as_str()
            .contains("CREATE INDEX idx_event_mentions_community_event"));
        assert!(migrations[6]
            .sql
            .as_str()
            .contains("NIP-RS retention blocked: deleted event outranks live head"));
        assert!(migrations[6]
            .sql
            .as_str()
            .contains("DELETE FROM events old"));
        assert!(!migrations[6]
            .sql
            .as_str()
            .contains("ALTER TABLE events DROP COLUMN search_tsv"));

        // Fresh installs opt into the positive search allowlist without making
        // populated databases rewrite their events heap during relay startup.
        assert_eq!(migrations[7].version, 8);
        assert!(migrations[7]
            .sql
            .as_str()
            .contains("IF NOT EXISTS (SELECT 1 FROM events LIMIT 1)"));
        assert!(migrations[7]
            .sql
            .as_str()
            .contains("CASE WHEN kind IN (0, 9, 40002, 45001, 45003)"));
        assert!(migrations[7].sql.as_str().contains("ELSE NULL::tsvector"));

        // Mixed-version guards are additive because 0007/0008 may already be
        // recorded by a running relay and their sqlx checksums are immutable.
        assert_eq!(migrations[8].version, 9);
        assert!(migrations[8]
            .sql
            .as_str()
            .contains("CREATE TRIGGER trg_events_nip_rs_watermark"));
        assert!(migrations[8]
            .sql
            .as_str()
            .contains("stale NIP-RS event rejected by durable watermark"));
        assert!(migrations[8]
            .sql
            .as_str()
            .contains("CREATE TRIGGER trg_events_purge_soft_deleted_nip_rs"));
        assert!(migrations[8]
            .sql
            .as_str()
            .contains("CREATE TRIGGER trg_event_mentions_require_live_event"));

        assert_eq!(migrations[9].version, 10);
        assert!(migrations[9]
            .sql
            .as_str()
            .contains("CREATE OR REPLACE FUNCTION guard_nip_rs_watermark"));
        assert!(migrations[9].sql.as_str().contains("RETURN NULL"));

        assert_eq!(migrations[10].version, 11);
        assert!(migrations[10]
            .sql
            .as_str()
            .contains("CREATE OR REPLACE FUNCTION guard_nip_rs_watermark"));
        assert!(migrations[10]
            .sql
            .as_str()
            .contains("CREATE OR REPLACE FUNCTION purge_soft_deleted_nip_rs"));
        assert!(migrations[10].sql.as_str().contains("tag->>0 = 'd'"));
        assert!(migrations[10].sql.as_str().contains(") = 1"));

        // Push leases and their durable outbox are relay-owned and structurally
        // community-scoped; the public gateway remains stateless.
        assert_eq!(migrations[11].version, 12);
        assert!(migrations[11]
            .sql
            .as_str()
            .contains("CREATE TABLE push_leases"));
        assert!(migrations[11]
            .sql
            .as_str()
            .contains("CREATE TABLE push_wake_outbox"));
        assert!(migrations[11]
            .sql
            .as_str()
            .contains("PRIMARY KEY (community_id, author, installation_id)"));
        assert!(!migrations[0].sql.as_str().contains("push_leases"));

        assert_eq!(migrations[12].version, 13);
        assert!(migrations[12]
            .sql
            .as_str()
            .contains("ADD COLUMN endpoint_enabled"));

        // Kind 30350 is author-only encrypted data, so its ciphertext is never
        // indexed for NIP-50 search. Preserve the 0001 checksum and extend the
        // generated expression additively.
        assert_eq!(migrations[13].version, 14);
        assert!(migrations[13].sql.as_str().contains("30350"));
        assert!(migrations[13].sql.as_str().contains("search_tsv"));
        assert!(!migrations[0].sql.as_str().contains("30350"));

        // Public push-gateway authority is intentionally deployment-global and
        // durable: immediate revocation and hostile-relay admission cannot be
        // honestly provided by a stateless gateway.
        assert_eq!(migrations[14].version, 15);
        assert!(migrations[14]
            .sql
            .as_str()
            .contains("CREATE TABLE push_gateway_installations"));
        assert!(migrations[14]
            .sql
            .as_str()
            .contains("push_gateway_delegations"));
        assert!(migrations[14]
            .sql
            .as_str()
            .contains("_operator_global_tables"));

        // Community archival and product feedback landed concurrently. Keep
        // both additive migrations in a single, unambiguous sequence.
        assert_eq!(migrations[15].version, 16);
        assert!(migrations[15]
            .sql
            .as_str()
            .contains("ADD COLUMN archived_at"));

        // Product feedback is a deployment-private sidecar; community_id is
        // provenance, not an operator-review authorization boundary.
        assert_eq!(migrations[16].version, 17);
        assert!(migrations[16]
            .sql
            .as_str()
            .contains("CREATE TABLE product_feedback"));
        assert!(migrations[16]
            .sql
            .as_str()
            .contains("community_id UUID NOT NULL"));
        assert!(migrations[16]
            .sql
            .as_str()
            .contains("('product_feedback', 'deployment product inbox"));
        assert!(!migrations[0].sql.as_str().contains("product_feedback"));

        // Matching is driven from a parent-table trigger so all partition and
        // internal insertion paths share the same crash-safe allowlist seam.
        assert_eq!(migrations[17].version, 18);
        let matcher = migrations[17].sql.as_str();
        assert!(matcher.contains("CREATE TABLE push_match_queue"));
        assert!(matcher.contains("AFTER INSERT ON events"));
        assert!(matcher.contains("NEW.kind IN (7, 9, 1059, 40007, 46010)"));
        assert!(!migrations[0].sql.as_str().contains("push_match_queue"));

        // Mesh status is a heartbeat, not an audit stream. The additive
        // migration removes accumulated soft-deleted payloads and covers old
        // writers during rolling deploys without changing kind:30003 broadly.
        assert_eq!(migrations[18].version, 19);
        let mesh_retention = migrations[18].sql.as_str();
        assert!(mesh_retention.contains("buzz-mesh-member-status:%"));
        assert!(mesh_retention.contains("buzz-mesh-status"));
        assert!(mesh_retention
            .contains("CREATE TRIGGER trg_events_purge_soft_deleted_buzz_mesh_status"));
        assert!(!migrations[0]
            .sql
            .as_str()
            .contains("purge_soft_deleted_buzz_mesh_status"));

        // Join policy acceptances landed concurrently with mesh status retention;
        // keep both additive migrations in a single, unambiguous sequence.
        assert_eq!(migrations[19].version, 20);
        assert!(migrations[19]
            .sql
            .as_str()
            .contains("CREATE TABLE join_policy_acceptances"));

        // Replica-fence commit-time floor guard on channel-bearing events.
        assert_eq!(migrations[20].version, 21);
        assert!(migrations[20]
            .sql
            .as_str()
            .contains("events_created_at_floor_guard"));
        assert!(!migrations[0]
            .sql
            .as_str()
            .contains("join_policy_acceptances"));

        // Channel TTL refresh belongs to the event insertion transaction so a
        // concurrent permanent -> ephemeral transition cannot be missed.
        assert_eq!(migrations[21].version, 22);
        let ttl_refresh = migrations[21].sql.as_str();
        assert!(ttl_refresh.contains("CREATE CONSTRAINT TRIGGER events_refresh_channel_ttl"));
        assert!(ttl_refresh.contains("AFTER INSERT ON events"));
        assert!(ttl_refresh.contains("DEFERRABLE INITIALLY DEFERRED"));
        assert!(ttl_refresh.contains("clock_timestamp()"));
        assert!(ttl_refresh.contains("NEW.kind <> 9007"));

        // T1b push gate: the match-queue trigger only enqueues when the
        // community has an eligible lease, ordered against lease activations
        // through the shared/exclusive per-community advisory lock.
        assert_eq!(migrations[22].version, 23);
        let push_gate = migrations[22].sql.as_str();
        assert!(push_gate.contains("CREATE OR REPLACE FUNCTION enqueue_push_match_job"));
        assert!(push_gate.contains("pg_advisory_xact_lock_shared"));
        assert!(push_gate.contains("'buzz_push_gate:' || NEW.community_id::text"));
        assert!(push_gate.contains("endpoint_enabled"));

        // T1a repair: the TTL refresh trigger synchronizes on a shared
        // per-channel advisory lock instead of FOR UPDATE on the channel row,
        // so permanent-channel commits no longer serialize.
        assert_eq!(migrations[23].version, 24);
        let ttl_shared = migrations[23].sql.as_str();
        assert!(ttl_shared
            .contains("CREATE OR REPLACE FUNCTION refresh_channel_ttl_after_event_insert"));
        assert!(ttl_shared.contains("pg_advisory_xact_lock_shared"));
        assert!(ttl_shared.contains("'buzz_channel_ttl:' || NEW.community_id::text"));
        // The row read must be a bare SELECT (comments describe the removed
        // FOR UPDATE; the executable body must not reintroduce it).
        assert!(ttl_shared.contains("SELECT ttl_seconds INTO channel_ttl"));
        assert!(!strip_sql_comments(ttl_shared)
            .to_lowercase()
            .contains("for update"));
        assert!(ttl_shared.contains("NEW.kind <> 9007"));

        // Company employees: the one table holding private key material, so
        // the column is a sealed blob and never a bare secret key. Both
        // uniques lead with community_id (tenant isolation), and the partial
        // active-role index is what makes a workspace employ one Chief of
        // Staff rather than one per member who asked.
        assert_eq!(migrations[42].version, 43);
        let employees = migrations[42].sql.as_str();
        assert!(employees.contains("CREATE TABLE IF NOT EXISTS employees"));
        assert!(employees.contains("sealed_key    BYTEA NOT NULL"));
        assert!(employees.contains("PRIMARY KEY (community_id, pubkey)"));
        assert!(employees.contains("ON employees (community_id, hire_event)"));
        assert!(employees.contains("ON employees (community_id, role_id) WHERE status = 'active'"));
        assert!(employees.contains(
            "rank          TEXT NOT NULL CHECK (rank IN ('worker','leader','executive'))"
        ));
        // Community-scoped, so it must never be registered as operator-global.
        assert!(!employees.contains("_operator_global_tables"));

        // Use-limited invite links: durable relay_invites table stores only
        // the SHA-256 of an opaque v2 code, scoped by community_id. Never
        // listed in _operator_global_tables — it is community-scoped.
        assert_eq!(migrations[24].version, 25);
        let relay_invites = migrations[24].sql.as_str();
        assert!(relay_invites.contains("CREATE TABLE relay_invites"));
        assert!(relay_invites
            .contains("token_hash   BYTEA       NOT NULL CHECK (length(token_hash) = 32)"));
        assert!(relay_invites.contains("PRIMARY KEY (community_id, id)"));
        assert!(relay_invites.contains("UNIQUE (community_id, token_hash)"));
        assert!(
            relay_invites.contains("max_uses     INTEGER     CHECK (max_uses BETWEEN 1 AND 10000)")
        );
        assert!(relay_invites.contains("CHECK (max_uses IS NULL OR use_count <= max_uses)"));
        assert!(relay_invites.contains("role = 'member'"));
        assert!(relay_invites
            .contains("CREATE INDEX relay_invites_expires_at_idx ON relay_invites (expires_at)"));
        assert!(!relay_invites.contains("_operator_global_tables"));

        let desired_schema = include_str!("../../../schema/schema.sql");
        assert!(
            desired_schema.contains("CREATE TABLE join_policy_acceptances"),
            "desired-state schema must include join-policy evidence used by invite claims",
        );

        // Replica heartbeat (this branch, renumbered to 0026 after
        // 0025_relay_invites landed on main): the fence's portable read-side
        // observation. A single CHECK'd row makes the token update the
        // serialization point (multi-pod commit ordering), and the epoch
        // column is what detects token resets — both are load-bearing for
        // the routing proof.
        assert_eq!(migrations[25].version, 26);
        let heartbeat = migrations[25].sql.as_str();
        assert!(heartbeat.contains("CREATE TABLE replica_heartbeat"));
        assert!(heartbeat.contains("CHECK (id = 1)"));
        assert!(heartbeat.contains("epoch"));
        assert!(heartbeat.contains("INSERT INTO replica_heartbeat (id) VALUES (1)"));
        assert!(heartbeat.contains("_operator_global_tables"));

        // Block action claims are the durable, community-scoped execution
        // boundary for separately signed retries sharing one idempotency key.
        assert_eq!(migrations[26].version, 27);
        let block_action_claims = migrations[26].sql.as_str();
        assert!(block_action_claims.contains("CREATE TABLE block_action_claims"));
        assert!(block_action_claims
            .contains("PRIMARY KEY (community_id, instance_event_id, idempotency_key)"));
        assert!(block_action_claims.contains(
            "instance_event_id BYTEA NOT NULL CHECK (octet_length(instance_event_id) = 32)"
        ));
        assert!(block_action_claims
            .contains("action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32)"));
        assert!(!block_action_claims.contains("_operator_global_tables"));

        // Reserved catalog actions bind the global action, relay-authored head,
        // and relay-authored receipt to one community-local retry key.
        assert_eq!(migrations[27].version, 28);
        let catalog_action_claims = migrations[27].sql.as_str();
        assert!(catalog_action_claims.contains("CREATE TABLE block_catalog_action_claims"));
        assert!(catalog_action_claims.contains("PRIMARY KEY (community_id, idempotency_key)"));
        for event_id in [
            "action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32)",
            "head_event_id BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32)",
            "receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32)",
        ] {
            assert!(catalog_action_claims.contains(event_id));
        }
        assert!(!catalog_action_claims.contains("_operator_global_tables"));
    }

    #[test]
    fn block_action_claim_migration_is_community_scoped() {
        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 27)
            .expect("Block action claims migration");
        let sql = migration.sql.as_ref();

        assert!(sql.contains("CREATE TABLE block_action_claims"));
        assert!(
            sql.contains("PRIMARY KEY (community_id, instance_event_id, idempotency_key)"),
            "community_id must lead the durable idempotency boundary"
        );
        assert!(sql.contains("REFERENCES communities(id) ON DELETE CASCADE"));
        assert!(!sql.contains("_operator_global_tables"));
    }

    #[test]
    fn block_catalog_action_claim_migration_is_community_scoped() {
        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 28)
            .expect("Block catalog action claims migration");
        let sql = migration.sql.as_ref();

        assert!(sql.contains("CREATE TABLE block_catalog_action_claims"));
        assert!(
            sql.contains("PRIMARY KEY (community_id, idempotency_key)"),
            "community_id must lead the catalog action idempotency boundary"
        );
        assert!(sql.contains("REFERENCES communities(id) ON DELETE CASCADE"));
        for column in ["action_event_id", "head_event_id", "receipt_event_id"] {
            assert!(
                sql.contains(&format!("octet_length({column}) = 32")),
                "{column} must be a fixed-width event ID"
            );
        }
        assert!(!sql.contains("_operator_global_tables"));
    }

    #[test]
    fn discovery_multi_source_migration_is_scoped_and_provider_aware() {
        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 39)
            .expect("Discovery multi-source migration");
        let sql = migration.sql.as_ref();

        assert!(sql.contains("CREATE TABLE discovery_run_source_plans"));
        assert!(sql.contains("CREATE TABLE discovery_run_sources"));
        assert!(sql.contains("CREATE TABLE discovery_source_usage"));
        assert!(sql.contains("CREATE TABLE discovery_source_observation_batches"));
        assert!(sql.contains("discovery_protocol_version"));
        assert!(sql.contains("lease_worker_protocol_version"));
        assert!(sql.contains("lease_worker_protocol_claim_id"));
        assert!(sql.contains("lease_worker_protocol_claim_id=claim_id"));
        assert!(sql.contains("discovery_guard_lease_worker_protocol"));
        assert!(sql.contains("RETURN NULL"));
        assert!(sql.contains("CREATE TRIGGER trg_discovery_seed_legacy_run_plan"));
        assert!(sql.contains("CREATE TRIGGER trg_discovery_sync_legacy_run_source"));
        assert!(sql.contains("PRIMARY KEY (community_id, run_id, source_key)"));
        assert!(sql.contains("UNIQUE (community_id, run_id, position)"));
        assert!(sql.contains("'waterfall', ARRAY['google_maps']::TEXT[]"));
        assert!(sql.contains("'outscraper', 'brave_search', 'exa_search'"));
        assert!(sql.contains("ON CONFLICT (community_id, run_id) DO UPDATE SET"));
        assert!(!sql.contains("DROP CONSTRAINT discovery_usage_pkey"));
        assert!(!sql.contains("DROP CONSTRAINT discovery_observation_batches_pkey"));
        assert!(!sql.contains("ALTER COLUMN dedupe_digest_version SET DEFAULT 1"));
        assert!(sql.contains("dedupe_digest_version"));
        assert!(!sql.contains("UPDATE discovery_business_observations"));
        assert!(!sql.contains("api_key"));
        assert!(!sql.contains("authorization"));
        assert!(!sql.contains("raw_response"));
    }

    #[test]
    fn migration_lint_detects_tables_missing_community_id_by_default() {
        let sql = r#"
            CREATE TABLE communities (id UUID PRIMARY KEY);
            CREATE TABLE widgets (id UUID PRIMARY KEY);
            CREATE TABLE _operator_global_tables (table_name TEXT PRIMARY KEY, reason TEXT NOT NULL);
            INSERT INTO _operator_global_tables (table_name, reason) VALUES
                ('communities', 'tenant registry'),
                ('_operator_global_tables', 'registry');
        "#;

        let definitions = create_table_definitions(sql);
        let scoped = scoped_tables(sql);
        let missing = definitions
            .into_iter()
            .filter(|(table, _)| scoped.contains(table))
            .filter(|(_, definitions)| !table_has_not_null_community_id(definitions))
            .map(|(table, _)| table)
            .collect::<Vec<_>>();

        assert_eq!(missing, vec!["widgets"]);
    }

    #[test]
    fn migration_lint_detects_scoped_key_constraints_not_led_by_community_id() {
        let sql = r#"
            CREATE TABLE widgets (
                community_id UUID NOT NULL,
                id UUID PRIMARY KEY,
                channel_id UUID REFERENCES channels(id),
                slug TEXT,
                CONSTRAINT widgets_name_unique UNIQUE (slug),
                CONSTRAINT widgets_parent_fk FOREIGN KEY (channel_id) REFERENCES channels(id)
            );
            CREATE UNIQUE INDEX idx_widgets_slug ON widgets (slug);
            ALTER TABLE widgets ADD CONSTRAINT widgets_alter_slug_unique UNIQUE (slug);
            ALTER TABLE widgets ADD CONSTRAINT widgets_alter_parent_fk FOREIGN KEY (channel_id) REFERENCES channels(id);
            CREATE TABLE _operator_global_tables (table_name TEXT PRIMARY KEY, reason TEXT NOT NULL);
            INSERT INTO _operator_global_tables (table_name, reason) VALUES
                ('_operator_global_tables', 'registry');
        "#;

        let violations = scoped_constraint_violations(sql);

        assert!(violations
            .iter()
            .any(|violation| violation.kind == ConstraintKind::PrimaryKey));
        assert_eq!(
            violations
                .iter()
                .filter(|violation| violation.kind == ConstraintKind::ForeignKey)
                .count(),
            3
        );
        assert_eq!(
            violations
                .iter()
                .filter(|violation| violation.kind == ConstraintKind::Unique)
                .count(),
            3
        );
    }

    #[test]
    fn migration_lint_accepts_scoped_key_constraints_led_by_community_id() {
        let sql = r#"
            CREATE TABLE widgets (
                community_id UUID NOT NULL,
                id UUID NOT NULL,
                channel_id UUID NOT NULL,
                slug TEXT NOT NULL,
                PRIMARY KEY (community_id, id),
                UNIQUE (community_id, slug),
                FOREIGN KEY (community_id, channel_id) REFERENCES channels(community_id, id)
            );
            CREATE UNIQUE INDEX idx_widgets_slug ON widgets (community_id, slug);
            ALTER TABLE widgets ADD CONSTRAINT widgets_alter_slug_unique UNIQUE (community_id, slug);
            ALTER TABLE widgets ADD CONSTRAINT widgets_alter_parent_fk FOREIGN KEY (community_id, channel_id) REFERENCES channels(community_id, id);
            CREATE TABLE _operator_global_tables (table_name TEXT PRIMARY KEY, reason TEXT NOT NULL);
            INSERT INTO _operator_global_tables (table_name, reason) VALUES
                ('_operator_global_tables', 'registry');
        "#;

        assert!(scoped_constraint_violations(sql).is_empty());
    }

    #[test]
    fn all_non_operator_global_tables_have_not_null_community_id() {
        let sql = migration_sql();
        let sql = sql.as_str();
        let scoped = scoped_tables(sql);
        let missing = create_table_definitions(sql)
            .into_iter()
            .filter(|(table, _)| scoped.contains(table))
            .filter(|(_, definitions)| !table_has_not_null_community_id(definitions))
            .map(|(table, _)| table)
            .collect::<Vec<_>>();

        assert!(
            missing.is_empty(),
            "every table not listed in _operator_global_tables must carry NOT NULL community_id; missing: {}",
            missing.join(", ")
        );
    }

    #[test]
    fn scoped_primary_key_unique_and_foreign_key_constraints_lead_with_community_id() {
        let sql = migration_sql();
        let sql = sql.as_str();
        let violations = scoped_constraint_violations(sql)
            .into_iter()
            .map(|constraint| {
                format!(
                    "{}. {:?} constraint must lead with community_id: {}",
                    constraint.table, constraint.kind, constraint.description
                )
            })
            .collect::<Vec<_>>();

        assert!(
            violations.is_empty(),
            "tenant-scoped tables are all tables not listed in _operator_global_tables; primary key, unique/FK constraints, and unique indexes on those tables must lead with community_id:\n{}",
            violations.join("\n")
        );
    }

    #[test]
    fn channels_community_id_is_immutable_after_insert() {
        let sql = migration_sql();
        let sql = sql.as_str();
        let forbidden_mutations = forbidden_channels_community_id_mutations(sql);

        assert!(
            forbidden_mutations.is_empty(),
            "channels.community_id must not be re-tenanted after insert; forbidden migration statements:\n{}",
            forbidden_mutations.join("\n---\n")
        );
        assert!(
            has_channels_community_id_immutability_guard(sql),
            "migrations define channels.community_id but no BEFORE UPDATE trigger/function guard that rejects OLD.community_id <> NEW.community_id was found"
        );
    }

    async fn connect_test_pool() -> PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned());

        PgPool::connect(&database_url)
            .await
            .expect("connect to test DB")
    }

    async fn reset_public_schema(pool: &PgPool) {
        sqlx::query("DROP SCHEMA IF EXISTS public CASCADE")
            .execute(pool)
            .await
            .expect("drop public schema");
        sqlx::query("CREATE SCHEMA IF NOT EXISTS public")
            .execute(pool)
            .await
            .expect("create public schema");
    }

    async fn applied_versions(pool: &PgPool) -> Vec<i64> {
        sqlx::query_scalar::<_, i64>(
            "SELECT version FROM _sqlx_migrations WHERE success ORDER BY version",
        )
        .fetch_all(pool)
        .await
        .expect("read applied migrations")
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn pre_0007_ambiguous_nip_rs_data_blocks_without_mutation_and_allows_retry() {
        let pool = connect_test_pool().await;
        reset_public_schema(&pool).await;
        MIGRATOR
            .run_to(6, &pool)
            .await
            .expect("apply migrations 1-6");

        let community_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_id)
            .bind(format!("pre-0007-{}.example", community_id.simple()))
            .execute(&pool)
            .await
            .expect("insert community");
        let event_id = vec![1_u8; 32];
        let pubkey = vec![2_u8; 32];
        let d_tag = format!("read-state:{}", "a".repeat(32));
        let ambiguous_tags = serde_json::json!([["d", d_tag], ["d", "other"], ["t", "read-state"]]);
        sqlx::query(
            "INSERT INTO events \
             (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at, d_tag) \
             VALUES ($1, $2, $3, NOW(), 30078, $4, 'ambiguous', $5, NOW(), $6)",
        )
        .bind(community_id)
        .bind(&event_id)
        .bind(&pubkey)
        .bind(&ambiguous_tags)
        .bind(vec![3_u8; 64])
        .bind(&d_tag)
        .execute(&pool)
        .await
        .expect("insert ambiguous NIP-RS row");

        let before_versions = applied_versions(&pool).await;
        let before_row: (serde_json::Value, String) =
            sqlx::query_as("SELECT tags, content FROM events WHERE community_id=$1 AND id=$2")
                .bind(community_id)
                .bind(&event_id)
                .fetch_one(&pool)
                .await
                .expect("read ambiguous row before blocked migration");
        let blocked = run_migrations(&pool).await;
        assert!(blocked.is_err(), "ambiguous pre-0007 data must fail closed");
        assert_eq!(applied_versions(&pool).await, before_versions);
        let after_row: (serde_json::Value, String) =
            sqlx::query_as("SELECT tags, content FROM events WHERE community_id=$1 AND id=$2")
                .bind(community_id)
                .bind(&event_id)
                .fetch_one(&pool)
                .await
                .expect("blocked migration must preserve source row");
        assert_eq!(after_row, before_row);

        let repaired_tags = serde_json::json!([["d", d_tag], ["t", "read-state"]]);
        sqlx::query("UPDATE events SET tags=$1 WHERE community_id=$2 AND id=$3")
            .bind(repaired_tags)
            .bind(community_id)
            .bind(&event_id)
            .execute(&pool)
            .await
            .expect("repair ambiguous row");
        run_migrations(&pool)
            .await
            .expect("retry succeeds after operator repair");
        assert_eq!(applied_versions(&pool).await.last().copied(), Some(26));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn populated_upgrade_preserves_search_policy_except_for_push_leases() {
        let pool = connect_test_pool().await;
        reset_public_schema(&pool).await;
        MIGRATOR
            .run_to(7, &pool)
            .await
            .expect("apply migrations 1-7");

        let community_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_id)
            .bind(format!("pre-0008-{}.example", community_id.simple()))
            .execute(&pool)
            .await
            .expect("insert community");

        for (marker, kind) in [(1_u8, 1_i32), (2_u8, 30_350_i32)] {
            sqlx::query(
                "INSERT INTO events \
                 (community_id, id, pubkey, created_at, kind, tags, content, sig, received_at) \
                 VALUES ($1, $2, $3, NOW(), $4, '[]'::jsonb, 'brownfield needle', $5, NOW())",
            )
            .bind(community_id)
            .bind(vec![marker; 32])
            .bind(vec![marker + 10; 32])
            .bind(kind)
            .bind(vec![marker + 20; 64])
            .execute(&pool)
            .await
            .expect("insert brownfield event");
        }

        MIGRATOR
            .run_to(11, &pool)
            .await
            .expect("apply main migrations through 11");
        let before: Vec<(i32, bool)> = sqlx::query_as(
            "SELECT kind, search_tsv @@ plainto_tsquery('simple', 'needle') \
             FROM events ORDER BY kind",
        )
        .fetch_all(&pool)
        .await
        .expect("read pre-push search behavior");
        assert_eq!(before, vec![(1, true), (30_350, true)]);

        run_migrations(&pool)
            .await
            .expect("apply push migrations to populated database");
        let after: Vec<(i32, Option<bool>)> = sqlx::query_as(
            "SELECT kind, search_tsv @@ plainto_tsquery('simple', 'needle') \
             FROM events ORDER BY kind",
        )
        .fetch_all(&pool)
        .await
        .expect("read post-push search behavior");
        assert_eq!(after, vec![(1, Some(true)), (30_350, None)]);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn discovery_multi_source_upgrade_preserves_legacy_outscraper_records() {
        let pool = connect_test_pool().await;
        reset_public_schema(&pool).await;
        MIGRATOR
            .run_to(38, &pool)
            .await
            .expect("apply migrations through the legacy Discovery schema");

        let community_id = uuid::Uuid::new_v4();
        let campaign_id = uuid::Uuid::new_v4();
        let run_id = uuid::Uuid::new_v4();
        let actor = vec![7_u8; 32];
        sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
            .bind(community_id)
            .bind(format!("pre-0039-{}.example", community_id.simple()))
            .execute(&pool)
            .await
            .expect("insert legacy community");
        sqlx::query(
            "INSERT INTO discovery_campaigns \
             (community_id,id,created_by,name,industry_id,industry_name,vertical_id,vertical_name,\
              query,location,target,language,region) \
             VALUES ($1,$2,$3,'Legacy dentists','healthcare','Healthcare','dentists','Dentists',\
                     'dentists','Sandton, South Africa',100,'en','ZA')",
        )
        .bind(community_id)
        .bind(campaign_id)
        .bind(&actor)
        .execute(&pool)
        .await
        .expect("insert legacy Campaign");
        sqlx::query(
            "INSERT INTO discovery_runs \
             (community_id,id,campaign_id,requested_by,start_idempotency_key,state,\
              completed_steps,total_steps,created_at,updated_at) \
             VALUES ($1,$2,$3,$4,$5,'succeeded',1,1,now() - interval '1 minute',now())",
        )
        .bind(community_id)
        .bind(run_id)
        .bind(campaign_id)
        .bind(&actor)
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("insert legacy run");
        sqlx::query(
            "INSERT INTO discovery_run_business_searches \
             (community_id,run_id,query,location,result_limit,language,region) \
             VALUES ($1,$2,'dentists','Sandton, South Africa',100,'en','ZA')",
        )
        .bind(community_id)
        .bind(run_id)
        .execute(&pool)
        .await
        .expect("insert legacy search");
        sqlx::query(
            "INSERT INTO discovery_run_checkpoints \
             (community_id,run_id,sequence,checkpoint_kind,provider,provider_request_id,\
              request_fingerprint,action_event_id) \
             VALUES ($1,$2,1,'provider_submitted','outscraper','legacy-job-1',$3,$4)",
        )
        .bind(community_id)
        .bind(run_id)
        .bind(vec![8_u8; 32])
        .bind(vec![9_u8; 32])
        .execute(&pool)
        .await
        .expect("insert legacy checkpoint");
        sqlx::query(
            "INSERT INTO discovery_business_observations \
             (community_id,id,first_run_id,provider,provider_record_id,name,website,phone,city,\
              country,country_code,observation_fingerprint) \
             VALUES ($1,$2,$3,'outscraper','place:legacy-1','Legacy Dental',\
                     'https://user:pass@www.bücher.example:8443/practice','27+11 555 0100','München',\
                     'South Africa','ZA',$4)",
        )
        .bind(community_id)
        .bind(uuid::Uuid::new_v4())
        .bind(run_id)
        .bind(vec![10_u8; 32])
        .execute(&pool)
        .await
        .expect("insert legacy Lead observation");
        sqlx::query(
            "INSERT INTO discovery_usage \
             (community_id,run_id,provider,provider_request_id,stored_count,existing_count,\
              returned_count) VALUES ($1,$2,'outscraper','legacy-job-1',1,0,1)",
        )
        .bind(community_id)
        .bind(run_id)
        .execute(&pool)
        .await
        .expect("insert legacy usage");
        sqlx::query(
            "INSERT INTO discovery_observation_batches \
             (community_id,run_id,provider_request_id,batch_index,batch_fingerprint,\
              accepted_count,existing_count) VALUES ($1,$2,'legacy-job-1',0,$3,1,0)",
        )
        .bind(community_id)
        .bind(run_id)
        .bind(vec![11_u8; 32])
        .execute(&pool)
        .await
        .expect("insert legacy observation batch");

        let mut preexisting_active_duplicates = Vec::new();
        for _ in 0..2 {
            let duplicate_run_id = uuid::Uuid::new_v4();
            sqlx::query(
                "INSERT INTO discovery_runs \
                 (community_id,id,campaign_id,requested_by,start_idempotency_key,total_steps) \
                 VALUES ($1,$2,$3,$4,$5,1)",
            )
            .bind(community_id)
            .bind(duplicate_run_id)
            .bind(campaign_id)
            .bind(&actor)
            .bind(uuid::Uuid::new_v4())
            .execute(&pool)
            .await
            .expect("insert preexisting duplicate active run");
            preexisting_active_duplicates.push(duplicate_run_id);
        }
        let preexisting_lease_run_id = preexisting_active_duplicates[0];
        let preexisting_lease_claim_id = uuid::Uuid::new_v4();
        sqlx::query(
            "UPDATE discovery_runs SET state='running',claim_id=$3, \
             lease_until=now() - interval '1 second',worker_id=$4,lease_owner_pubkey=$5 \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(preexisting_lease_run_id)
        .bind(preexisting_lease_claim_id)
        .bind(uuid::Uuid::new_v4())
        .bind(&actor)
        .execute(&pool)
        .await
        .expect("seed in-flight released V1 lease");

        run_migrations(&pool)
            .await
            .expect("upgrade populated Discovery database");

        let upgraded_lease_marker: (Option<i16>, Option<uuid::Uuid>) = sqlx::query_as(
            "SELECT lease_worker_protocol_version,lease_worker_protocol_claim_id \
             FROM discovery_runs WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(preexisting_lease_run_id)
        .fetch_one(&pool)
        .await
        .expect("read upgraded released V1 lease fence");
        assert_eq!(
            upgraded_lease_marker,
            (Some(1), Some(preexisting_lease_claim_id))
        );

        let duplicate_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovery_runs \
             WHERE community_id=$1 AND campaign_id=$2 AND state IN ('queued','running')",
        )
        .bind(community_id)
        .bind(campaign_id)
        .fetch_one(&pool)
        .await
        .expect("count preserved preexisting active duplicates");
        assert_eq!(duplicate_count, 2);
        let first_claim_id = uuid::Uuid::new_v4();
        let first_claimed: Option<uuid::Uuid> = sqlx::query_scalar(
            "WITH candidate AS ( \
                 SELECT community_id,id FROM discovery_runs \
                 WHERE state IN ('queued','running') \
                   AND (claim_id IS NULL OR lease_until < now()) \
                 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1 \
             ) \
             UPDATE discovery_runs r SET state='running',claim_id=$1,lease_until=$2, \
                 worker_id=NULL,lease_owner_pubkey=NULL,attempt=r.attempt+1,updated_at=now() \
             FROM candidate c WHERE r.community_id=c.community_id AND r.id=c.id \
             RETURNING r.id",
        )
        .bind(first_claim_id)
        .bind(chrono::Utc::now() + chrono::Duration::seconds(30))
        .fetch_optional(&pool)
        .await
        .expect("released worker claims first legacy duplicate");
        let first_claimed = first_claimed.expect("first legacy duplicate must drain");
        assert!(preexisting_active_duplicates.contains(&first_claimed));

        let blocked_while_live: Option<uuid::Uuid> = sqlx::query_scalar(
            "WITH candidate AS ( \
                 SELECT community_id,id FROM discovery_runs \
                 WHERE state IN ('queued','running') \
                   AND (claim_id IS NULL OR lease_until < now()) \
                 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1 \
             ) \
             UPDATE discovery_runs r SET state='running',claim_id=$1,lease_until=$2, \
                 worker_id=NULL,lease_owner_pubkey=NULL,attempt=r.attempt+1,updated_at=now() \
             FROM candidate c WHERE r.community_id=c.community_id AND r.id=c.id \
             RETURNING r.id",
        )
        .bind(uuid::Uuid::new_v4())
        .bind(chrono::Utc::now() + chrono::Duration::seconds(30))
        .fetch_optional(&pool)
        .await
        .expect("second legacy claim is safely deferred");
        assert_eq!(blocked_while_live, None);

        sqlx::query(
            "UPDATE discovery_runs SET state='succeeded',completed_steps=total_steps, \
             claim_id=NULL,lease_until=NULL,worker_id=NULL,lease_owner_pubkey=NULL,updated_at=now() \
             WHERE community_id=$1 AND id=$2 AND claim_id=$3",
        )
        .bind(community_id)
        .bind(first_claimed)
        .bind(first_claim_id)
        .execute(&pool)
        .await
        .expect("finish first legacy duplicate");

        let second_claim_id = uuid::Uuid::new_v4();
        let second_claimed: Option<uuid::Uuid> = sqlx::query_scalar(
            "WITH candidate AS ( \
                 SELECT community_id,id FROM discovery_runs \
                 WHERE state IN ('queued','running') \
                   AND (claim_id IS NULL OR lease_until < now()) \
                 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1 \
             ) \
             UPDATE discovery_runs r SET state='running',claim_id=$1,lease_until=$2, \
                 worker_id=NULL,lease_owner_pubkey=NULL,attempt=r.attempt+1,updated_at=now() \
             FROM candidate c WHERE r.community_id=c.community_id AND r.id=c.id \
             RETURNING r.id",
        )
        .bind(second_claim_id)
        .bind(chrono::Utc::now() + chrono::Duration::seconds(30))
        .fetch_optional(&pool)
        .await
        .expect("released worker claims second legacy duplicate after first drains");
        let second_claimed = second_claimed.expect("second legacy duplicate must drain");
        assert_ne!(second_claimed, first_claimed);
        assert!(preexisting_active_duplicates.contains(&second_claimed));
        sqlx::query(
            "UPDATE discovery_runs SET state='cancelled',cancel_requested=TRUE,claim_id=NULL, \
             lease_until=NULL,worker_id=NULL,lease_owner_pubkey=NULL,updated_at=now() \
             WHERE community_id=$1 AND id=$2 AND claim_id=$3",
        )
        .bind(community_id)
        .bind(second_claimed)
        .bind(second_claim_id)
        .execute(&pool)
        .await
        .expect("finish second legacy duplicate");

        let campaign: (String, Vec<String>) = sqlx::query_as(
            "SELECT source_mode,source_keys FROM discovery_campaigns \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(campaign_id)
        .fetch_one(&pool)
        .await
        .expect("read upgraded Campaign");
        assert_eq!(
            campaign,
            ("waterfall".to_owned(), vec!["google_maps".to_owned()])
        );
        let plan: (String, Vec<String>) = sqlx::query_as(
            "SELECT source_mode,source_keys FROM discovery_run_source_plans \
             WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read upgraded immutable run plan");
        assert_eq!(plan, campaign);
        let source: (String, String, String, i32, i32, i32, i32) = sqlx::query_as(
            "SELECT source_key,provider,status,request_count,returned_count,retained_count,\
                    duplicate_count FROM discovery_run_sources \
             WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read upgraded source progress");
        assert_eq!(
            source,
            (
                "google_maps".to_owned(),
                "outscraper".to_owned(),
                "completed".to_owned(),
                1,
                1,
                1,
                0,
            )
        );
        #[derive(sqlx::FromRow)]
        struct UpgradedObservation {
            provider: String,
            canonical_domain_digest: Option<Vec<u8>>,
            normalized_phone_digest: Option<Vec<u8>>,
            normalized_name_locality_digest: Option<Vec<u8>>,
            dedupe_digest_version: i16,
        }
        let observation: UpgradedObservation = sqlx::query_as(
            "SELECT provider,canonical_domain_digest,normalized_phone_digest,\
                        normalized_name_locality_digest,dedupe_digest_version \
                 FROM discovery_business_observations \
                 WHERE community_id=$1 AND first_run_id=$2",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read upgraded Lead observation");
        assert_eq!(observation.provider, "outscraper");
        assert_eq!(
            observation.canonical_domain_digest,
            canonical_business_domain_digest("https://user:pass@www.bücher.example:8443/practice")
                .map(Vec::from)
        );
        assert_eq!(
            observation.normalized_phone_digest,
            normalized_business_phone_digest("27+11 555 0100").map(Vec::from)
        );
        assert_eq!(
            observation.normalized_name_locality_digest,
            normalized_business_name_locality_digest(
                "Legacy Dental",
                Some("München"),
                None,
                Some("South Africa")
            )
            .map(Vec::from)
        );
        assert_eq!(observation.dedupe_digest_version, 1);
        let usage_provider: String = sqlx::query_scalar(
            "SELECT provider FROM discovery_usage WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read preserved usage");
        assert_eq!(usage_provider, "outscraper");
        let source_usage_provider: String = sqlx::query_scalar(
            "SELECT provider FROM discovery_source_usage WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read provider-aware usage copy");
        assert_eq!(source_usage_provider, "outscraper");
        let batch_provider: String = sqlx::query_scalar(
            "SELECT provider FROM discovery_observation_batches \
             WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read preserved batch");
        assert_eq!(batch_provider, "outscraper");

        // The previous relay binary must remain able to use its released SQL
        // conflict targets after the expand migration, and its writes must be
        // visible to the provider-aware runtime for safe rolling deploys.
        sqlx::query(
            "INSERT INTO discovery_usage \
             (community_id,run_id,provider,provider_request_id,returned_count) \
             VALUES ($1,$2,'outscraper','legacy-job-1',2) \
             ON CONFLICT (community_id, run_id) DO UPDATE SET \
               returned_count=EXCLUDED.returned_count,updated_at=now() \
             WHERE discovery_usage.provider=EXCLUDED.provider \
               AND discovery_usage.provider_request_id=EXCLUDED.provider_request_id",
        )
        .bind(community_id)
        .bind(run_id)
        .execute(&pool)
        .await
        .expect("released usage SQL remains valid after migration");
        let mirrored_returned_count: i32 = sqlx::query_scalar(
            "SELECT returned_count FROM discovery_source_usage \
             WHERE community_id=$1 AND run_id=$2 AND provider='outscraper'",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read mirrored legacy usage");
        assert_eq!(mirrored_returned_count, 2);

        sqlx::query(
            "INSERT INTO discovery_observation_batches \
             (community_id,run_id,provider_request_id,batch_index,batch_fingerprint,\
              accepted_count,existing_count) VALUES ($1,$2,'legacy-job-1',1,$3,1,0)",
        )
        .bind(community_id)
        .bind(run_id)
        .bind(vec![12_u8; 32])
        .execute(&pool)
        .await
        .expect("released observation-batch SQL remains valid after migration");
        let legacy_batch_provider: String = sqlx::query_scalar(
            "SELECT provider FROM discovery_observation_batches \
             WHERE community_id=$1 AND run_id=$2 AND batch_index=1",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read legacy batch provider default");
        assert_eq!(legacy_batch_provider, "outscraper");
        let mirrored_batch_provider: String = sqlx::query_scalar(
            "SELECT provider FROM discovery_source_observation_batches \
             WHERE community_id=$1 AND run_id=$2 AND batch_index=1",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("read provider-aware legacy batch copy");
        assert_eq!(mirrored_batch_provider, "outscraper");

        for provider in ["brave_search", "exa_search"] {
            sqlx::query(
                "INSERT INTO discovery_source_observation_batches \
                 (community_id,run_id,provider,provider_request_id,batch_index,\
                  batch_fingerprint,accepted_count,existing_count) \
                 VALUES ($1,$2,$3,'shared-provider-request',0,$4,1,0)",
            )
            .bind(community_id)
            .bind(run_id)
            .bind(provider)
            .bind(vec![provider.as_bytes()[0]; 32])
            .execute(&pool)
            .await
            .expect("provider-scoped batches may share opaque request IDs");
        }
        let provider_batch_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovery_source_observation_batches \
             WHERE community_id=$1 AND run_id=$2 \
               AND provider_request_id='shared-provider-request'",
        )
        .bind(community_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .expect("count provider-scoped collision fixture");
        assert_eq!(provider_batch_count, 2);

        // Execute the released run/checkpoint/usage lifecycle after migration.
        // The database must seed and advance its V1 source projection because
        // the old binary has no source-plan SQL at all.
        let rolling_run_id = uuid::Uuid::new_v4();
        let rolling_request_id = format!("rolling-job-{}", rolling_run_id.simple());
        sqlx::query(
            "INSERT INTO discovery_runs \
             (community_id,id,campaign_id,requested_by,start_idempotency_key,total_steps) \
             VALUES ($1,$2,$3,$4,$5,1)",
        )
        .bind(community_id)
        .bind(rolling_run_id)
        .bind(campaign_id)
        .bind(&actor)
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("released run insert remains compatible");
        sqlx::query(
            "INSERT INTO discovery_run_business_searches \
             (community_id,run_id,query,location,result_limit,language,region) \
             VALUES ($1,$2,'dentists','Sandton, South Africa',100,'en','ZA')",
        )
        .bind(community_id)
        .bind(rolling_run_id)
        .execute(&pool)
        .await
        .expect("released search insert remains compatible");
        sqlx::query(
            "UPDATE discovery_runs SET state='running',claim_id=$3,\
             lease_until=now()+interval '1 minute',updated_at=now() \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(rolling_run_id)
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("released claim update remains compatible");
        sqlx::query(
            "INSERT INTO discovery_run_checkpoints \
             (community_id,run_id,sequence,checkpoint_kind,provider,provider_request_id,\
              request_fingerprint,action_event_id) \
             VALUES ($1,$2,1,'provider_submitted','outscraper',$3,$4,$5)",
        )
        .bind(community_id)
        .bind(rolling_run_id)
        .bind(&rolling_request_id)
        .bind(vec![13_u8; 32])
        .bind(vec![14_u8; 32])
        .execute(&pool)
        .await
        .expect("released checkpoint insert remains compatible");
        sqlx::query(
            "INSERT INTO discovery_usage \
             (community_id,run_id,provider,provider_request_id,stored_count,existing_count,\
              returned_count) VALUES ($1,$2,'outscraper',$3,2,1,3)",
        )
        .bind(community_id)
        .bind(rolling_run_id)
        .bind(&rolling_request_id)
        .execute(&pool)
        .await
        .expect("released usage insert remains compatible");
        sqlx::query(
            "UPDATE discovery_runs SET state='succeeded',completed_steps=1,\
             claim_id=NULL,lease_until=NULL,updated_at=now() \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(rolling_run_id)
        .execute(&pool)
        .await
        .expect("released completion update remains compatible");
        let rolling_source: (String, i32, i32, i32, i32) = sqlx::query_as(
            "SELECT status,request_count,returned_count,retained_count,duplicate_count \
             FROM discovery_run_sources WHERE community_id=$1 AND run_id=$2",
        )
        .bind(community_id)
        .bind(rolling_run_id)
        .fetch_one(&pool)
        .await
        .expect("read trigger-maintained V1 source");
        assert_eq!(rolling_source, ("completed".to_owned(), 1, 3, 2, 1));

        // Multi-source adoption drains an already-paid V1 run instead of
        // rejecting its late Outscraper results or risking cross-provider
        // duplicates. The durable marker closes the workspace to new V1 work
        // only after every queued/running V1 run is terminal.
        let draining_run_id = uuid::Uuid::new_v4();
        sqlx::query(
            "INSERT INTO discovery_runs \
             (community_id,id,campaign_id,requested_by,start_idempotency_key,total_steps) \
             VALUES ($1,$2,$3,$4,$5,1)",
        )
        .bind(community_id)
        .bind(draining_run_id)
        .bind(campaign_id)
        .bind(&actor)
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("insert V1 run to drain");
        sqlx::query(
            "UPDATE discovery_runs SET state='running',claim_id=$3,\
             lease_until=now()+interval '1 minute',updated_at=now() \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(draining_run_id)
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("start V1 run to drain");
        let adoption_while_v1_active =
            sqlx::query("INSERT INTO discovery_workspace_protocols (community_id) VALUES ($1)")
                .bind(community_id)
                .execute(&pool)
                .await;
        assert!(adoption_while_v1_active.is_err());
        sqlx::query(
            "INSERT INTO discovery_business_observations \
             (community_id,id,first_run_id,provider,provider_record_id,name,\
              observation_fingerprint) \
             VALUES ($1,$2,$3,'outscraper','paid-v1-in-flight','Paid V1 result',$4)",
        )
        .bind(community_id)
        .bind(uuid::Uuid::new_v4())
        .bind(draining_run_id)
        .bind(vec![17_u8; 32])
        .execute(&pool)
        .await
        .expect("paid V1 result remains storable while adoption waits");
        sqlx::query(
            "UPDATE discovery_runs SET state='succeeded',completed_steps=1,\
             claim_id=NULL,lease_until=NULL,updated_at=now() \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(draining_run_id)
        .execute(&pool)
        .await
        .expect("finish drained V1 run");
        sqlx::query("INSERT INTO discovery_workspace_protocols (community_id) VALUES ($1)")
            .bind(community_id)
            .execute(&pool)
            .await
            .expect("adopt multi-source after V1 drain");

        let v2_run_id = uuid::Uuid::new_v4();
        sqlx::query(
            "INSERT INTO discovery_runs \
             (community_id,id,campaign_id,requested_by,start_idempotency_key,total_steps,\
              discovery_protocol_version) VALUES ($1,$2,$3,$4,$5,1,2)",
        )
        .bind(community_id)
        .bind(v2_run_id)
        .bind(campaign_id)
        .bind(&actor)
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("insert V2 adoption marker run");
        sqlx::query(
            "INSERT INTO discovery_business_observations \
             (community_id,id,first_run_id,provider,provider_record_id,name,\
              dedupe_digest_version,observation_fingerprint) \
             VALUES ($1,$2,$3,'brave_search','brave:adoption','Retained Brave result',1,$4)",
        )
        .bind(community_id)
        .bind(uuid::Uuid::new_v4())
        .bind(v2_run_id)
        .bind(vec![15_u8; 32])
        .execute(&pool)
        .await
        .expect("insert retained multi-source adoption marker");
        let rejected_v1_run = sqlx::query(
            "INSERT INTO discovery_runs \
             (community_id,id,campaign_id,requested_by,start_idempotency_key,total_steps) \
             VALUES ($1,$2,$3,$4,$5,1)",
        )
        .bind(community_id)
        .bind(uuid::Uuid::new_v4())
        .bind(campaign_id)
        .bind(&actor)
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await;
        assert!(rejected_v1_run.is_err());

        let rejected_v1_observation = sqlx::query(
            "INSERT INTO discovery_business_observations \
             (community_id,id,first_run_id,provider,provider_record_id,name,\
              observation_fingerprint) \
             VALUES ($1,$2,$3,'outscraper','late-legacy-place','Late legacy result',$4)",
        )
        .bind(community_id)
        .bind(uuid::Uuid::new_v4())
        .bind(rolling_run_id)
        .bind(vec![16_u8; 32])
        .execute(&pool)
        .await;
        assert!(rejected_v1_observation.is_err());
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn discovery_trial_upgrade_seeds_existing_and_future_communities() {
        let pool = connect_test_pool().await;
        reset_public_schema(&pool).await;
        MIGRATOR
            .run_to(40, &pool)
            .await
            .expect("apply migrations through pre-trial Discovery");

        let active_community = uuid::Uuid::new_v4();
        let inactive_community = uuid::Uuid::new_v4();
        for (community_id, label) in [
            (active_community, "active"),
            (inactive_community, "inactive"),
        ] {
            sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
                .bind(community_id)
                .bind(format!(
                    "pre-trial-{label}-{}.example",
                    community_id.simple()
                ))
                .execute(&pool)
                .await
                .expect("insert pre-trial community");
        }
        sqlx::query(
            "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
             VALUES ($1,TRUE,now()),($2,FALSE,now())",
        )
        .bind(active_community)
        .bind(inactive_community)
        .execute(&pool)
        .await
        .expect("insert legacy entitlements");

        run_migrations(&pool).await.expect("apply trial migration");

        let active_expiry: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
            "SELECT expires_at FROM discovery_entitlements WHERE community_id=$1 AND active",
        )
        .bind(active_community)
        .fetch_one(&pool)
        .await
        .expect("preserve permanent active entitlement");
        assert_eq!(active_expiry, None);

        let inactive_expiry: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
            "SELECT expires_at FROM discovery_entitlements WHERE community_id=$1 AND active",
        )
        .bind(inactive_community)
        .fetch_one(&pool)
        .await
        .expect("upgrade inactive community to trial");
        let inactive_remaining = inactive_expiry - chrono::Utc::now();
        assert!(inactive_remaining > chrono::Duration::days(29));
        assert!(inactive_remaining <= chrono::Duration::days(30));

        let future_community = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
            .bind(future_community)
            .bind(format!(
                "trial-future-{}.example",
                future_community.simple()
            ))
            .execute(&pool)
            .await
            .expect("insert community after trial migration");
        let future_expiry: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
            "SELECT expires_at FROM discovery_entitlements WHERE community_id=$1 AND active",
        )
        .bind(future_community)
        .fetch_one(&pool)
        .await
        .expect("trigger must provision future community trial");
        let future_remaining = future_expiry - chrono::Utc::now();
        assert!(future_remaining > chrono::Duration::days(29));
        assert!(future_remaining <= chrono::Duration::days(30));
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn run_migrations_applies_consolidated_initial_schema_on_fresh_database() {
        let pool = connect_test_pool().await;
        reset_public_schema(&pool).await;

        run_migrations(&pool).await.expect("run migrations");

        // Every embedded migration must apply, in order. Derive the expected
        // list from the MIGRATOR itself so this doesn't go stale as additive
        // migrations land (it previously hardcoded [1, 2, 3] and rotted).
        let expected: Vec<i64> = {
            let mut versions: Vec<i64> = MIGRATOR.iter().map(|m| m.version).collect();
            versions.sort_unstable();
            versions
        };
        assert_eq!(applied_versions(&pool).await, expected);
        let sql = migration_sql();
        let tables = create_tables(sql.as_str());
        for table in [
            "communities",
            "events",
            "channels",
            "scheduled_workflow_fires",
            "audit_log",
        ] {
            let exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)",
            )
            .bind(table)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|err| panic!("check table {table}: {err}"));
            assert!(
                tables.contains(table),
                "migration parser should see {table}"
            );
            assert!(exists, "migration should create {table}");
        }

        let search_expression: String = sqlx::query_scalar(
            "SELECT pg_get_expr(adbin, adrelid) \
             FROM pg_attrdef \
             WHERE adrelid = 'events'::regclass \
               AND adnum = (SELECT attnum FROM pg_attribute \
                            WHERE attrelid = 'events'::regclass \
                              AND attname = 'search_tsv')",
        )
        .fetch_one(&pool)
        .await
        .expect("read fresh-install search expression");
        assert!(
            search_expression.contains("ARRAY[0, 9, 40002, 45001, 45003]"),
            "fresh-install search allowlist has the wrong kinds: {search_expression}"
        );
        assert!(
            search_expression.contains("ELSE NULL::tsvector"),
            "fresh installs must default non-allowlisted kinds to NULL: {search_expression}"
        );
    }
}
