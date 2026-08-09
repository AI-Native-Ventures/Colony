import {
  encodeSignedEvent,
  OperatorAuthFailure,
  selectOperatorSigner,
  type OperatorSigner,
  createNip98Event,
} from "./operatorAuth";
import type { AnalyticsEnvelope, AnalyticsQuery } from "./types";

const API_PREFIX = "/operator/analytics";

export class AnalyticsApiFailure extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly liveUnavailable = false,
  ) {
    super(message);
    this.name = "AnalyticsApiFailure";
  }
}

export interface AnalyticsRequestOptions {
  method?: string;
  body?: BodyInit | null;
  signal?: AbortSignal;
}

function operatorOrigin(): string {
  return location.origin;
}

function requestUrl(path: string): URL {
  if (!path.startsWith("/"))
    throw new Error("analytics paths must be absolute");
  return new URL(path, operatorOrigin());
}

function errorMessage(status: number): string {
  if (status === 401 || status === 403)
    return "This operator signer is not authorized.";
  if (status === 503) return "The analytics source is temporarily unavailable.";
  return "Analytics could not be loaded. Try again.";
}

export async function analyticsRequest<T>(
  path: string,
  signer: OperatorSigner,
  options: AnalyticsRequestOptions = {},
): Promise<AnalyticsEnvelope<T>> {
  const method = (options.method ?? "GET").toUpperCase();
  const url = requestUrl(path);
  await signer.getPublicKey();
  const unsigned = createNip98Event(url.href, method);
  const signed = await signer.signEvent(unsigned);
  const response = await fetch(url.href, {
    method,
    body: options.body,
    signal: options.signal,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      Authorization: `Nostr ${encodeSignedEvent(signed)}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    const partial = await response.json().catch(() => null);
    if (
      response.status === 503 &&
      partial?.data &&
      partial?.freshness?.live?.status === "unavailable"
    ) {
      return partial as AnalyticsEnvelope<T>;
    }
    throw new AnalyticsApiFailure(
      response.status,
      errorMessage(response.status),
      response.status === 503,
    );
  }
  const parsed = (await response.json()) as AnalyticsEnvelope<T>;
  if (!parsed || typeof parsed !== "object" || !parsed.data) {
    throw new AnalyticsApiFailure(
      502,
      "Analytics returned an invalid response.",
    );
  }
  return parsed;
}

function queryString(query: AnalyticsQuery): string {
  const params = new URLSearchParams();
  const entries: Array<[string, string | undefined]> = [
    ["community", query.community],
    ["start", query.start],
    ["end", query.end],
    ["search", query.search],
    ["online", query.online === undefined ? undefined : String(query.online)],
    ["family", query.family],
    ["type", query.type],
    ["status", query.status],
    [
      "include_archived",
      query.include_archived === undefined
        ? undefined
        : String(query.include_archived),
    ],
    ["cursor", query.cursor],
    ["limit", query.limit === undefined ? undefined : String(query.limit)],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function analyticsPath(
  resource:
    | "overview"
    | "communities"
    | "people"
    | "activity"
    | "sessions"
    | "definitions",
  query: AnalyticsQuery = {},
): string {
  return `${API_PREFIX}/${resource}${queryString(query)}`;
}

export function personPath(pubkey: string, query: AnalyticsQuery = {}): string {
  return `${API_PREFIX}/people/${encodeURIComponent(pubkey)}${queryString(query)}`;
}

export function getAnalyticsSigner(): OperatorSigner {
  try {
    return selectOperatorSigner();
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new OperatorAuthFailure(401);
  }
}
