import { AntMark } from "@/shared/ui/colony-logo/AntMark";

/** Static Colony marks confined to the frame's unused top margin. */
export function WorkspaceAnts() {
  return (
    <div
      aria-hidden="true"
      className="colony-workspace-ants pointer-events-none absolute inset-x-0 top-0 h-9 overflow-hidden"
    >
      <span className="absolute left-[35%] top-1.5 w-7 -rotate-12">
        <AntMark />
      </span>
      <span className="absolute right-[22%] top-2 w-6 rotate-12">
        <AntMark />
      </span>
      <span className="absolute right-[5%] top-1 w-8 -rotate-12">
        <AntMark />
      </span>
    </div>
  );
}
