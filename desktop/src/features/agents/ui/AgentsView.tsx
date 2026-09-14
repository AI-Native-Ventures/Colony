import * as React from "react";
import { EllipsisVertical, OctagonX, Settings2 } from "lucide-react";
import {
  consumePendingSnapshotImport,
  subscribeSnapshotImport,
} from "@/features/agents/openSnapshotImportFromUrlEvent";
import { AddAgentToChannelDialog } from "./AddAgentToChannelDialog";
import { AgentDefaultsDialog } from "./AgentDefaultsDialog";
import { AgentDialog } from "./AgentDialog";
import { PersonaCatalogDialog } from "./PersonaCatalogDialog";
import { PersonaDeleteDialog } from "./PersonaDeleteDialog";
import { PersonaShareDialog } from "./PersonaShareDialog";
import { AgentSnapshotExportDialog } from "./AgentSnapshotExportDialog";
import { AgentSnapshotImportDialog } from "./AgentSnapshotImportDialog";
import { PeopleSection } from "./PeopleSection";
import { UnassignedAgentsBanner } from "./UnassignedAgentsBanner";
import { UnifiedAgentsSection } from "./UnifiedAgentsSection";
import { useManagedAgentActions } from "./useManagedAgentActions";
import { usePersonaActions } from "./usePersonaActions";
import { useProfilePanel } from "@/shared/context/ProfilePanelContext";
import { useBakedBuildEnvQuery } from "@/features/agents/hooks";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { useGlobalAgentConfig } from "@/features/agents/useGlobalAgentConfig";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { PageHeader } from "@/shared/ui/PageHeader";
import { getInheritedAgentDefaults } from "./bakedEnvHelpers";

