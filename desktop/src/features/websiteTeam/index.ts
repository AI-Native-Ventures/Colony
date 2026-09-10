export { WebsiteTeamInstallDialog } from "./WebsiteTeamInstallDialog";
export {
  assessInstall,
  describePublication,
  isInstallCommunityActive,
  looksLikeConfigurationError,
  normalizeRelay,
  starterPromptFor,
  summarizeAgentStarts,
} from "./installLogic";
export type {
  AgentStartOutcome,
  AgentStartSummary,
  InstallAssessment,
  InstallState,
  PersonaInstallRow,
} from "./installLogic";
export { continueWebsiteTeamInstall } from "./websiteTeamClient";
export type {
  AttachAgentResult,
  ContinueWebsiteTeamDeps,
} from "./websiteTeamClient";
export {
  useWebsiteTeamInstallMutation,
  useWebsiteTeamInstallStatusQuery,
  useWebsiteTeamRecipeQuery,
} from "./useWebsiteTeamInstall";
export type {
  WebsiteTeamInstallInput,
  WebsiteTeamInstallRun,
} from "./useWebsiteTeamInstall";
