import { useAgentProposalReview } from "@/features/blocks/useAgentProposalReview";
import { AgentDialog } from "./AgentDialog";

/** Global review surface for persisted Core Agent Proposal Blocks. */
export function AgentManagementDialogs() {
  const management = useAgentProposalReview();
  const secondaryAction = {
    label: "Decline",
    onSelect: () => {
      void management.decline();
    },
  };

  return (
    <>
      {management.selectedProposal?.data.mode === "create" ? (
        <AgentDialog
          definitionError={
            management.error ? new Error(management.error) : null
          }
          initialValues={management.createInitialValues}
          isDefinitionPending={management.isPending}
          mode="definition"
          onOpenChange={(open) => {
            if (!open) management.closeReview();
          }}
          onSubmitDefinition={management.submitCreate}
          runtimes={management.runtimes}
          runtimesLoading={management.runtimesLoading}
          secondaryAction={secondaryAction}
        />
      ) : null}
      {management.selectedProposal?.data.mode === "update" ? (
        <AgentDialog
          description=""
          error={management.editError ? new Error(management.editError) : null}
          initialValues={management.editInitialValues}
          isPending={management.isPending}
          mode="definition-edit"
          onOpenChange={(open) => {
            if (!open) management.closeReview();
          }}
          onSubmit={management.submitUpdate}
          open
          runtimes={management.runtimes}
          runtimesLoading={management.runtimesLoading}
          secondaryAction={secondaryAction}
          submitLabel="Save changes"
          title="Edit agent"
        />
      ) : null}
    </>
  );
}
