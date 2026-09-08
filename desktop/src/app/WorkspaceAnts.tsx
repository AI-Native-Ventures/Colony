import { AntMark } from "@/shared/ui/colony-logo/AntMark";

/** Static Colony marks in the sidebar footer, clear of the reading panes. */
export function WorkspaceAnts() {
  return (
    <div
      aria-hidden="true"
      className="colony-workspace-ants pointer-events-none relative h-12 shrink-0 overflow-hidden"
    >
      <span className="absolute left-[15%] top-1 w-7 -rotate-12">
        <AntMark />
      </span>
      <span className="absolute left-[30%] top-5 w-6 rotate-12">
        <AntMark />
      </span>
      <span className="absolute left-[44%] top-7 w-5 -rotate-12">
        <AntMark />
      </span>
    </div>
  );
}
