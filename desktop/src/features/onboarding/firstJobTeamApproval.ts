import { verifyEvent } from "nostr-tools/pure";
import type { AgentProposalSafeAction } from "../blocks/agentProposal";
import type { RelayEvent } from "../../shared/api/types";
import type { FirstJobScope, FirstJobTeam } from "./firstJobStart";

/** The actual pair displayed before the owner authorizes the first job. */
export type FirstJobTeamProposal = {
  scout: { pubkey: string; name: string };
  worker: { pubkey: string | null; name: string; role: string };
  action: AgentProposalSafeAction | null;
};

export type FirstJobTeamApprovalAttempt = {
  content: string;
  proposal: FirstJobTeamProposal;
  approval: RelayEvent | null;
  approvalAcknowledged: boolean;
  team: FirstJobTeam | null;
  receipt: RelayEvent | null;
  receiptAcknowledged: boolean;
};

type Store = {
  read(scope: FirstJobScope): FirstJobTeamApprovalAttempt | null;
  write(scope: FirstJobScope, value: FirstJobTeamApprovalAttempt): void;
  withLock<T>(scope: FirstJobScope, operation: () => Promise<T>): Promise<T>;
};

/** Native and relay operations behind the retained owner approval. */
export type FirstJobTeamApprovalDependencies = {
  store: Store;
  assertCurrent(scope: FirstJobScope): Promise<void>;
  verifySetup(scope: FirstJobScope): Promise<void>;
  /** Recheck the displayed Scout/existing worker immediately before approval. */
  validateProposal(
    scope: FirstJobScope,
    proposal: FirstJobTeamProposal,
  ): Promise<void>;
  sign(input: {
    kind: number;
    content: string;
    tags: string[][];
    createdAt: number;
  }): Promise<RelayEvent>;
  publish(scope: FirstJobScope, event: RelayEvent): Promise<void>;
  execute(
    action: AgentProposalSafeAction,
    relayUrl: string,
  ): Promise<
    | {
        status: "applied";
        agentPubkey: string;
      }
    | { status: "failed"; safeMessage: string }
  >;
  validateTeam(scope: FirstJobScope, team: FirstJobTeam): Promise<void>;
  now(): number;
};

const HEX = /^[a-f0-9]{64}$/;
const APPROVAL = "colony:first-job-team-approval:v1";
const RECEIPT = "colony:first-job-team-receipt:v1";
const text = (value: unknown, max: number) =>
  typeof value === "string" && !!value.trim() && value.length <= max;

/** Strict storage shape; signed bytes and captured scope are checked at execution. */
export function isFirstJobTeamApprovalAttempt(
  value: unknown,
): value is FirstJobTeamApprovalAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as FirstJobTeamApprovalAttempt;
  return (
    text(a.content, 4000) &&
    !!a.proposal &&
    HEX.test(a.proposal.scout?.pubkey ?? "") &&
    text(a.proposal.scout?.name, 100) &&
    (a.proposal.worker?.pubkey === null ||
      HEX.test(a.proposal.worker?.pubkey ?? "")) &&
    text(a.proposal.worker?.name, 100) &&
    text(a.proposal.worker?.role, 100) &&
    (a.proposal.action === null ||
      (!!a.proposal.action && typeof a.proposal.action === "object")) &&
    typeof a.approvalAcknowledged === "boolean" &&
    typeof a.receiptAcknowledged === "boolean" &&
    (a.approval === null
      ? !a.approvalAcknowledged
      : typeof a.approval === "object") &&
    (a.team === null ||
      (a.approvalAcknowledged &&
        HEX.test(a.team.scoutPubkey) &&
        HEX.test(a.team.workerPubkey))) &&
    (a.receipt === null
      ? !a.receiptAcknowledged
      : a.team !== null && typeof a.receipt === "object")
  );
}

function approvalContent(a: FirstJobTeamApprovalAttempt): string {
  return `I approve this team for the brief below: ${a.proposal.scout.name} coordinates and reviews; ${a.proposal.worker.name}, ${a.proposal.worker.role}, does the work.\n\n${a.content}`;
}

function tags(
  scope: FirstJobScope,
  a: FirstJobTeamApprovalAttempt,
  receipt: boolean,
): string[][] {
  return [
    ["h", scope.channelId],
    ["e", scope.threadRootId, "", "reply"],
    ["client", receipt ? RECEIPT : APPROVAL, scope.requestId],
    [
      "first-job-team",
      JSON.stringify(
        receipt
          ? { approval: a.approval?.id, team: a.team }
          : { proposal: a.proposal, brief: a.content },
      ),
    ],
  ];
}

function receiptContent(a: FirstJobTeamApprovalAttempt): string {
  return `${a.proposal.worker.name} is ready to work with ${a.proposal.scout.name} on this brief. The result comes back here for my review.`;
}

function verifyStoredEvent(
  event: RelayEvent,
  scope: FirstJobScope,
  a: FirstJobTeamApprovalAttempt,
  receipt: boolean,
): void {
  if (
    event.kind !== 9 ||
    event.pubkey !== scope.ownerPubkey ||
    event.content !== (receipt ? receiptContent(a) : approvalContent(a)) ||
    JSON.stringify(event.tags) !== JSON.stringify(tags(scope, a, receipt)) ||
    !verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      created_at: event.created_at,
      content: event.content,
      tags: event.tags,
      sig: event.sig,
    })
  ) {
    throw new Error(
      "The saved team approval could not be verified. No new teammate has been created.",
    );
  }
}