export function AgentsView() {
  const { openPersonaProfilePanel, openProfilePanel } = useProfilePanel();
  const { globalConfig } = useGlobalAgentConfig();
  const { data: bakedEnv } = useBakedBuildEnvQuery({ enabled: true });
  const inheritedDefaults = getInheritedAgentDefaults(globalConfig, bakedEnv);
  const agents = useManagedAgentActions();
  const personas = usePersonaActions();
  const aiDefaultsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const fullAiDefaultsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const compactActionsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [isAiDefaultsOpen, setIsAiDefaultsOpen] = React.useState(false);
  function openUnifiedCatalog() {
    personas.prepareCreate();
    personas.openCatalog();
  }

  function openAiDefaults(trigger: HTMLButtonElement | null) {
    aiDefaultsTriggerRef.current = trigger;
    setIsAiDefaultsOpen(true);
  }

  function setAiDefaultsDialogOpen(open: boolean) {
    if (!open) {
      aiDefaultsTriggerRef.current =
        fullAiDefaultsTriggerRef.current?.offsetParent !== null
          ? fullAiDefaultsTriggerRef.current
          : compactActionsTriggerRef.current;
    }
    setIsAiDefaultsOpen(open);
  }

  const isActionPending = agents.isPending || personas.isPending;
  const runningAgentCount = agents.managedAgents.filter((agent) =>
    isManagedAgentActive(agent),
  ).length;
  const hasSavedAgentDefaults = Boolean(
    globalConfig.preferred_runtime?.trim() ||
      globalConfig.provider?.trim() ||
      globalConfig.model?.trim() ||
      Object.values(globalConfig.env_vars).some(
        (value) => value.trim().length > 0,
      ),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; personas.handleImportSnapshotFile is stable
  React.useEffect(() => {
    // Consume a snapshot import that was enqueued before navigation (e.g. from
    // a timeline AgentSnapshotCard click that navigated here).
    const pending = consumePendingSnapshotImport();
    if (pending) {
      void personas.handleImportSnapshotFile(
        pending.fileBytes,
        pending.fileName,
      );
    }

    return subscribeSnapshotImport(({ fileBytes, fileName }) => {
      void personas.handleImportSnapshotFile(fileBytes, fileName);
    });
  }, []);

  return (
    <>
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8">
        <div
          className="mx-auto w-full max-w-6xl space-y-8 [container-type:inline-size]"
          data-testid="agents-page-content"
        >
          <PageHeader
            action={
              <>
                <div className="flex flex-wrap justify-end gap-2 [@container(max-width:40rem)]:hidden">
                  <Button
                    data-testid="agent-defaults-button"
                    ref={fullAiDefaultsTriggerRef}
                    onClick={(event) => openAiDefaults(event.currentTarget)}
                    size="sm"
                    variant="outline"
                  >
                    <Settings2 />
                    {hasSavedAgentDefaults
                      ? "Agent defaults"
                      : "Set agent defaults"}
                  </Button>
                  {runningAgentCount > 0 ? (
                    <Button
                      disabled={isActionPending}
                      onClick={() => {
                        void agents.handleBulkStopRunning();
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <OctagonX />
                      Stop running agents
                    </Button>
                  ) : null}
                </div>

                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label="Agent actions"
                      className="hidden [@container(max-width:40rem)]:inline-flex"
                      data-testid="agent-actions-menu-trigger"
                      ref={compactActionsTriggerRef}
                      size="icon"
                      type="button"
                      variant="outline"
                    >
                      <EllipsisVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        openAiDefaults(compactActionsTriggerRef.current);
                      }}
                    >
                      <Settings2 />
                      {hasSavedAgentDefaults
                        ? "Agent defaults"
                        : "Set agent defaults"}
                    </DropdownMenuItem>
                    {runningAgentCount > 0 ? (
                      <DropdownMenuItem
                        disabled={isActionPending}
                        onSelect={() => {
                          void agents.handleBulkStopRunning();
                        }}
                      >
                        <OctagonX />
                        Stop running agents
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
            description="Set up and manage your agents."
            title="Agents"
          />
          <div className="flex flex-col gap-8">
            <UnassignedAgentsBanner agents={agents.managedAgents} />
            <UnifiedAgentsSection
              defaultModel={inheritedDefaults.model.value}
              actionErrorMessage={agents.actionErrorMessage}
              actionNoticeMessage={agents.actionNoticeMessage}
              agents={agents.managedAgents}
              agentsError={
                agents.managedAgentsQuery.error instanceof Error
                  ? agents.managedAgentsQuery.error
                  : null
              }
              isActionPending={isActionPending}
              isAgentsLoading={agents.managedAgentsQuery.isLoading}
              startingAgentPubkey={agents.startingAgentPubkey}
              restartingAgentPubkey={agents.restartingAgentPubkey}
              startingPersonaIds={agents.startingPersonaIds}
              onOpenAgentProfile={(pubkey, options) => {
                openProfilePanel?.(pubkey, options);
              }}
              onOpenPersonaProfile={(persona) => {
                openPersonaProfilePanel?.(persona);
              }}
              onStartAgent={(pubkey) => {
                void agents.handleStart(pubkey);
              }}
              onRestartAgent={(pubkey) => {
                void agents.handleRestart(pubkey);
              }}
              onStartPersona={(persona) => {
                void agents.handleStartPersona(persona);
              }}
              // Persona props
              personas={personas.libraryPersonas}
              personasError={
                personas.personasQuery.error instanceof Error
                  ? personas.personasQuery.error
                  : null
              }
              personaFeedbackErrorMessage={
                personas.personaFeedbackSurface === "library"
                  ? personas.personaErrorMessage
                  : null
              }
              personaFeedbackNoticeMessage={
                personas.personaFeedbackSurface === "library"
                  ? personas.personaNoticeMessage
                  : null
              }
              isPersonasLoading={personas.personasQuery.isLoading}
              isPersonasPending={personas.isPending}
              onOpenCatalog={openUnifiedCatalog}
              onDuplicatePersona={personas.openDuplicate}
              onEditPersona={personas.openEdit}
              onSharePersona={personas.openShare}
              onDeactivatePersona={(persona) => {
                void personas.handleSetActive(persona, false, "library");
              }}
              onDeletePersona={personas.openDelete}
            />

            <PeopleSection />
          </div>
        </div>
      </div>

      <AgentDefaultsDialog
        onOpenChange={setAiDefaultsDialogOpen}
        open={isAiDefaultsOpen}
        returnFocusRef={aiDefaultsTriggerRef}
      />

      {agents.agentToAddToChannel ? (
        <AddAgentToChannelDialog
          agent={agents.agentToAddToChannel}
          onAdded={agents.handleAddedToChannel}
          onOpenChange={(open) => {
            if (!open) {
              agents.setAgentToAddToChannel(null);
            }
          }}
          open={agents.agentToAddToChannel !== null}
        />
      ) : null}
      {personas.personaDialogState ? (
        <AgentDialog
          description={personas.personaDialogState.description}
          error={
            personas.updatePersonaMutation.error instanceof Error
              ? personas.updatePersonaMutation.error
              : personas.updatePersonaAndPublishMutation.error instanceof Error
                ? personas.updatePersonaAndPublishMutation.error
                : personas.createPersonaMutation.error instanceof Error
                  ? personas.createPersonaMutation.error
                  : null
          }
          initialValues={personas.personaDialogState.initialValues}
          isPending={personas.isPending}
          mode="definition-edit"
          runtimes={personas.acpRuntimesQuery.data ?? []}
          runtimeCatalogStatus={
            personas.acpRuntimesQuery.isLoading
              ? "loading"
              : personas.acpRuntimesQuery.isError
                ? "error"
                : "ready"
          }
          onOpenChange={(open) => {
            if (!open) {
              personas.setPersonaDialogState(null);
            }
          }}
          onSubmit={(input, options) =>
            personas.handleSubmit(
              input,
              undefined,
              undefined,
              undefined,
              options,
            )
          }
          open={personas.personaDialogState !== null}
          publishCatalogUpdatesOnSave={
            "id" in personas.personaDialogState.initialValues &&
            personas.sharedCatalogPersonaIdSet.has(
              personas.personaDialogState.initialValues.id,
            )
          }
          submitLabel={personas.personaDialogState.submitLabel}
          title={personas.personaDialogState.title}
        />
      ) : null}
      {personas.personaToDelete ? (
        <PersonaDeleteDialog
          instanceCount={
            (agents.managedAgents ?? []).filter(
              (a) => a.personaId === personas.personaToDelete?.id,
            ).length
          }
          onConfirm={(persona) => {
            void personas.handleDelete(persona);
          }}
          onOpenChange={(open) => {
            if (!open) {
              personas.setPersonaToDelete(null);
            }
          }}
          open={personas.personaToDelete !== null}
          persona={personas.personaToDelete}
        />
      ) : null}
      {personas.personaToShare ? (
        <PersonaShareDialog
          catalogShareLevel={personas.getPersonaCatalogShareLevel(
            personas.personaToShare.persona,
          )}
          isPending={personas.isPending}
          linkedAgentPubkey={personas.personaToShare.linkedAgentPubkey}
          effectiveAvatarUrl={personas.personaToShare.effectiveAvatarUrl}
          onCatalogShareLevelChange={(shareLevel) => {
            const shareTarget = personas.personaToShare;
            if (!shareTarget) return;
            void personas.setPersonaCatalogShareLevel(
              shareTarget.persona,
              shareLevel,
            );
          }}
          onExport={() => {
            const shareTarget = personas.personaToShare;
            if (!shareTarget) return;
            personas.setPersonaToShare(null);
            personas.setPersonaToExportSnapshot(shareTarget);
          }}
          onOpenChange={(open) => {
            if (!open) {
              personas.setPersonaToShare(null);
            }
          }}
          open={personas.personaToShare !== null}
          persona={personas.personaToShare.persona}
        />
      ) : null}
      {personas.personaToExportSnapshot ? (
        <AgentSnapshotExportDialog
          agentName={personas.personaToExportSnapshot.persona.displayName}
          isSavePending={personas.isPending}
          open={personas.personaToExportSnapshot !== null}
          linkedAgentPubkey={personas.personaToExportSnapshot.linkedAgentPubkey}
          onSaveFile={(memoryLevel, format) => {
            if (personas.personaToExportSnapshot) {
              personas.handleExportSnapshot(
                personas.personaToExportSnapshot.persona,
                personas.personaToExportSnapshot.linkedAgentPubkey,
                personas.personaToExportSnapshot.effectiveAvatarUrl,
                memoryLevel,
                format,
              );
            }
          }}
          onOpenChange={(open) => {
            if (!open) {
              personas.setPersonaToExportSnapshot(null);
            }
          }}
        />
      ) : null}
      {personas.snapshotImportState ? (
        <AgentSnapshotImportDialog
          open={personas.snapshotImportState !== null}
          preview={personas.snapshotImportState.preview}
          isConfirming={personas.isSnapshotImportConfirming}
          result={personas.snapshotImportResult}
          confirmError={personas.snapshotImportConfirmError}
          onConfirm={(keepAllowlist) => {
            void personas.handleConfirmSnapshotImport(keepAllowlist);
          }}
          onOpenChange={(open) => {
            if (!open) {
              personas.closeSnapshotImportDialog();
            }
          }}
        />
      ) : null}
      {personas.isCatalogDialogOpen ? (
        <PersonaCatalogDialog
          createContent={({ onDirtyChange, onRequestClose }) => (
            <AgentDialog
              definitionError={
                personas.createPersonaMutation.error instanceof Error
                  ? personas.createPersonaMutation.error
                  : null
              }
              embedded
              isDefinitionPending={personas.isPending}
              mode="definition"
              onDirtyChange={onDirtyChange}
              onOpenChange={(open) => {
                if (!open) onRequestClose();
              }}
              onSubmitDefinition={(input, intent, backendIntent, options) =>
                personas.handleSubmit(
                  input,
                  intent,
                  backendIntent,
                  null,
                  options,
                )
              }
              orgPlacement
              runtimes={personas.acpRuntimesQuery.data ?? []}
              runtimeCatalogStatus={
                personas.acpRuntimesQuery.isLoading
                  ? "loading"
                  : personas.acpRuntimesQuery.isError
                    ? "error"
                    : "ready"
              }
              submitLabel="Add agent"
            />
          )}
          error={
            personas.catalogQuery.error instanceof Error
              ? personas.catalogQuery.error
              : null
          }
          feedbackErrorMessage={
            personas.personaFeedbackSurface === "catalog"
              ? personas.personaErrorMessage
              : null
          }
          feedbackNoticeMessage={
            personas.personaFeedbackSurface === "catalog"
              ? personas.personaNoticeMessage
              : null
          }
          isLoading={personas.catalogQuery.isLoading}
          isPending={personas.isPending}
          onClearFeedback={() => {
            personas.clearFeedback("catalog");
          }}
          onImportFile={(fileBytes, fileName) => {
            void personas.handleImportSnapshotFile(fileBytes, fileName);
          }}
          onOpenChange={personas.setIsCatalogDialogOpen}
          onSelectPersona={async (persona, active) => {
            const addedPersona = await personas.handleSetActive(
              persona,
              active,
              "catalog",
            );
            if (!active || !addedPersona) return;

            personas.setIsCatalogDialogOpen(false);
            openPersonaProfilePanel?.(addedPersona);
          }}
          open={personas.isCatalogDialogOpen}
          personas={personas.catalogPersonas}
        />
      ) : null}
    </>
  );
}
