/**
 * OAuth PKCE "Connect OpenRouter" control for global agent defaults.
 *
 * Replaces the raw API-key paste field when the effective provider is
 * OpenRouter: a non-technical user connects by authorizing in the system
 * browser — no key is ever discovered, pasted, or shown. The resulting key
 * is stored through the existing provider-key path
 * (`set_global_agent_config` → `env_vars.OPENROUTER_API_KEY`), so agent
 * readiness and spawn behavior are unchanged.
 *
 * Flow states are all visible, never silent: connecting (browser wait),
 * connected, disconnected, cancelled (credentials untouched), and failure
 * (credentials untouched). The control never holds a key — it merges into
 * the config and lets the parent decide whether to persist immediately
 * (settings auto-save) or stage the draft (onboarding coalescer).
 */
import * as React from "react";
import { AlertCircle, Check, ExternalLink, Loader, Unplug } from "lucide-react";

import { connectOpenRouter } from "@/shared/api/tauriOpenRouter";
import type { GlobalAgentConfig } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { RequiredFieldLabel } from "./agentConfigControls";

/** The existing provider-key env var used by the agent spawn path. */
export const OPENROUTER_API_KEY = "OPENROUTER_API_KEY";

/** Merge a freshly exchanged key into the config's env vars. */
export function withOpenRouterKey(
  config: GlobalAgentConfig,
  key: string,
): GlobalAgentConfig {
  return {
    ...config,
    env_vars: { ...config.env_vars, [OPENROUTER_API_KEY]: key },
  };
}

/** Remove the stored key from the config's env vars. */
export function withoutOpenRouterKey(
  config: GlobalAgentConfig,
): GlobalAgentConfig {
  const env_vars = { ...config.env_vars };
  delete env_vars[OPENROUTER_API_KEY];
  return { ...config, env_vars };
}

type FlowPhase = "idle" | "connecting" | "saving";

type Notice =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | null;

export function OpenRouterConnectField({
  config,
  connected,
  inheritedLabel,
  onConfigChange,
  onAutoSaveConfig,
}: {
  /** Current config draft; the key merge/removal is derived from it. */
  config: GlobalAgentConfig;
  /** True when `env_vars.OPENROUTER_API_KEY` holds a value. */
  connected: boolean;
  /** Human-readable source when the key is satisfied by an inherited layer. */
  inheritedLabel?: string;
  /** Draft staging (onboarding coalescer) when no auto-save is wired. */
  onConfigChange: (next: GlobalAgentConfig) => void;
  /** Persist immediately through `set_global_agent_config`; rejects with a user-safe message. */
  onAutoSaveConfig?: (next: GlobalAgentConfig) => Promise<unknown>;
}) {
  const [phase, setPhase] = React.useState<FlowPhase>("idle");
  const [notice, setNotice] = React.useState<Notice>(null);
  // Latest-value read for the async handler: the merge must be based on the
  // config at save time, not the one captured when Connect was clicked —
  // the browser flow can take minutes, and edits made meanwhile must survive.
  const configRef = React.useRef(config);
  configRef.current = config;

  async function persist(next: GlobalAgentConfig) {
    if (onAutoSaveConfig) {
      await onAutoSaveConfig(next);
    } else {
      onConfigChange(next);
    }
  }

  async function handleConnect() {
    if (phase !== "idle") return;
    setPhase("connecting");
    setNotice(null);
    try {
      const outcome = await connectOpenRouter();
      if (outcome.status === "connected") {
        setPhase("saving");
        try {
          await persist(withOpenRouterKey(configRef.current, outcome.key));
          setNotice({
            kind: "info",
            text: "Connected. The OpenRouter key is stored in agent defaults.",
          });
        } catch (err) {
          setNotice({
            kind: "error",
            text:
              typeof err === "string"
                ? err
                : "The key was received but could not be saved. Try again.",
          });
        } finally {
          setPhase("idle");
        }
      } else if (outcome.status === "cancelled") {
        setNotice({
          kind: "info",
          text: "Connection cancelled. Your existing credentials were left unchanged.",
        });
        setPhase("idle");
      } else {
        setNotice({ kind: "error", text: outcome.message });
        setPhase("idle");
      }
    } catch (err) {
      setNotice({
        kind: "error",
        text:
          typeof err === "string"
            ? err
            : "Couldn't start the connection. Try again.",
      });
      setPhase("idle");
    }
  }

  async function handleDisconnect() {
    if (phase !== "idle") return;
    setPhase("saving");
    setNotice(null);
    try {
      await persist(withoutOpenRouterKey(configRef.current));
      setNotice({
        kind: "info",
        text: "Disconnected. The stored OpenRouter key was removed.",
      });
    } catch (err) {
      setNotice({
        kind: "error",
        text: typeof err === "string" ? err : "Couldn't disconnect. Try again.",
      });
    } finally {
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";

  return (
    <div className="space-y-1.5" data-testid="openrouter-connect-field">
      <RequiredFieldLabel
        htmlFor="openrouter-connect-button"
        isRequired={!connected}
      >
        OpenRouter
      </RequiredFieldLabel>
      {connected ? (
        <div
          className={cn(
            "flex min-h-11 flex-wrap items-center justify-between gap-2 px-3",
            "rounded-xl border border-border bg-background",
          )}
          data-testid="openrouter-connected-row"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            <Check className="size-4 shrink-0 text-green-600 dark:text-green-400" />
            Connected to OpenRouter
            {inheritedLabel ? (
              <span className="truncate text-muted-foreground">
                ({inheritedLabel})
              </span>
            ) : null}
          </span>
          <Button
            data-testid="openrouter-disconnect-button"
            disabled={busy}
            onClick={() => void handleDisconnect()}
            size="sm"
            variant="outline"
          >
            {phase === "saving" ? (
              <Loader className="animate-spin" />
            ) : (
              <Unplug />
            )}
            Disconnect
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            "flex min-h-11 flex-wrap items-center justify-between gap-2 px-3",
            "rounded-xl border border-border bg-background",
          )}
        >
          <span className="min-w-0 text-sm text-muted-foreground">
            Authorize in your browser — no API key to paste.
          </span>
          <Button
            data-testid="openrouter-connect-button"
            disabled={busy}
            onClick={() => void handleConnect()}
            size="sm"
          >
            {phase === "connecting" ? (
              <Loader className="animate-spin" />
            ) : (
              <ExternalLink />
            )}
            {phase === "connecting"
              ? "Waiting for authorization…"
              : "Connect OpenRouter"}
          </Button>
        </div>
      )}
      {phase === "connecting" ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="openrouter-connecting-hint"
        >
          Finish signing in in your browser. This waits up to 10 minutes, and
          your existing credentials stay untouched until you confirm.
        </p>
      ) : null}
      {notice ? (
        <p
          className={cn(
            "flex items-start gap-1 text-sm",
            notice.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          data-testid={
            notice.kind === "error"
              ? "openrouter-connect-error"
              : "openrouter-connect-notice"
          }
        >
          {notice.kind === "error" ? (
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          ) : null}
          <span>{notice.text}</span>
        </p>
      ) : null}
    </div>
  );
}
