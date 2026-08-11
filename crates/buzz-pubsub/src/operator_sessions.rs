//! Deployment-wide Redis leases for authenticated operator analytics sessions.
//!
//! A lease is written only after a WebSocket has completed the relay's normal
//! NIP-42 authentication and admission gates.  The sorted-set index is useful
//! for discovery, but the per-session hash (and its TTL) is the crash-safe
//! authority: a process that dies without running cleanup naturally disappears
//! from the live view after [`PRESENCE_TTL_SECS`].

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};

use buzz_core::CommunityId;
use chrono::{DateTime, SecondsFormat, Utc};
use deadpool_redis::Pool;
use nostr::PublicKey;
use redis::Script;
use uuid::Uuid;

use crate::error::PubSubError;
pub use crate::presence::PRESENCE_TTL_SECS;
use crate::topic::BUZZ_PREFIX;

/// Alias that makes the session-specific contract discoverable without
/// changing the existing presence module's constant name.
pub const OPERATOR_SESSION_TTL_SECS: u64 = PRESENCE_TTL_SECS;

/// The one deployment-wide sorted-set index for authenticated sessions.
pub const OPERATOR_SESSIONS_INDEX_KEY: &str = "buzz:operator:sessions:index";

const MAX_LIST_LIMIT: usize = 200;

const REGISTER_SCRIPT: &str = r#"
redis.call('HSET', KEYS[1],
  'pubkey', ARGV[1],
  'started_at', ARGV[2],
  'last_seen_at', ARGV[3],
  'pod_id', ARGV[4])
if ARGV[5] ~= '' then
  redis.call('HSET', KEYS[1], 'network_cidr', ARGV[5])
else
  redis.call('HDEL', KEYS[1], 'network_cidr')
end
if ARGV[6] ~= '' then
  redis.call('HSET', KEYS[1], 'client_label', ARGV[6])
else
  redis.call('HDEL', KEYS[1], 'client_label')
end
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('ZADD', KEYS[2], ARGV[8], ARGV[9])
return 1
"#;

const REFRESH_SCRIPT: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], 'last_seen_at', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1
"#;

const CLEAR_SCRIPT: &str = r#"
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
"#;

/// A deployment-wide authenticated WebSocket lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorSessionLease {
    /// Server-resolved community containing the connection.
    pub community_id: CommunityId,
    /// WebSocket connection identity; one authenticated connection is one lease.
    pub connection_id: Uuid,
    /// Authenticated Nostr public key bytes.
    pub pubkey: [u8; 32],
    /// Time the connection completed authentication.
    pub started_at: DateTime<Utc>,
    /// Last successful registration/heartbeat refresh.
    pub last_seen_at: DateTime<Utc>,
    /// Deployment/pod label, never an authority key.
    pub pod_id: String,
    /// Coarse network block, if a socket address was available.
    pub network_cidr: Option<String>,
    /// Existing handshake client label, when one is available.
    pub client_label: Option<String>,
}

/// Optional tenant filter for deployment-wide session reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OperatorSessionScope {
    /// Restrict rows to this server-resolved community, or include all tenants.
    pub community_id: Option<CommunityId>,
}

impl OperatorSessionScope {
    /// Return an unfiltered deployment scope.
    #[must_use]
    pub const fn all() -> Self {
        Self { community_id: None }
    }

    /// Return a scope restricted to one community.
    #[must_use]
    pub const fn community(community_id: CommunityId) -> Self {
        Self {
            community_id: Some(community_id),
        }
    }
}

/// Aggregate live-session counts for one scope.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OperatorSessionCounts {
    /// Number of active lease rows (one per authenticated connection).
    pub raw_connections: u64,
    /// Number of authenticated sessions represented by the lease rows.
    pub authenticated_sessions: u64,
    /// Number of distinct authenticated pubkeys in the scope.
    pub distinct_pubkeys: u64,
}

/// A stable, cursor-paginated session page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorSessionPage {
    /// Hydrated, metadata-only lease rows.
    pub rows: Vec<OperatorSessionLease>,
    /// Opaque cursor for the next page, if more rows remain.
    pub next_cursor: Option<String>,
}

/// One consistent live-session observation used by analytics overlays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorSessionSnapshot {
    /// All fresh leases in the requested scope.
    pub rows: Vec<OperatorSessionLease>,
    /// Counts derived from exactly the same hydrated rows.
    pub counts: OperatorSessionCounts,
}

