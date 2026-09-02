import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { WorkView } from "@/app/routes/workSearch";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

/**
 * The Tasks page tab bar.
 *
 * Board is first because it is the surface an owner opens to see work moving.
 * Each tab is a `view` search param, so a tab is a link anyone can share and
 * the back button walks the tabs.
 */
export function WorkTopTabs({
  initiativeId,
  view,
}: {
  /** Carried across a switch back to Board so the board keeps its scope. */
  initiativeId: string | undefined;
  view: WorkView;
}) {
  const { goWork, goWorkBoard, goWorkInitiatives, goWorkQueue } =
    useAppNavigation();
  return (
    <div className="border-b border-border/50 px-9 pt-6">
      <Tabs
        className="w-full"
        data-testid="work-top-tabs"
        onValueChange={(next) => {
          if (next === "board") {
            void goWorkBoard(initiativeId);
          } else if (next === "queue") {
            void goWorkQueue();
          } else if (next === "initiatives") {
            void goWorkInitiatives();
          } else {
            void goWork();
          }
        }}
        value={view}
      >
        <TabsList>
          <TabsTrigger data-testid="work-top-tab-board" value="board">
            Board
          </TabsTrigger>
          <TabsTrigger data-testid="work-top-tab-list" value="list">
            Tasks
          </TabsTrigger>
          <TabsTrigger data-testid="work-top-tab-queue" value="queue">
            My queue
          </TabsTrigger>
          <TabsTrigger
            data-testid="work-top-tab-initiatives"
            value="initiatives"
          >
            Initiatives
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