/** A click approves one retained team. Mounting, querying and payment never call this. */
export function createFirstJobTeamApproval(
  deps: FirstJobTeamApprovalDependencies,
) {
  return async (
    inputScope: FirstJobScope,
    content: string,
    inputProposal?: FirstJobTeamProposal,
  ): Promise<FirstJobTeam> => {
    const scope = Object.freeze({ ...inputScope });
    const proposal = inputProposal ? structuredClone(inputProposal) : undefined;
    return deps.store.withLock(scope, async () => {
      await deps.assertCurrent(scope);
      await deps.verifySetup(scope);
      await deps.assertCurrent(scope);
      let attempt = deps.store.read(scope);
      if (!attempt) {
        if (!proposal || !text(content, 4000))
          throw new Error(
            "Review the team shown in this thread before starting.",
          );
        attempt = {
          content,
          proposal: structuredClone(proposal),
          approval: null,
          approvalAcknowledged: false,
          team: null,
          receipt: null,
          receiptAcknowledged: false,
        };
        if (!isFirstJobTeamApprovalAttempt(attempt))
          throw new Error("The proposed team is unavailable. Review it again.");
        await deps.validateProposal(scope, attempt.proposal);
        await deps.assertCurrent(scope);
        deps.store.write(scope, attempt);
      } else if (attempt.content !== content) {
        throw new Error(
          "This job already has an approved brief. Resume that brief from this thread.",
        );
      }

      // Revalidate even recovered approvals: an existing agent might have been
      // removed or changed since the owner's original click.
      await deps.validateProposal(scope, attempt.proposal);
      await deps.assertCurrent(scope);
      if (!attempt.approval) {
        const approval = await deps.sign({
          kind: 9,
          content: approvalContent(attempt),
          tags: tags(scope, attempt, false),
          createdAt: Math.floor(deps.now() / 1000),
        });
        await deps.assertCurrent(scope);
        verifyStoredEvent(approval, scope, attempt, false);
        attempt = { ...attempt, approval };
        deps.store.write(scope, attempt);
      }
      const approval = attempt.approval;
      if (!approval)
        throw new Error("The team approval has not been saved. Try again.");
      verifyStoredEvent(approval, scope, attempt, false);
      if (!attempt.approvalAcknowledged) {
        await deps.publish(scope, approval);
        await deps.assertCurrent(scope);
        attempt = { ...attempt, approvalAcknowledged: true };
        deps.store.write(scope, attempt);
      }

      if (attempt.receipt) {
        verifyStoredEvent(attempt.receipt, scope, attempt, true);
      } else {
        // Until a signed result binds the actual worker, recover its identity
        // from native idempotency instead of trusting a local-storage pubkey.
        let workerPubkey = attempt.proposal.worker.pubkey;
        if (attempt.proposal.action) {
          const result = await deps.execute(
            attempt.proposal.action,
            scope.relayUrl,
          );
          await deps.assertCurrent(scope);
          if (result.status !== "applied") throw new Error(result.safeMessage);
          workerPubkey = result.agentPubkey;
        }
        if (
          !workerPubkey ||
          !HEX.test(workerPubkey) ||
          workerPubkey === attempt.proposal.scout.pubkey
        )
          throw new Error(
            "The approved worker could not be confirmed. Retry this saved approval.",
          );
        if (
          attempt.team &&
          (attempt.team.workerPubkey !== workerPubkey ||
            attempt.team.scoutPubkey !== attempt.proposal.scout.pubkey)
        )
          throw new Error(
            "The saved team does not match its approval. No new request has been sent.",
          );
        attempt = {
          ...attempt,
          team: { scoutPubkey: attempt.proposal.scout.pubkey, workerPubkey },
        };
        deps.store.write(scope, attempt);
      }
      const team = attempt.team;
      if (!team)
        throw new Error("The approved team could not be confirmed. Try again.");
      await deps.validateTeam(scope, team);
      await deps.assertCurrent(scope);
      if (!attempt.receipt) {
        const receipt = await deps.sign({
          kind: 9,
          content: receiptContent(attempt),
          tags: tags(scope, attempt, true),
          createdAt: Math.floor(deps.now() / 1000),
        });
        await deps.assertCurrent(scope);
        verifyStoredEvent(receipt, scope, attempt, true);
        attempt = { ...attempt, receipt };
        deps.store.write(scope, attempt);
      }
      const receipt = attempt.receipt;
      if (!receipt)
        throw new Error("The team confirmation has not been saved. Try again.");
      verifyStoredEvent(receipt, scope, attempt, true);
      if (!attempt.receiptAcknowledged) {
        await deps.publish(scope, receipt);
        await deps.assertCurrent(scope);
        attempt = { ...attempt, receiptAcknowledged: true };
        deps.store.write(scope, attempt);
      }
      return { ...team };
    });
  };
}