/// Redis-backed deployment-wide authenticated-session store.
#[derive(Clone)]
pub struct OperatorSessionStore {
    pool: Pool,
}

impl std::fmt::Debug for OperatorSessionStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorSessionStore")
            .finish_non_exhaustive()
    }
}

impl OperatorSessionStore {
    /// Create a store using the relay's shared Redis pool.
    #[must_use]
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    /// Return the deployment-wide sorted-set index key.
    #[must_use]
    pub const fn index_key() -> &'static str {
        OPERATOR_SESSIONS_INDEX_KEY
    }

    /// Validate an opaque session-list cursor without accessing Redis.
    pub fn validate_cursor(cursor: &str) -> Result<(), PubSubError> {
        decode_cursor(cursor).map(|_| ())
    }

    /// Return the sorted-set member for one community/connection pair.
    #[must_use]
    pub fn member_key(community_id: CommunityId, connection_id: Uuid) -> String {
        format!("{community_id}:{connection_id}")
    }

    /// Return the hash key for one community/connection pair.
    #[must_use]
    pub fn session_key(community_id: CommunityId, connection_id: Uuid) -> String {
        format!("{BUZZ_PREFIX}:operator:sessions:{community_id}:{connection_id}")
    }

    /// Atomically register a lease, refresh its TTL, and index its last-seen
    /// timestamp. Re-registering the same identity replaces the metadata.
    pub async fn register(&self, lease: &OperatorSessionLease) -> Result<(), PubSubError> {
        let mut conn = self.pool.get().await?;
        let hash_key = Self::session_key(lease.community_id, lease.connection_id);
        let member = Self::member_key(lease.community_id, lease.connection_id);
        let network_cidr = lease.network_cidr.as_deref().unwrap_or_default();
        let client_label = lease.client_label.as_deref().unwrap_or_default();
        let _: i64 = Script::new(REGISTER_SCRIPT)
            .key(hash_key)
            .key(Self::index_key())
            .arg(public_key_hex(&lease.pubkey))
            .arg(format_timestamp(lease.started_at))
            .arg(format_timestamp(lease.last_seen_at))
            .arg(&lease.pod_id)
            .arg(network_cidr)
            .arg(client_label)
            .arg(PRESENCE_TTL_SECS as i64)
            .arg(lease.last_seen_at.timestamp_millis())
            .arg(member)
            .invoke_async(&mut *conn)
            .await?;
        Ok(())
    }

    /// Refresh an existing lease after a successful server heartbeat.
    ///
    /// Returns `false` if the hash has already expired or was cleared. The
    /// method intentionally never recreates a missing lease: a connection that
    /// lost its lease must complete a fresh authenticated lifecycle.
    pub async fn refresh(
        &self,
        community_id: CommunityId,
        connection_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<bool, PubSubError> {
        let mut conn = self.pool.get().await?;
        let member = Self::member_key(community_id, connection_id);
        let refreshed: i64 = Script::new(REFRESH_SCRIPT)
            .key(Self::session_key(community_id, connection_id))
            .key(Self::index_key())
            .arg(format_timestamp(now))
            .arg(PRESENCE_TTL_SECS as i64)
            .arg(now.timestamp_millis())
            .arg(member)
            .invoke_async(&mut *conn)
            .await?;
        Ok(refreshed == 1)
    }

    /// Atomically delete a lease hash and remove its index member.
    pub async fn clear(
        &self,
        community_id: CommunityId,
        connection_id: Uuid,
    ) -> Result<(), PubSubError> {
        let mut conn = self.pool.get().await?;
        let member = Self::member_key(community_id, connection_id);
        let _: i64 = Script::new(CLEAR_SCRIPT)
            .key(Self::session_key(community_id, connection_id))
            .key(Self::index_key())
            .arg(member)
            .invoke_async(&mut *conn)
            .await?;
        Ok(())
    }

    /// List active leases with stable `(last_seen_at DESC, member ASC)` cursor
    /// semantics. The index is pruned before reading and missing hashes are
    /// removed from it. No Redis key scan is used.
    pub async fn list(
        &self,
        scope: OperatorSessionScope,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<OperatorSessionPage, PubSubError> {
        if !(1..=MAX_LIST_LIMIT).contains(&limit) {
            return Err(invalid_session_redis_error(
                "operator session list limit must be between 1 and 200",
            ));
        }
        let decoded_cursor = cursor.map(decode_cursor).transpose()?;
        let now = Utc::now();
        self.read_page(scope, decoded_cursor.as_ref(), limit, now)
            .await
    }

    /// Count active raw connections, authenticated sessions, and distinct
    /// pubkeys for the optional community scope.
    pub async fn counts(
        &self,
        scope: OperatorSessionScope,
    ) -> Result<OperatorSessionCounts, PubSubError> {
        let rows = self.read_rows(scope, None, Utc::now()).await?;
        let distinct: HashSet<[u8; 32]> = rows.iter().map(|row| row.pubkey).collect();
        let connections = rows.len() as u64;
        Ok(OperatorSessionCounts {
            raw_connections: connections,
            authenticated_sessions: connections,
            distinct_pubkeys: distinct.len() as u64,
        })
    }

    /// Read all fresh leases and their aggregate counts as one observation.
    ///
    /// This is intentionally bounded by the number of active Redis leases,
    /// not by key scanning: [`Self::read_rows`] hydrates only members from the
    /// deployment session index and prunes expired or malformed entries.
    pub async fn snapshot(
        &self,
        scope: OperatorSessionScope,
    ) -> Result<OperatorSessionSnapshot, PubSubError> {
        let rows = self.read_rows(scope, None, Utc::now()).await?;
        let distinct: HashSet<[u8; 32]> = rows.iter().map(|row| row.pubkey).collect();
        let connections = rows.len() as u64;
        Ok(OperatorSessionSnapshot {
            rows,
            counts: OperatorSessionCounts {
                raw_connections: connections,
                authenticated_sessions: connections,
                distinct_pubkeys: distinct.len() as u64,
            },
        })
    }

    async fn read_page(
        &self,
        scope: OperatorSessionScope,
        cursor: Option<&SessionCursor>,
        limit: usize,
        now: DateTime<Utc>,
    ) -> Result<OperatorSessionPage, PubSubError> {
        let mut rows = self.read_rows(scope, cursor, now).await?;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = if has_more {
            rows.last().map(|row| {
                encode_cursor(
                    row.last_seen_at.timestamp_millis(),
                    &Self::member_key(row.community_id, row.connection_id),
                )
            })
        } else {
            None
        };
        Ok(OperatorSessionPage { rows, next_cursor })
    }

    async fn read_rows(
        &self,
        scope: OperatorSessionScope,
        cursor: Option<&SessionCursor>,
        now: DateTime<Utc>,
    ) -> Result<Vec<OperatorSessionLease>, PubSubError> {
        let mut conn = self.pool.get().await?;
        let cutoff = now
            .timestamp_millis()
            .saturating_sub((PRESENCE_TTL_SECS as i64).saturating_mul(1_000));
        let _: i64 = redis::cmd("ZREMRANGEBYSCORE")
            .arg(Self::index_key())
            .arg("-inf")
            .arg(cutoff)
            .query_async(&mut *conn)
            .await?;

        let indexed: Vec<(String, f64)> = redis::cmd("ZRANGE")
            .arg(Self::index_key())
            .arg(0)
            .arg(-1)
            .arg("WITHSCORES")
            .query_async(&mut *conn)
            .await?;
        let mut rows = Vec::with_capacity(indexed.len());
        let mut missing_members = Vec::new();
        for (member, score) in indexed {
            let Some((community_id, connection_id)) = parse_member(&member) else {
                missing_members.push(member);
                continue;
            };
            let hash: HashMap<String, String> = redis::cmd("HGETALL")
                .arg(Self::session_key(community_id, connection_id))
                .query_async(&mut *conn)
                .await?;
            if hash.is_empty() {
                missing_members.push(member);
                continue;
            }
            let Some(row) = hydrate_row(community_id, connection_id, &hash) else {
                // A malformed hash cannot be a trusted metadata row. Remove
                // its index entry so every subsequent read converges.
                missing_members.push(member);
                continue;
            };
            // Redis scores are written as integer epoch milliseconds. Retain
            // the hash timestamp as the cursor authority, but use the score
            // as a freshness sanity check so a malformed future timestamp
            // cannot move a row ahead of the index ordering.
            if !score.is_finite() {
                missing_members.push(member);
                continue;
            }
            let score_ms = score.round() as i64;
            if row.last_seen_at.timestamp_millis() != score_ms {
                missing_members.push(member);
                continue;
            }
            if scope.community_id.is_some_and(|id| id != community_id) {
                continue;
            }
            if cursor.is_some_and(|cursor| !is_after_cursor(&row, &member, cursor)) {
                continue;
            }
            rows.push(row);
        }
        if !missing_members.is_empty() {
            let mut zrem = redis::cmd("ZREM");
            zrem.arg(Self::index_key());
            for member in missing_members {
                zrem.arg(member);
            }
            let _: i64 = zrem.query_async(&mut *conn).await?;
        }
        rows.sort_by(compare_rows);
        Ok(rows)
    }
}

fn compare_rows(left: &OperatorSessionLease, right: &OperatorSessionLease) -> Ordering {
    right.last_seen_at.cmp(&left.last_seen_at).then_with(|| {
        OperatorSessionStore::member_key(left.community_id, left.connection_id).cmp(
            &OperatorSessionStore::member_key(right.community_id, right.connection_id),
        )
    })
}

fn is_after_cursor(row: &OperatorSessionLease, member: &str, cursor: &SessionCursor) -> bool {
    let score = row.last_seen_at.timestamp_millis();
    score < cursor.score || (score == cursor.score && member > cursor.member.as_str())
}

fn hydrate_row(
    community_id: CommunityId,
    connection_id: Uuid,
    hash: &HashMap<String, String>,
) -> Option<OperatorSessionLease> {
    let pubkey = decode_public_key(hash.get("pubkey")?)?;
    let started_at = parse_timestamp(hash.get("started_at")?)?;
    let last_seen_at = parse_timestamp(hash.get("last_seen_at")?)?;
    let pod_id = hash.get("pod_id")?.clone();
    Some(OperatorSessionLease {
        community_id,
        connection_id,
        pubkey,
        started_at,
        last_seen_at,
        pod_id,
        network_cidr: hash.get("network_cidr").cloned(),
        client_label: hash.get("client_label").cloned(),
    })
}

fn parse_member(member: &str) -> Option<(CommunityId, Uuid)> {
    let (community, connection) = member.split_once(':')?;
    if connection.contains(':') {
        return None;
    }
    Some((
        CommunityId::from_uuid(Uuid::parse_str(community).ok()?),
        Uuid::parse_str(connection).ok()?,
    ))
}

fn format_timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn public_key_hex(pubkey: &[u8; 32]) -> String {
    encode_hex(pubkey)
}

fn decode_public_key(value: &str) -> Option<[u8; 32]> {
    let bytes = decode_hex(value)?;
    bytes.try_into().ok()
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16)? as u8;
            let low = (pair[1] as char).to_digit(16)? as u8;
            Some((high << 4) | low)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionCursor {
    score: i64,
    member: String,
}

fn encode_cursor(score: i64, member: &str) -> String {
    encode_hex(format!("{score}\n{member}").as_bytes())
}

fn decode_cursor(value: &str) -> Result<SessionCursor, PubSubError> {
    let bytes = decode_hex(value).ok_or_else(|| {
        invalid_session_redis_error("operator session cursor is not valid hexadecimal")
    })?;
    let payload = String::from_utf8(bytes)
        .map_err(|_| invalid_session_redis_error("operator session cursor is not valid UTF-8"))?;
    let (score, member) = payload.split_once('\n').ok_or_else(|| {
        invalid_session_redis_error("operator session cursor has an invalid shape")
    })?;
    let score = score.parse::<i64>().map_err(|_| {
        invalid_session_redis_error("operator session cursor has an invalid timestamp")
    })?;
    if parse_member(member).is_none() {
        return Err(invalid_session_redis_error(
            "operator session cursor has an invalid member",
        ));
    }
    Ok(SessionCursor {
        score,
        member: member.to_string(),
    })
}

fn invalid_session_redis_error(message: &'static str) -> PubSubError {
    PubSubError::Redis(redis::RedisError::from((redis::ErrorKind::Client, message)))
}

/// Derive the privacy-preserving network block written to a lease.
#[must_use]
pub fn network_cidr(addr: Option<SocketAddr>) -> Option<String> {
    match addr.map(|addr| addr.ip()) {
        Some(IpAddr::V4(ip)) => {
            let octets = ip.octets();
            Some(format!("{}.{}.{}.0/24", octets[0], octets[1], octets[2]))
        }
        Some(IpAddr::V6(ip)) => {
            let mut segments = ip.segments();
            segments[4..].fill(0);
            Some(format!("{}/64", std::net::Ipv6Addr::from(segments)))
        }
        None => None,
    }
}

/// Parse and mask a possibly absent socket address. Invalid values are treated
/// like an absent address, which keeps address parsing outside the authority
/// path and writes no raw network identifier.
#[must_use]
pub fn network_cidr_from_str(value: Option<&str>) -> Option<String> {
    value
        .and_then(|value| value.parse::<SocketAddr>().ok())
        .and_then(|addr| network_cidr(Some(addr)))
}

/// Build a lease from an authenticated Nostr pubkey and connection metadata.
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn make_lease(
    community_id: CommunityId,
    connection_id: Uuid,
    pubkey: &PublicKey,
    started_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    pod_id: impl Into<String>,
    remote_addr: Option<SocketAddr>,
    client_label: Option<String>,
) -> OperatorSessionLease {
    OperatorSessionLease {
        community_id,
        connection_id,
        pubkey: pubkey.to_bytes(),
        started_at,
        last_seen_at,
        pod_id: pod_id.into(),
        network_cidr: network_cidr(remote_addr),
        client_label,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::make_test_pool;
    use buzz_core::TenantContext;
    use nostr::Keys;

    fn community(value: u128) -> CommunityId {
        CommunityId::from_uuid(Uuid::from_u128(value))
    }

    fn lease(value: u128, pubkey: [u8; 32], at: DateTime<Utc>) -> OperatorSessionLease {
        OperatorSessionLease {
            community_id: community(value),
            connection_id: Uuid::from_u128(value + 100),
            pubkey,
            started_at: at,
            last_seen_at: at,
            pod_id: "pod-a".to_string(),
            network_cidr: None,
            client_label: None,
        }
    }

    #[test]
    fn key_format_is_deployment_scoped_and_tenant_explicit() {
        let community_id = community(1);
        let connection_id = Uuid::from_u128(2);
        assert_eq!(
            OperatorSessionStore::index_key(),
            "buzz:operator:sessions:index"
        );
        assert_eq!(
            OperatorSessionStore::member_key(community_id, connection_id),
            format!("{community_id}:{connection_id}")
        );
        assert_eq!(
            OperatorSessionStore::session_key(community_id, connection_id),
            format!("buzz:operator:sessions:{community_id}:{connection_id}")
        );
    }

    #[test]
    fn ipv4_is_masked_to_a_24_and_ipv6_to_a_64() {
        let ipv4: SocketAddr = "192.0.2.123:4567".parse().unwrap();
        assert_eq!(network_cidr(Some(ipv4)).as_deref(), Some("192.0.2.0/24"));

        let ipv6: SocketAddr = "[2001:db8:1234:5678:abcd:ef01:2345:6789]:4567"
            .parse()
            .unwrap();
        assert_eq!(
            network_cidr(Some(ipv6)).as_deref(),
            Some("2001:db8:1234:5678::/64")
        );
        assert_eq!(network_cidr(None), None);
        assert_eq!(network_cidr_from_str(Some("not-an-address")), None);
    }

    #[test]
    fn cursor_roundtrip_is_opaque_and_rejects_malformed_values() {
        let member = OperatorSessionStore::member_key(community(1), Uuid::from_u128(2));
        let encoded = encode_cursor(1234, &member);
        let decoded = decode_cursor(&encoded).unwrap();
        assert_eq!(
            decoded,
            SessionCursor {
                score: 1234,
                member
            }
        );
        assert!(decode_cursor("not-a-cursor").is_err());
    }

    #[test]
    fn cursor_order_is_descending_timestamp_then_ascending_member() {
        let timestamp = Utc::now();
        let mut rows = [
            lease(2, [2; 32], timestamp),
            lease(1, [1; 32], timestamp),
            lease(3, [3; 32], timestamp - chrono::Duration::seconds(1)),
        ];
        rows.sort_by(compare_rows);
        assert_eq!(rows[0].community_id, community(1));
        assert_eq!(rows[1].community_id, community(2));
        assert_eq!(rows[2].community_id, community(3));
    }

    #[test]
    fn same_pubkey_across_communities_is_one_person_but_two_sessions() {
        let pubkey = [7; 32];
        let at = Utc::now();
        let rows = [lease(1, pubkey, at), lease(2, pubkey, at)];
        let people: HashSet<[u8; 32]> = rows.iter().map(|row| row.pubkey).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(people.len(), 1);
    }

    #[test]
    fn duplicate_connections_in_one_community_are_two_sessions_but_one_person() {
        let pubkey = [8; 32];
        let at = Utc::now();
        let mut first = lease(4, pubkey, at);
        first.connection_id = Uuid::from_u128(401);
        let mut second = first.clone();
        second.connection_id = Uuid::from_u128(402);
        let rows = [first, second];
        let people: HashSet<[u8; 32]> = rows.iter().map(|row| row.pubkey).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(people.len(), 1);
        assert_ne!(
            OperatorSessionStore::member_key(rows[0].community_id, rows[0].connection_id),
            OperatorSessionStore::member_key(rows[1].community_id, rows[1].connection_id)
        );
    }

    #[test]
    fn make_lease_uses_authenticated_pubkey_and_coarse_address() {
        let keys = Keys::generate();
        let tenant = TenantContext::resolved(community(1), "a.example");
        let remote = "203.0.113.42:3000".parse().unwrap();
        let lease = make_lease(
            tenant.community(),
            Uuid::from_u128(2),
            &keys.public_key(),
            Utc::now(),
            Utc::now(),
            "pod-a",
            Some(remote),
            None,
        );
        assert_eq!(lease.pubkey, keys.public_key().to_bytes());
        assert_eq!(lease.network_cidr.as_deref(), Some("203.0.113.0/24"));
    }

    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn register_refresh_list_counts_and_clear_are_shared() {
        let pool = make_test_pool();
        let store_a = OperatorSessionStore::new(pool.clone());
        let store_b = OperatorSessionStore::new(pool);
        let now = Utc::now();
        let mut first = lease(10, [1; 32], now);
        first.connection_id = Uuid::new_v4();
        store_a.register(&first).await.unwrap();

        let page = store_b
            .list(OperatorSessionScope::all(), None, 200)
            .await
            .unwrap();
        assert!(page
            .rows
            .iter()
            .any(|row| row.connection_id == first.connection_id));
        assert_eq!(
            store_b
                .counts(OperatorSessionScope::community(first.community_id))
                .await
                .unwrap()
                .distinct_pubkeys,
            1
        );

        assert!(store_b
            .refresh(
                first.community_id,
                first.connection_id,
                now + chrono::Duration::seconds(1)
            )
            .await
            .unwrap());
        store_a
            .clear(first.community_id, first.connection_id)
            .await
            .unwrap();
        assert!(store_b
            .list(OperatorSessionScope::all(), None, 200)
            .await
            .unwrap()
            .rows
            .iter()
            .all(|row| row.connection_id != first.connection_id));
    }

    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn missing_hashes_are_pruned_from_the_index() {
        let pool = make_test_pool();
        let store = OperatorSessionStore::new(pool.clone());
        let community_id = community(11);
        let connection_id = Uuid::new_v4();
        let member = OperatorSessionStore::member_key(community_id, connection_id);
        let mut conn = pool.get().await.unwrap();
        let _: i64 = redis::cmd("ZADD")
            .arg(OperatorSessionStore::index_key())
            .arg(Utc::now().timestamp_millis())
            .arg(&member)
            .query_async(&mut *conn)
            .await
            .unwrap();
        let _ = store
            .list(OperatorSessionScope::all(), None, 200)
            .await
            .unwrap();
        let members: Vec<String> = redis::cmd("ZRANGE")
            .arg(OperatorSessionStore::index_key())
            .arg(0)
            .arg(-1)
            .query_async(&mut *conn)
            .await
            .unwrap();
        assert!(!members.contains(&member));
    }

    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn expired_hash_is_not_reported_as_an_active_session() {
        let pool = make_test_pool();
        let store = OperatorSessionStore::new(pool.clone());
        let now = Utc::now();
        let mut row = lease(12, [2; 32], now);
        row.connection_id = Uuid::new_v4();
        store.register(&row).await.unwrap();

        let mut conn = pool.get().await.unwrap();
        let _: i64 = redis::cmd("EXPIRE")
            .arg(OperatorSessionStore::session_key(
                row.community_id,
                row.connection_id,
            ))
            .arg(1)
            .query_async(&mut *conn)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;

        let page = store
            .list(OperatorSessionScope::all(), None, 200)
            .await
            .unwrap();
        assert!(page
            .rows
            .iter()
            .all(|item| item.connection_id != row.connection_id));
    }

    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn redis_failure_is_returned_to_callers() {
        let config = deadpool_redis::Config::from_url("redis://127.0.0.1:1");
        let pool = config
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .unwrap();
        let store = OperatorSessionStore::new(pool);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            store.counts(OperatorSessionScope::all()),
        )
        .await;
        assert!(result.is_ok(), "Redis failure should be surfaced promptly");
        assert!(result.unwrap().is_err());
    }
}
