import type {
  BlockActionControl,
  BlockActionEnvironment,
  BlockCardNode,
  BlockChartNode,
  BlockDetailsNode,
  BlockGap,
  BlockLayoutNode,
  BlockMediaItem,
  BlockMediaNode,
  BlockMetricNode,
  BlockSectionNode,
  BlockStatusNode,
  BlockTableColumn,
  BlockTableNode,
  BlockTone,
  ResolvedChartDatum,
  ResolvedMedia,
  ResolvedStatus,
} from "./types";

const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointerParts(path: string): string[] {
  if (path === "" || path === "/") return [];
  if (!path.startsWith("/")) {
    return path.split(".").filter(Boolean);
  }
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function resolveBlockPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of pointerParts(path)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function formatBlockValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(formatBlockValue).join(", ");
  return JSON.stringify(value);
}

export function resolveBlockTemplate(
  template: string | undefined,
  data: unknown,
  rootData: unknown = data,
): string {
  if (!template) return "";
  return template.replace(TEMPLATE_PATTERN, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const local = resolveBlockPath(data, path);
    return formatBlockValue(
      local === undefined ? resolveBlockPath(rootData, path) : local,
    );
  });
}

export function resolveLayout(node: BlockLayoutNode): {
  kind: "stack" | "grid";
  columns: number;
  gap: BlockGap;
} {
  return {
    kind: node.type,
    columns: node.type === "grid" ? Math.max(1, Math.min(4, node.columns)) : 1,
    gap: node.gap,
  };
}

export function resolveSection(
  node: BlockSectionNode,
  data: unknown,
  rootData?: unknown,
) {
  return {
    title: resolveBlockTemplate(node.title, data, rootData),
    text: resolveBlockTemplate(node.text, data, rootData),
  };
}

export function resolveMetric(
  node: BlockMetricNode,
  data: unknown,
  rootData?: unknown,
) {
  return {
    label: resolveBlockTemplate(node.label, data, rootData),
    value: resolveBlockTemplate(node.value, data, rootData),
    unit: resolveBlockTemplate(node.unit, data, rootData),
  };
}

export function resolveDetails(
  node: BlockDetailsNode,
  data: unknown,
  rootData?: unknown,
) {
  return node.items.map((item) => ({
    label: resolveBlockTemplate(item.label, data, rootData),
    value: resolveBlockTemplate(item.value, data, rootData),
  }));
}

function statusTone(state: string): BlockTone {
  const normalized = state.toLowerCase();
  if (
    ["done", "complete", "completed", "success", "succeeded"].includes(
      normalized,
    )
  ) {
    return "success";
  }
  if (["warning", "blocked", "attention"].includes(normalized))
    return "warning";
  if (["error", "failed", "failure"].includes(normalized)) return "error";
  if (
    ["active", "running", "pending", "processing"].includes(normalized) ||
    normalized.startsWith("pending ")
  ) {
    return "info";
  }
  return "neutral";
}

export function resolveStatus(
  node: BlockStatusNode,
  data: unknown,
  rootData?: unknown,
): ResolvedStatus {
  const raw = node.state_path
    ? resolveBlockPath(data, node.state_path)
    : undefined;
  const record = isRecord(raw) ? raw : undefined;
  const state =
    formatBlockValue(record?.state ?? raw) ||
    resolveBlockTemplate(node.label, data, rootData) ||
    "neutral";
  const progressValue = record?.progress;
  const progress =
    typeof progressValue === "number" && Number.isFinite(progressValue)
      ? Math.max(0, Math.min(100, progressValue))
      : undefined;
  return {
    label: resolveBlockTemplate(node.label, data, rootData),
    state,
    tone: statusTone(state),
    progress,
  };
}

export function resolveTableRows(
  node: BlockTableNode,
  data: unknown,
): Record<string, unknown>[] {
  const rows = resolveBlockPath(data, node.rows_path);
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRecord).slice(0, 200);
}

export function formatBlockCell(
  value: unknown,
  format: BlockTableColumn["format"] = "text",
): string {
  if (value === null || value === undefined) return "—";
  if (format === "boolean") return value ? "Yes" : "No";
  if (format === "number" && typeof value === "number") {
    return new Intl.NumberFormat().format(value);
  }
  if (format === "currency" && typeof value === "number") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(value);
  }
  if (
    format === "date" &&
    (typeof value === "string" || typeof value === "number")
  ) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toLocaleDateString();
  }
  return formatBlockValue(value) || "—";
}

export function stableSortRows(
  rows: readonly Record<string, unknown>[],
  key: string,
  direction: "ascending" | "descending",
): Record<string, unknown>[] {
  const multiplier = direction === "ascending" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const a = left.row[key];
      const b = right.row[key];
      const comparison =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : formatBlockValue(a).localeCompare(formatBlockValue(b), undefined, {
              numeric: true,
              sensitivity: "base",
            });
      return comparison === 0
        ? left.index - right.index
        : comparison * multiplier;
    })
    .map(({ row }) => row);
}

