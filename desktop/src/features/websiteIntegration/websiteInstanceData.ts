/**
 * Coordinator review-card instance data (`website-job` Block composite).
 *
 * The card is the coordinator's kind-9 message; its inline `block-data`
 * carries the job coordinates and the approved brief facets. The UI trusts it
 * only after the event id equals the head's `instance` tag, the signer equals
 * the head's coordinator `p` tag, the Block instance pins the head's manifest,
 * and the declared task/thread/source match the head record.
 *
 * Improvements narrative and handover prose are deliberately not here:
 * improvements come from real thread messages and the access request comes
 * from the canonical `handover.accessRequest`.
 */

import { useQuery } from "@tanstack/react-query";
import { verifyEvent } from "nostr-tools/pure";

import { parseBlockInstance } from "@/features/blocks/blockTags";
import { getEventById } from "@/shared/api/tauri";

import type { WebsiteBriefView } from "@/features/website/types";

import type { WebsiteHead } from "./websiteHeads";

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_SUMMARY_CHARS = 600;
const MAX_ITEM_CHARS = 160;
const MAX_PRESERVE = 8;
const MAX_REDESIGN = 8;
const MAX_DELIVERABLES = 6;
const MAX_TASK_ID_CHARS = 256;
const WEBSITE_JOB_BLOCK_HANDLE = "website-job";

export type WebsiteInstanceBrief = {
  summary?: string;
  preserve: string[];
  redesign: string[];
  deliverables: string[];
};

export type WebsiteInstanceData = {
  taskId: string;
  threadRoot: string;
  sourceUrl: string;
  brief: WebsiteInstanceBrief;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || Array.from(text).length > maxChars) return null;
  return text;
}

function stringList(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > maxItems) return null;
  const list: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry, MAX_ITEM_CHARS);
    if (!text) return null;
    list.push(text);
  }
  return list;
}

function parseBrief(value: unknown): WebsiteInstanceBrief | null {
  if (!isRecord(value)) return null;
  const summary =
    value.summary === undefined
      ? undefined
      : boundedText(value.summary, MAX_SUMMARY_CHARS);
  if (value.summary !== undefined && summary === null) return null;
  const preserve = stringList(value.preserve ?? [], MAX_PRESERVE);
  const redesign = stringList(value.redesign ?? [], MAX_REDESIGN);
  const deliverables = stringList(value.deliverables ?? [], MAX_DELIVERABLES);
  if (!preserve || !redesign || !deliverables) return null;
  return {
    ...(summary ? { summary } : {}),
    preserve,
    redesign,
    deliverables,
  };
}

export function parseWebsiteInstanceData(
  value: unknown,
): WebsiteInstanceData | null {
  if (!isRecord(value)) return null;
  const taskId = value.taskId;
  const threadRoot = value.threadRoot;
  const sourceUrl = value.sourceUrl;
  const brief = parseBrief(value.brief);
  if (
    typeof taskId !== "string" ||
    taskId.length === 0 ||
    Array.from(taskId).length > MAX_TASK_ID_CHARS
  ) {
    return null;
  }
  if (typeof threadRoot !== "string" || !HEX_64.test(threadRoot)) return null;
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;
  try {
    if (new URL(sourceUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (!brief) return null;
  return { taskId, threadRoot, sourceUrl, brief };
}

export function websiteInstanceDataMatchesHead(
  data: WebsiteInstanceData,
  head: WebsiteHead,
): boolean {
  return (
    data.taskId === head.taskId &&
    data.threadRoot === head.threadRoot &&
    data.sourceUrl === head.record.sourceUrl
  );
}

export function briefViewFromInstanceData(
  data: WebsiteInstanceData,
): WebsiteBriefView | undefined {
  const { brief } = data;
  if (
    !brief.summary &&
    brief.preserve.length === 0 &&
    brief.redesign.length === 0 &&
    brief.deliverables.length === 0
  ) {
    return undefined;
  }
  return {
    title: "",
    ...(brief.summary ? { summary: brief.summary } : {}),
    preserve: brief.preserve,
    redesign: brief.redesign,
    delivered: brief.deliverables,
  };
}

export type WebsiteInstanceDataState =
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; data: WebsiteInstanceData };

/**
 * Fetch and verify the pinned review card's inline instance data. The query is
 * keyed by community + channel + instance event, so a reload recovers the same
 * brief while a stale response for another job can never apply.
 */
export function useWebsiteInstanceData(input: {
  communityId: string | null;
  channelId: string | null;
  head: WebsiteHead | null;
}): WebsiteInstanceDataState {
  const { communityId, channelId, head } = input;
  const enabled = Boolean(communityId && channelId && head);
  const query = useQuery({
    queryKey: [
      "website-instance-data",
      communityId,
      channelId,
      head?.instanceEventId ?? null,
    ],
    queryFn: async () => {
      const instanceEventId = head?.instanceEventId ?? "";
      if (!instanceEventId) return null;
      try {
        return await getEventById(instanceEventId);
      } catch {
        return null;
      }
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (!enabled || !head || !communityId || !channelId) {
    return { status: "unavailable", reason: "No website job is loaded." };
  }
  if (query.isPending) return { status: "loading" };
  const event = query.data;
  if (!event) {
    return {
      status: "unavailable",
      reason: "The review card could not be loaded.",
    };
  }
  if (event.id.toLowerCase() !== head.instanceEventId) {
    return {
      status: "unavailable",
      reason: "The review card response did not match the pinned instance.",
    };
  }
  if (event.pubkey.toLowerCase() !== head.coordinatorPubkey) {
    return {
      status: "unavailable",
      reason: "The review card was not signed by the pinned coordinator.",
    };
  }
  try {
    if (
      !verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
        sig: event.sig,
      })
    ) {
      return {
        status: "unavailable",
        reason: "The review card signature is invalid.",
      };
    }
  } catch {
    return {
      status: "unavailable",
      reason: "The review card signature is invalid.",
    };
  }
  const parsed = parseBlockInstance(event.tags);
  if (!parsed.ok) {
    return {
      status: "unavailable",
      reason: "The review card does not declare a valid Block instance.",
    };
  }
  if (parsed.value.handle !== WEBSITE_JOB_BLOCK_HANDLE) {
    return {
      status: "unavailable",
      reason: "The review card is not the website-job block.",
    };
  }
  if (parsed.value.manifestId !== head.manifestEventId) {
    return {
      status: "unavailable",
      reason: "The review card manifest does not match the job head.",
    };
  }
  if (parsed.value.data.type !== "inline") {
    return {
      status: "unavailable",
      reason: "The review card brief is stored externally.",
    };
  }
  const data = parseWebsiteInstanceData(parsed.value.data.value);
  if (!data || !websiteInstanceDataMatchesHead(data, head)) {
    return {
      status: "unavailable",
      reason: "The review card data does not match the job head.",
    };
  }
  return { status: "ready", data };
}
