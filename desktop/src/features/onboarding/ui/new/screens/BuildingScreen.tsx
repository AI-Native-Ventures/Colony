// desktop/src/features/onboarding/ui/new/screens/BuildingScreen.tsx
import { useEffect, useRef, useState } from "react";

import { useAcpRuntimesQuery } from "@/features/agents/hooks";
import type { GlobalAgentConfig } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import type { OnboardingServices, ScrapeResult } from "../../../contracts";
import { PROBE_BUDGET_MS, resolveTrack } from "../../../flow/track";
import type { TrackResult } from "../../../flow/track";
import { descriptionShortfall } from "../../../flow/validation";
import {
  BUILDING_HEADLINE,
  DRAFT_OPENERS,
  DRAFT_OPENERS_LABEL,
  SCRAPE_FAILURE_COPY,
  draftCopy,
  workLines,
} from "./buildingCopy";

/**
 * Whole-step budget for the website read. It spends Colony's own money on a
 * scrape and must never hold the user longer than this, whatever the site does.
 */
export const READING_BUDGET_MS = 30000;

/**
 * How long the first line sits unfinished.
 *
 * The workspace was claimed on the screen before this one, so this line is a
 * report of something already true rather than work being waited on. It is
 * held for a beat so the list reads as a list rather than opening with a line
 * that is already ticked.
 */
const WORKSPACE_BEAT_MS = 700;

/** The same beat, for turning a returned scrape into a written draft. */
const DRAFT_BEAT_MS = 700;

type LineStatus = "doing" | "done" | "failed";

type Props = {
  hasWebsite: boolean;
  /** Normalised web address, empty when there is none. */
  website: string;
  globalConfig: GlobalAgentConfig;
  services: OnboardingServices;
  reducedMotion: boolean;
  /** The draft, owned by the flow so a resume keeps what was edited. */
  value: string;
  onChange: (value: string) => void;
  /** What the probe found. Fires once; the screen does not navigate on it. */
  onProbeResolved: (result: TrackResult) => void;
  /** What the read returned, typed either way. Fires once, and only with a
   *  website. */
  onReadDone: (result: ScrapeResult) => void;
  onContinue: () => void;
};

/**
 * One screen for the whole of what Colony does while the founder waits.
 *
 * This was three: a probe screen with a walking ant, a reading screen with a
 * fake browser window, and a description screen that finally asked for
 * something. Two of the three showed work without ever showing what came of
 * it, and the third arrived with no memory of the two before it. The work is
 * the same; it is shown as one list that ticks, ending on the draft the list
 * produced.
 *
 * Both jobs start on mount and run in parallel: the probe reads the computer,
 * the read spends money on a scrape. Neither is re-entered, which is why
 * `isWorkingStep` keeps Back off this screen.
 */
