import { useEffect, useRef, useState } from "react";
import { invokeTauri } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";
import type { AgentResponseProof } from "../../../verifyAgentResponse";
import {
  draftHistoryMemories,
  type HistoryFile,
  type MemoryDraft,
} from "../../../historyDrafts";
import type { GlobalAgentConfigScope } from "@/shared/api/tauriGlobalAgentConfig";
import { RuntimeIcon } from "../../RuntimeIcon";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { FounderLayout } from "../FounderLayout";

type Source = {
  id: string;
  count: number;
  status: string;
  location: string;
  limited: boolean;
};
const agents: Record<string, { name: string; logo: string }> = {
  claude: { name: "Claude Code", logo: "/runtime-icons/claude.png" },
  codex: { name: "Codex", logo: "/runtime-icons/codex.png" },
  openclaw: { name: "OpenClaw", logo: "/harness-logos/openclaw.svg" },
  hermes: { name: "Hermes", logo: "/harness-logos/hermes.png" },
  opencode: { name: "OpenCode", logo: "/harness-logos/opencode.svg" },
  export: { name: "Conversation export", logo: "/landing/colony-wordmark.svg" },
};
/** Optional local import. Only reviewed memories leave the machine, encrypted. */
export function HistoryScreen({
  proof,
  scope,
  businessOnly,
  onBack,
  onContinue,
  busy,
  error: finishError,
}: {
  proof: AgentResponseProof;
  scope: GlobalAgentConfigScope;
  businessOnly: boolean;
  onBack: () => void;
  onContinue: () => Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const [stage, setStage] = useState<
    "intro" | "scanning" | "sources" | "reading" | "review" | "saved"
  >("intro");
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<MemoryDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const run = useRef(0);
  const attempted = useRef(new Set<string>());
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );
  async function work(operation: (current: () => boolean) => Promise<void>) {
    const id = ++run.current;
    setError(null);
    setWorking(true);
    try {
      await proof.assertValid();
      await operation(() => run.current === id);
    } catch (e) {
      if (run.current === id) {
        setError(e instanceof Error ? e.message : String(e));
        if (stage !== "review" && stage !== "saved") setStage("sources");
      }
    } finally {
      if (run.current === id) setWorking(false);
    }
  }
  async function review(files: HistoryFile[], current: () => boolean) {
    const result = await draftHistoryMemories(files);
    if (current()) {
      setDrafts(result);
      setStage("review");
    }
  }
  const locked = working || busy;
  return (
    <FounderLayout step="history" businessOnly={businessOnly}>
      <div className="onb-simple-card" data-testid="onboarding-history-form">
        <div className="onb-simple-form-heading">
          <h2>
            {stage === "review"
              ? "Review your memories"
              : stage === "saved"
                ? "You’re ready"
                : "Let Colony get to know you"}
          </h2>
          <p>
            {stage === "review"
              ? "Keep statements that describe you. Edit or remove anything below."
              : stage === "saved"
                ? "Your approved memories are saved for your teammate."
                : "Colony can find previous AI conversations on this computer. You choose what to keep."}
          </p>
        </div>
        {stage === "intro" && (
          <>
            <div className="onb-history-brands">
              {Object.entries(agents)
                .filter(([id]) => id !== "export")
                .map(([id, a]) => (
                  <div key={id} className="onb-history-source">
                    {id === "codex" ? (
                      <img src={a.logo} alt="" />
                    ) : (
                      <RuntimeIcon
                        runtime={
                          { id, label: a.name } as AcpRuntimeCatalogEntry
                        }
                        className="h-7 w-7"
                      />
                    )}
                    <span>{a.name}</span>
                  </div>
                ))}
            </div>
            <Button
              className="onb-simple-button onb-simple-primary"
              disabled={locked}
              onClick={() =>
                void work(async (current) => {
                  setStage("scanning");
                  const found = await invokeTauri<Source[]>(
                    "discover_onboarding_history",
                  );
                  if (current()) {
                    setSources(found);
                    setStage("sources");
                  }
                })
              }
            >
              Find my history
            </Button>
          </>
        )}
        {(stage === "scanning" || stage === "reading") && (
          <p role="status">
            {stage === "scanning"
              ? "Colony is checking supported applications…"
              : "Colony is finding useful statements locally…"}
          </p>
        )}
        {stage === "sources" && (
          <>
            <div className="onb-history-sources">
              {sources.map((source) => (
                <label key={source.id} className="onb-history-source">
                  <input
                    type="checkbox"
                    disabled={locked || source.status !== "found"}
                    checked={selected.includes(source.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, source.id]
                          : selected.filter((id) => id !== source.id),
                      )
                    }
                  />
                  {source.id === "codex" ? (
                    <img src={agents.codex.logo} alt="" />
                  ) : (
                    <RuntimeIcon
                      runtime={
                        {
                          id: source.id,
                          label: agents[source.id].name,
                        } as AcpRuntimeCatalogEntry
                      }
                      className="h-7 w-7"
                    />
                  )}
                  <span>
                    {agents[source.id].name}
                    <small>
                      {source.status === "found"
                        ? `${source.count}${source.limited ? "+" : ""} ${source.id === "hermes" ? "CLI sessions" : "history files"}`
                        : source.status === "export-required"
                          ? "Local format not supported yet"
                          : source.status === "unavailable"
                            ? "Folder unavailable"
                            : "No supported history found"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <p className="onb-simple-note">
              Colony reads a bounded sample on this computer. Only memories you
              approve are saved privately for your teammate.
            </p>
            <Button
              className="onb-simple-button onb-simple-primary"
              disabled={locked || !selected.length}
              onClick={() =>
                void work(async (current) => {
                  setStage("reading");
                  const files = await invokeTauri<HistoryFile[]>(
                    "read_onboarding_history",
                    { sourceIds: selected },
                  );
                  await review(files, current);
                })
              }
            >
              Create my memories
            </Button>
          </>
        )}
        {["intro", "sources"].includes(stage) && (
          <label className="onb-simple-link">
            Choose a ChatGPT or Claude export
            <input
              className="sr-only"
              type="file"
              accept=".json,application/json"
              disabled={locked}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void work(async (current) => {
                  if (file.size > 16 * 1024 * 1024)
                    throw new Error("Choose a JSON export smaller than 16 MB.");
                  setStage("reading");
                  await review(
                    [
                      {
                        source: "export",
                        name: file.name,
                        text: await file.text(),
                      },
                    ],
                    current,
                  );
                });
              }}
            />
          </label>
        )}
        {stage === "review" && (
          <>
            {drafts.length === 0 ? (
              <p>
                No clear personal statements found. You can choose another
                export or continue without memories.
              </p>
            ) : (
              drafts.map((d, index) => (
                <div key={d.id} className="onb-memory-draft">
                  <label>
                    <input
                      type="checkbox"
                      checked={d.keep}
                      disabled={locked}
                      onChange={(e) =>
                        setDrafts((items) =>
                          items.map((m, i) =>
                            i === index ? { ...m, keep: e.target.checked } : m,
                          ),
                        )
                      }
                    />{" "}
                    Keep this memory
                  </label>
                  <textarea
                    aria-label={`Memory ${index + 1}`}
                    value={d.text}
                    maxLength={500}
                    disabled={locked || !d.keep}
                    onChange={(e) =>
                      setDrafts((items) =>
                        items.map((m, i) =>
                          i === index ? { ...m, text: e.target.value } : m,
                        ),
                      )
                    }
                  />
                  <small>
                    {agents[d.source].name}
                    {d.date ? ` · ${d.date}` : ""} · {d.file}
                  </small>
                </div>
              ))
            )}
            <Button
              className="onb-simple-button onb-simple-primary"
              disabled={locked || drafts.some((d) => d.keep && !d.text.trim())}
              onClick={() =>
                void work(async (current) => {
                  const memories = drafts
                    .filter((d) => d.keep || attempted.current.has(d.id))
                    .map((d) => ({
                      id: d.id,
                      text: d.keep
                        ? `${d.text.trim()}\n\nSource: ${agents[d.source].name}; ${d.file}; ${d.date || "date unavailable"}. Reviewed by owner during onboarding.`
                        : null,
                    }));
                  for (const memory of memories)
                    attempted.current.add(memory.id);
                  if (memories.length)
                    await invokeTauri("save_onboarding_memories", {
                      agentPubkey: proof.agentPubkey,
                      expectedOwnerPubkey: scope.ownerPubkey,
                      expectedRelayUrl: scope.relayUrl,
                      memories,
                    });
                  if (current()) setStage("saved");
                })
              }
            >
              {working ? "Saving…" : "Save and continue"}
            </Button>
          </>
        )}
        {stage === "saved" && (
          <>
            <Button
              className="onb-simple-button onb-simple-primary"
              disabled={locked}
              onClick={() => void onContinue()}
            >
              {busy ? "Opening Colony…" : "Open my Colony"}
            </Button>
            <button
              type="button"
              className="onb-simple-link"
              disabled={locked}
              onClick={() =>
                void work(async (current) => {
                  await invokeTauri("save_onboarding_memories", {
                    agentPubkey: proof.agentPubkey,
                    expectedOwnerPubkey: scope.ownerPubkey,
                    expectedRelayUrl: scope.relayUrl,
                    memories: drafts
                      .filter((d) => d.keep)
                      .map((d) => ({ id: d.id, text: null })),
                  });
                  if (current()) {
                    setDrafts([]);
                    setStage("review");
                  }
                })
              }
            >
              Remove imported memories
            </button>
          </>
        )}
        {(error || finishError) && (
          <p role="alert" className="onb-simple-error">
            {error || finishError}
          </p>
        )}
        {stage !== "saved" && (
          <button
            type="button"
            className="onb-simple-link"
            disabled={locked}
            onClick={() => void onContinue()}
          >
            Skip for now
          </button>
        )}
        <button
          type="button"
          className="onb-simple-link"
          disabled={busy}
          onClick={() => {
            run.current++;
            onBack();
          }}
        >
          Back to connection
        </button>
      </div>
    </FounderLayout>
  );
}
