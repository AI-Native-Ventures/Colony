/**
 * Which primary view the sidebar should show as active.
 *
 * Declared once and shared, because `AppSidebar` and its pinned header both
 * need it and two hand-maintained copies drift: a view added to one and not
 * the other still compiles, and simply never highlights.
 *
 * Mirrors `AppView` in `app/AppShell.helpers.ts`, minus nothing — the shell
 * derives the value and the sidebar renders it.
 */
export type SidebarSelectedView =
  | "home"
  | "action-center"
  | "channel"
  | "messages"
  | "agents"
  | "blocks"
  | "discovery"
  | "workflows"
  | "pulse"
  | "projects"
  | "spend";