export function BuildingScreen({
  hasWebsite,
  website,
  globalConfig,
  services,
  reducedMotion,
  value,
  onChange,
  onProbeResolved,
  onReadDone,
  onContinue,
}: Props) {
  const runtimes = useAcpRuntimesQuery();
  const [workspaceDone, setWorkspaceDone] = useState(reducedMotion);
  const [probeDone, setProbeDone] = useState(false);
  const [readOutcome, setReadOutcome] = useState<ScrapeResult | null>(null);
  const [draftDone, setDraftDone] = useState(false);

  useEffect(() => {
    if (workspaceDone) return undefined;
    const id = setTimeout(() => setWorkspaceDone(true), WORKSPACE_BEAT_MS);
    return () => clearTimeout(id);
  }, [workspaceDone]);

  // Both jobs report exactly once for the life of the screen. The effects
  // re-run when the runtime query settles, and the screen stays mounted long
  // after that, so a background refetch would otherwise report a second time
  // and reset a brain preselection the founder may already have moved past.
  const probeReported = useRef(false);
  const readReported = useRef(false);

  // The probe. Capped as a whole: a binary that never answers is treated as
  // absent rather than being allowed to end onboarding.
  useEffect(() => {
    let cancelled = false;
    const settle = (result: TrackResult) => {
      if (cancelled || probeReported.current) return;
      probeReported.current = true;
      setProbeDone(true);
      onProbeResolved(result);
    };
    const budget = setTimeout(
      () => settle({ track: "colony", installed: [], brains: [] }),
      PROBE_BUDGET_MS,
    );
    if (runtimes.data) {
      clearTimeout(budget);
      settle(resolveTrack(runtimes.data, globalConfig));
    }
    return () => {
      cancelled = true;
      clearTimeout(budget);
    };
  }, [runtimes.data, globalConfig, onProbeResolved]);

  // The read. Capped as a whole: a site that never answers reports a typed
  // timeout instead of holding the user here, so nobody can be trapped.
  useEffect(() => {
    if (!hasWebsite) return undefined;
    let cancelled = false;
    const finish = (result: ScrapeResult) => {
      if (cancelled || readReported.current) return;
      readReported.current = true;
      setReadOutcome(result);
      onReadDone(result);
    };
    const budget = setTimeout(
      () => finish({ ok: false, reason: "timeout" }),
      READING_BUDGET_MS,
    );
    services.scrape
      .describeBusiness(website)
      .then((result) => {
        clearTimeout(budget);
        finish(result);
      })
      .catch(() => {
        clearTimeout(budget);
        // A rejected read is still a typed failure, never an unhandled error.
        finish({ ok: false, reason: "unreachable" });
      });
    return () => {
      cancelled = true;
      clearTimeout(budget);
    };
  }, [hasWebsite, website, services, onReadDone]);

  // The draft line only exists when a read came back with something to write
  // down. A failed read goes straight to the box.
  useEffect(() => {
    if (!readOutcome?.ok || draftDone) return undefined;
    if (reducedMotion) {
      setDraftDone(true);
      return undefined;
    }
    const id = setTimeout(() => setDraftDone(true), DRAFT_BEAT_MS);
    return () => clearTimeout(id);
  }, [readOutcome, draftDone, reducedMotion]);

  const scrapeFailed = readOutcome !== null && !readOutcome.ok;
  const lines = workLines(hasWebsite);

  const statusOf = (id: string): LineStatus => {
    if (id === "workspace") return workspaceDone ? "done" : "doing";
    if (id === "computer") return probeDone ? "done" : "doing";
    if (id === "website") {
      if (readOutcome === null) return "doing";
      return readOutcome.ok ? "done" : "failed";
    }
    // The draft line follows the read: a failure there settles this one too,
    // because there is nothing left for it to wait on.
    if (readOutcome === null) return "doing";
    if (!readOutcome.ok) return "failed";
    return draftDone ? "done" : "doing";
  };

  const settled = lines.every((line) => statusOf(line.id) !== "doing");
  const copy = draftCopy({ hasWebsite, scrapeFailed });
  const shortfall = descriptionShortfall(value);
  // Nothing was read, so there is nothing to show: openers stand in for the
  // blank box rather than beside a draft that already says something.
  const showOpeners = !hasWebsite && value.trim().length === 0;

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          {settled ? (
            copy.title
          ) : (
            <>
              {BUILDING_HEADLINE.lead}
              <em>{BUILDING_HEADLINE.emphasis}</em>
              {BUILDING_HEADLINE.tail}
            </>
          )}
        </h1>
        {settled ? <p className="onb-sub">{copy.sub}</p> : null}
      </div>
      <div className="onb-panel">
        <ul
          className="onb-worklist"
          aria-live="polite"
          data-testid="onboarding-building-list"
        >
          {lines.map((line) => {
            const status = statusOf(line.id);
            return (
              <li key={line.id} className="onb-work" data-status={status}>
                <span className="onb-work__mark" aria-hidden="true" />
                <span className="onb-work__label">
                  {status === "failed"
                    ? (SCRAPE_FAILURE_COPY[
                        readOutcome !== null && !readOutcome.ok
                          ? readOutcome.reason
                          : "unreachable"
                      ] ?? line.doing)
                    : status === "done"
                      ? line.done
                      : line.doing}
                </span>
              </li>
            );
          })}
        </ul>
        {settled ? (
          <div className="onb-draft">
            <Textarea
              rows={5}
              value={value}
              placeholder="We repair and service cars in Johannesburg."
              onChange={(event) => onChange(event.target.value)}
            />
            {showOpeners ? (
              <div className="onb-openers">
                <p className="onb-label">{DRAFT_OPENERS_LABEL}</p>
                {DRAFT_OPENERS.map((opener) => (
                  <button
                    type="button"
                    key={opener}
                    className="onb-option"
                    onClick={() => onChange(opener)}
                  >
                    <span className="onb-option__title">{opener}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="onb-note">
                {shortfall === 0
                  ? `${value.trim().length} characters`
                  : `${shortfall} more characters`}
              </p>
            )}
          </div>
        ) : null}
      </div>
      {settled ? (
        <div className="onb-actions">
          <Button size="lg" disabled={shortfall > 0} onClick={onContinue}>
            Looks right
          </Button>
        </div>
      ) : null}
    </div>
  );
}
