export const ANALYTICS_DEFINITIONS_VERSION = "v1" as const;

export type ActivityFamily =
  | "message"
  | "thread"
  | "reaction"
  | "channel"
  | "command"
  | "workflow"
  | "git"
  | "huddle";

export type PersonType = "human" | "agent" | "unknown";
export type FreshnessStatus = "fresh" | "stale" | "unavailable";

export interface FreshnessSource {
  status: FreshnessStatus;
  watermark?: string | null;
  observed_at?: string | null;
  lag_seconds?: number | null;
  message?: string | null;
}

export interface AnalyticsFreshness {
  historical: FreshnessSource;
  live: FreshnessSource;
}

export interface AnalyticsEnvelope<T> {
  data: T;
  as_of: string;
  freshness: AnalyticsFreshness;
  definitions_version: string;
  warnings?: string[];
}

export interface AnalyticsMetricSet {
  unique_people: number;
  memberships: number;
  first_seen_people?: number;
  new_memberships?: number;
  online_people: number;
  authenticated_sessions: number;
  open_connections: number;
  dau: number;
  wau: number;
  mau: number;
  activity_volume?: number;
  active_channels?: number;
  threads?: number;
}

export interface ActivityPoint {
  utc_day: string;
  activity_volume: number;
  unique_people: number;
  families?: Record<string, number>;
}

export interface CommunitySummary {
  id?: string;
  community_id?: string;
  name?: string | null;
  host: string;
  status?: string;
  created_at?: string | null;
  archived_at?: string | null;
  unique_people?: number;
  people?: number;
  memberships: number;
  channels?: number;
  threads?: number;
  online_people: number;
  authenticated_sessions: number;
  open_connections: number;
  dau: number;
  wau: number;
  mau: number;
  activity_volume?: number;
  last_activity_at?: string | null;
  last_activity?: string | null;
}

export interface OverviewData {
  scope?: string | null;
  range?: string | null;
  metrics?: Partial<AnalyticsMetricSet>;
  population?: {
    unique_people: number;
    memberships: number;
    first_seen: number;
    new_memberships: number;
  };
  live?: {
    online_people: number;
    authenticated_sessions: number;
    open_connections: number;
  };
  engagement?: {
    dau: number;
    wau: number;
    mau: number;
  };
  trend?: ActivityPoint[];
  communities?: CommunitySummary[];
}

export interface CommunitiesData {
  items?: CommunitySummary[];
  rows?: CommunitySummary[];
  next_cursor?: string | null;
}

export interface PersonSummary {
  pubkey: string;
  display_name?: string | null;
  profile_label?: string | null;
  pubkey_short?: string | null;
  nip05?: string | null;
  avatar_url?: string | null;
  person_type: PersonType;
  community_count: number;
  membership_count: number;
  channel_count?: number | null;
  owned_agent_count?: number | null;
  first_seen?: string | null;
  last_activity_at?: string | null;
  last_meaningful_activity?: string | null;
  online: boolean;
  session_count: number;
  deactivated?: boolean;
}

export interface PersonMembership {
  community_id: string;
  community_host: string;
  host?: string;
  created_at?: string | null;
  community_name?: string | null;
  role?: string | null;
  status?: string | null;
  channel_count?: number | null;
  thread_count?: number | null;
  joined_at?: string | null;
}

export interface PersonActivitySummary {
  dau?: number;
  wau?: number;
  mau?: number;
  event_count: number;
  unique_days?: number;
  last_activity_at?: string | null;
  families?: Array<{
    family: ActivityFamily;
    event_count: number;
    unique_days?: number;
  }>;
  trend?: ActivityPoint[];
}

export interface PersonActivityTotal {
  activity_family: ActivityFamily;
  event_count: number;
  first_activity_at: string;
  last_activity_at: string;
}

export interface SessionSummary {
  session_id?: string;
  connection_id?: string | null;
  pubkey: string;
  community_id: string;
  community_host?: string;
  host?: string;
  started_at: string;
  last_seen_at: string;
  pod?: string | null;
  pod_id?: string | null;
  network?: string | null;
  network_cidr?: string | null;
  client_label?: string | null;
}

export interface PersonDetail extends PersonSummary {
  person?: PersonSummary;
  profile?: {
    display_name?: string | null;
    nip05?: string | null;
    avatar_url?: string | null;
    bio?: string | null;
  };
  memberships?: PersonMembership[];
  activity?: PersonActivitySummary | PersonActivityTotal[];
  sessions?: SessionSummary[];
  channels?: Array<{
    community_id: string;
    channel_id: string;
    name: string;
    joined_at?: string | null;
  }>;
  thread_participation?: Array<{
    community_id: string;
    thread_count: number;
    reply_count: number;
    descendant_count: number;
  }>;
  trend?: ActivityPoint[];
}

export interface PeopleData {
  items?: PersonSummary[];
  rows?: PersonSummary[];
  next_cursor?: string | null;
  total?: number;
}

export interface ActivityFamilySummary {
  family?: ActivityFamily;
  activity_family?: ActivityFamily;
  event_count: number;
  unique_people: number;
}

export interface ActivityData {
  points: ActivityPoint[];
  families: ActivityFamilySummary[];
  people?: Array<{
    person_type: PersonType;
    event_count: number;
    unique_people: number;
  }>;
}

export interface SessionData {
  items?: SessionSummary[];
  rows?: SessionSummary[];
  online_people: number;
  authenticated_sessions: number;
  open_connections: number;
  next_cursor?: string | null;
}

export interface DefinitionMetric {
  key: string;
  label: string;
  definition: string;
  source: string;
  exclusions?: string[];
}

export interface DefinitionsData {
  version: string;
  families: Array<{
    family: ActivityFamily;
    label?: string;
    kinds: number[];
  }>;
  metrics: DefinitionMetric[];
  exclusions: string[];
  sources: string[];
}

export interface AnalyticsQuery {
  community?: string;
  start?: string;
  end?: string;
  range?: string;
  search?: string;
  online?: boolean;
  family?: ActivityFamily;
  type?: PersonType;
  status?: "active" | "all";
  include_archived?: boolean;
  cursor?: string;
  limit?: number;
}
