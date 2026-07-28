import * as React from "react";
import {
  ExternalLink,
  GalleryVerticalEnd,
  KeyRound,
  Lock,
  Sparkles,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import {
  setCardGalleryOpen,
  startCardMint,
} from "@/features/agents/cardMintStore";
import { globalAgentConfigQueryKey } from "@/features/agents/useGlobalAgentConfig";
import {
  cardMintKeyStatus,
  cardMintSaveOpenaiKey,
} from "@/shared/api/tauriPersonas";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";

const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

/**
 * The free alternative, as an action: ordinary snapshot export shares the
 * same importable agent without card art or API spend. Rendered in both the
 * key-setup panel and the normal pre-mint form (the cost disclosure and its
 * escape hatch must be visible BEFORE any spend, not only during onboarding).
 */
function FreeSharePathRow({
  disabled,
  onExportInstead,
}: {
  disabled: boolean;
  onExportInstead?: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3"
      data-testid="agent-card-free-path"
    >
      <p className="text-xs text-muted-foreground">
        Don’t want to spend money? Ordinary export shares the same importable
        agent — free, just without the card art.
      </p>
      {onExportInstead ? (
        <Button
          className="shrink-0"
          data-testid="agent-card-export-instead"
          disabled={disabled}
          onClick={onExportInstead}
          size="sm"
          variant="outline"
        >
          Share without card art
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Mint-a-trading-card dialog — the pre-mint half only: key setup (when
 * needed) → optional style notes → "Mint card". Minting itself runs as a
 * background job in `cardMintStore`: this dialog dispatches and closes, the
 * composer activity rail shows live status, and the finished card opens in
 * the global `AgentCardViewerDialog` (preview, reroll, save, share).
 *
 * The saved PNG carries the agent's `buzz_agent_snapshot` chunk, so sharing
 * the card shares an importable agent (config only — never memory, never
 * identity). All snapshot construction and verification happens in Rust.
 */
export function AgentCardMintDialog({
  agentId,
  agentName,
  canLock,
  onExportInstead,
  onOpenChange,
}: {
  /** Instance pubkey or definition slug — same resolution as snapshot export. */
  agentId: string;
  agentName: string;
  /**
   * True when the agent has a linked instance (a keypair to lock to).
   * Locking is disabled — with an explanation — for bare definitions.
   */
  canLock: boolean;
  /**
   * Free alternative: close this dialog and open the ordinary snapshot
   * export flow (no API spend). Omitted = the action is not rendered.
   */
  onExportInstead?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [styleNotes, setStyleNotes] = React.useState("");
  const [lockCard, setLockCard] = React.useState(false);
  const [keyDraft, setKeyDraft] = React.useState("");

  const queryClient = useQueryClient();

  // Whether a key already resolves through the agent's env layering. While
  // unknown (loading/error) we show the normal mint form — the mint itself
  // still fails cleanly if no key exists.
  const keyStatusQuery = useQuery({
    queryKey: ["cardMintKeyStatus", agentId],
    queryFn: () => cardMintKeyStatus(agentId),
  });
  const needsKey = keyStatusQuery.data === false;

  // Save the pasted key into the global Agent Defaults env — the same single
  // source of truth every agent inherits. Narrow Rust seam: validated
  // single-key merge, never restarts running agents (the mint re-reads
  // config per call, so no restart is needed for minting).
  const saveKeyMutation = useMutation({
    mutationFn: (key: string) => cardMintSaveOpenaiKey(key),
    onSuccess: () => {
      queryClient.setQueryData(["cardMintKeyStatus", agentId], true);
      // The Agent Defaults editor caches the whole config — refetch it so a
      // later-opened settings view shows the key we just wrote.
      void queryClient.invalidateQueries({
        queryKey: globalAgentConfigQueryKey,
      });
      setKeyDraft("");
      toast.success(
        "API key saved to your agent defaults. Running agents pick it up on their next restart.",
      );
    },
    onError: (error) =>
      toast.error(typeof error === "string" ? error : "Couldn't save the key."),
  });

  function beginMint() {
    // Dispatch to the background store and close: the composer rail shows
    // "Minting card…" and the completion toast opens the viewer.
    startCardMint({
      agentId,
      agentName,
      styleNotes: styleNotes.trim() || undefined,
      lock: canLock && lockCard,
    });
    onOpenChange(false);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="max-w-md" data-testid="agent-card-mint-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {`Create ${agentName}'s card`}
          </DialogTitle>
          <DialogDescription>
            Mint a collectible trading card that doubles as a shareable,
            importable copy of this agent.
          </DialogDescription>
        </DialogHeader>

        {needsKey ? (
          <div
            className="flex flex-col gap-4"
            data-testid="agent-card-key-setup"
          >
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <KeyRound className="h-3.5 w-3.5" />
                One-time setup: OpenAI API key
              </span>
              <p className="text-xs text-muted-foreground">
                Minting a card costs money — it generates the art and card text
                through the OpenAI API with your key (typically well under a
                dollar per mint, billed by OpenAI). The key is saved to your
                agent defaults, so you only do this once.
              </p>
              <Button
                className="w-fit px-0 text-xs"
                data-testid="agent-card-key-link"
                onClick={() =>
                  void openUrl(OPENAI_KEYS_URL).catch(() => {
                    toast.error("Failed to open link");
                  })
                }
                size="sm"
                variant="link"
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Get a key at platform.openai.com
              </Button>
              <Input
                autoFocus
                data-testid="agent-card-key-input"
                disabled={saveKeyMutation.isPending}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-…"
                type="password"
                value={keyDraft}
              />
            </div>
            <FreeSharePathRow
              disabled={saveKeyMutation.isPending}
              onExportInstead={onExportInstead}
            />
            <div className="flex justify-end">
              <Button
                data-testid="agent-card-key-save"
                disabled={
                  saveKeyMutation.isPending || keyDraft.trim().length === 0
                }
                onClick={() => saveKeyMutation.mutate(keyDraft.trim())}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {saveKeyMutation.isPending ? "Saving…" : "Save key & continue"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Textarea
                onChange={(e) => setStyleNotes(e.target.value)}
                placeholder="Optional style notes for the art and card text"
                rows={3}
                value={styleNotes}
              />
              <p className="text-xs text-muted-foreground">
                E.g. art “stormy night, lightning motif” or ability “Verify —
                scry 2”. Your directions take priority; anything you leave open
                is designed for you.
              </p>
            </div>
            <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Lock className="h-3.5 w-3.5" />
                  Lock card
                </span>
                <span className="text-xs text-muted-foreground">
                  {canLock
                    ? "Encrypt the embedded agent so only you and this agent can import it. Anyone else sees just the image."
                    : "Locking needs a linked agent instance — start this agent once to enable it."}
                </span>
              </div>
              <Switch
                checked={canLock && lockCard}
                data-testid="agent-card-lock-toggle"
                disabled={!canLock}
                onCheckedChange={setLockCard}
              />
            </div>
            <p
              className="text-xs text-muted-foreground"
              data-testid="agent-card-cost-note"
            >
              Minting calls the OpenAI API with your key and costs money —
              typically well under a dollar per mint, billed by OpenAI. It runs
              in the background (takes a few minutes); you can keep using Buzz
              while it works.
            </p>
            <FreeSharePathRow
              disabled={false}
              onExportInstead={onExportInstead}
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                className="px-0 text-xs"
                data-testid="agent-card-open-gallery"
                onClick={() => {
                  onOpenChange(false);
                  setCardGalleryOpen(true);
                }}
                size="sm"
                variant="link"
              >
                <GalleryVerticalEnd className="mr-1 h-3 w-3" />
                View minted cards
              </Button>
              <Button onClick={beginMint} data-testid="agent-card-mint">
                <Sparkles className="mr-2 h-4 w-4" />
                Mint card
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