export function filterRows(
  rows: readonly Record<string, unknown>[],
  query: string,
): Record<string, unknown>[] {
  const needle = query.trim().toLocaleLowerCase().slice(0, 120);
  if (!needle) return [...rows];
  return rows.filter((row) =>
    Object.values(row).some((value) =>
      formatBlockValue(value).toLocaleLowerCase().includes(needle),
    ),
  );
}

export function resolveCard(
  node: BlockCardNode,
  data: unknown,
  rootData?: unknown,
) {
  return {
    title: resolveBlockTemplate(node.title, data, rootData),
    description: resolveBlockTemplate(node.description, data, rootData),
  };
}

export function resolveCardListItems(data: unknown, path: string): unknown[] {
  const items = resolveBlockPath(data, path);
  return Array.isArray(items) ? items.slice(0, 200) : [];
}

export function resolveChartData(
  node: BlockChartNode,
  data: unknown,
): ResolvedChartDatum[] {
  const values = resolveBlockPath(data, node.data_path);
  if (!Array.isArray(values)) return [];
  return values
    .filter(isRecord)
    .slice(0, 200)
    .flatMap((item) => {
      const value = item[node.value_key];
      if (typeof value !== "number" || !Number.isFinite(value)) return [];
      return [
        {
          label: formatBlockValue(item[node.label_key]) || "Unlabelled",
          value,
        },
      ];
    });
}

export function isSafeMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function hasValidMediaIntegrity(item: BlockMediaItem): boolean {
  if (!item.expectedSha256 && !item.actualSha256) return true;
  return (
    !!item.expectedSha256 &&
    !!item.actualSha256 &&
    SHA256_PATTERN.test(item.expectedSha256) &&
    SHA256_PATTERN.test(item.actualSha256) &&
    item.expectedSha256 === item.actualSha256
  );
}

export function inferMediaKind(item: BlockMediaItem): BlockMediaItem["kind"] {
  if (item.kind) return item.kind;
  if (item.mime?.startsWith("image/")) return "image";
  if (item.mime?.startsWith("video/")) return "video";
  const path = item.url.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  if (/\.(png|jpe?g|gif|webp|avif)$/.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  return "file";
}

export function resolveMedia(
  node: BlockMediaNode,
  data: unknown,
  supplied?: readonly BlockMediaItem[],
): ResolvedMedia[] {
  const source =
    supplied ??
    (() => {
      const resolved =
        node.url ??
        (node.url_path ? resolveBlockPath(data, node.url_path) : "");
      if (Array.isArray(resolved)) {
        return resolved
          .filter((value): value is string => typeof value === "string")
          .map((url) => ({ url, alt: node.alt }));
      }
      return typeof resolved === "string"
        ? [{ url: resolved, alt: node.alt }]
        : [];
    })();
  if (source.length === 0) return [{ reason: "No media available." }];
  return source.slice(0, 24).map((item) => {
    if (!isSafeMediaUrl(item.url)) {
      return { reason: "Blocked unsafe media URL." };
    }
    if (!hasValidMediaIntegrity(item)) {
      return { reason: "Media integrity check failed." };
    }
    return {
      item: {
        ...item,
        alt: item.alt || node.alt,
        kind: inferMediaKind(item),
      },
    };
  });
}

export function resolveActionAvailability(
  control: BlockActionControl,
  environment: BlockActionEnvironment | undefined,
): { enabled: boolean; reason?: string; pending: boolean; completed: boolean } {
  if (!environment?.trusted || environment.origin === "untrusted") {
    return {
      enabled: false,
      reason: environment?.disabledReason ?? "This Block is not trusted.",
      pending: false,
      completed: false,
    };
  }
  const interaction = control.interaction;
  if (interaction.type === "signed") {
    if (!environment.declaredActionIds.has(interaction.action_id)) {
      return {
        enabled: false,
        reason: "This action is not declared by the pinned manifest.",
        pending: false,
        completed: false,
      };
    }
    if (
      environment.directActionIds &&
      !environment.directActionIds.has(interaction.action_id)
    ) {
      return {
        enabled: false,
        reason:
          environment.actionUnavailableReasons?.get(interaction.action_id) ??
          "Open the review first to complete this action safely.",
        pending: false,
        completed:
          environment.completedActionIds?.has(interaction.action_id) ?? false,
      };
    }
    return {
      enabled: !!environment.submitSigned,
      reason: environment.submitSigned
        ? undefined
        : "Action handling is unavailable.",
      pending: environment.pendingActionId === interaction.action_id,
      completed:
        environment.completedActionIds?.has(interaction.action_id) ?? false,
    };
  }
  const allowed =
    environment.origin === "core" &&
    interaction.surface === "agent-review" &&
    !!environment.openPresentation;
  return {
    enabled: allowed,
    reason: allowed
      ? undefined
      : "This local review surface is unavailable for this Block.",
    pending: false,
    completed: false,
  };
}
