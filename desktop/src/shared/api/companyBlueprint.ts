import { invokeTauri } from "./tauri";

/**
 * Approving a Blueprint creates a company: employees, teams, a company head on
 * the relay, and three proposed initiatives.
 *
 * The work is split deliberately. The backend owns everything that has to be
 * exactly-once, and everything with a canonical encoding the relay validates:
 * validation, the local records, the journal, and building and signing the
 * relay events. This module publishes those events and reports back. It never
 * constructs one, because a second implementation of that envelope would agree
 * in every test and diverge on the first real company name.
 */
export type CompanyBlueprintExecution = {
  /** Whether this call did the work, or found a previous run had done it. */
  outcome: "created" | "recovered";
  companyId: string;
  /** Employees that now exist, created or already present. */
  personaIds: string[];
  teamIds: string[];
  initiativeIds: string[];
  /** Signed Company Actions to publish, company head first. */
  signedActions: string[];
  checkpoint: string;
};

export type ExecuteCompanyBlueprintInput = {
  /** The exact JSON the owner approved. */
  blueprint: string;
  requestId: string;
  communityScope: string;
  /**
   * The hash carried by the Blueprint Block the owner read.
   *
   * Passed through from the Block, never recomputed here: the backend produced
   * it and the backend verifies it, so a mismatch means the document changed
   * between being shown and being approved.
   */
  expectedHash: string;
  relayPubkey: string;
  channelId: string;
  /**
   * The community profile head read just before calling.
   *
   * The relay mints one for every community at boot, so approval always
   * edits that head rather than creating a fresh one. This command has no
   * relay connection of its own to discover it, so the caller reads it
   * (`companyRepository.getActiveCompanyHead()`) and passes it through, the
   * same shape the Settings profile edit already takes.
   */
  expectedHeadEventId: string;
  expectedHeadCreatedAt: number;
  expectedHeadUpdatedAt: number;
};

/**
 * Create the company's employees and teams, and get back the relay events that
 * publish it.
 *
 * Safe to call again with the same request ID: a second call finds the work
 * done and returns `recovered`. The events it returns carry derived
 * idempotency keys, so republishing them cannot create a second company
 * either.
 */
export async function executeCompanyBlueprint(
  input: ExecuteCompanyBlueprintInput,
): Promise<CompanyBlueprintExecution> {
  return await invokeTauri<CompanyBlueprintExecution>(
    "execute_company_blueprint",
    {
      blueprint: input.blueprint,
      requestId: input.requestId,
      communityScope: input.communityScope,
      expectedHash: input.expectedHash,
      relayPubkey: input.relayPubkey,
      channelId: input.channelId,
      expectedHeadEventId: input.expectedHeadEventId,
      expectedHeadCreatedAt: input.expectedHeadCreatedAt,
      expectedHeadUpdatedAt: input.expectedHeadUpdatedAt,
    },
  );
}

/**
 * Record that the relay accepted the company.
 *
 * Called only once the receipts are in hand. Marking a transaction complete
 * before the relay confirmed would let a resumed run skip a write that never
 * landed.
 */
export async function completeCompanyBlueprint(input: {
  requestId: string;
  communityScope: string;
  companyEventId: string;
}): Promise<string> {
  return await invokeTauri<string>("complete_company_blueprint", {
    requestId: input.requestId,
    communityScope: input.communityScope,
    companyEventId: input.companyEventId,
  });
}
