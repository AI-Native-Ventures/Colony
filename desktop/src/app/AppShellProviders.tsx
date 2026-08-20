import { AppProfilePanelProvider } from "@/app/AppProfilePanelProvider";
import { AppWorkflowEditorOverlayProvider } from "@/app/AppWorkflowEditorOverlayProvider";

/**
 * The two app-shell context providers that wrap the same subtree.
 *
 * They are composed here rather than nested inline because `AppShell` sits on
 * the desktop size ratchet, and the workflow editor overlay arrived with
 * upstream #6248 after the file was already at its limit.
 */
export function AppShellProviders({ children }: { children: React.ReactNode }) {
  return (
    <AppProfilePanelProvider>
      <AppWorkflowEditorOverlayProvider>
        {children}
      </AppWorkflowEditorOverlayProvider>
    </AppProfilePanelProvider>
  );
}
