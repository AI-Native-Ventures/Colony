import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import { ACTION_CENTER_FILTERS, type ActionCenterFilter } from "../contracts";

const FILTER_LABELS: Record<ActionCenterFilter, string> = {
  "needs-action": "Needs action",
  all: "All",
  asks: "Asks",
  blocks: "Blocks",
  reminders: "Reminders",
  workflows: "Workflows",
};

const TRIGGER_CLASS =
  "inline-flex h-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted/70 data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 relative -ml-2 w-auto gap-1 px-2 text-sm font-medium text-foreground";

type ActionCenterFilterMenuProps = {
  availableFilters: readonly ActionCenterFilter[];
  filter: ActionCenterFilter;
  onFilterChange: (filter: ActionCenterFilter) => void;
};

export function ActionCenterFilterMenu({
  availableFilters,
  filter,
  onFilterChange,
}: ActionCenterFilterMenuProps) {
  const activeFilter = FILTER_LABELS[filter] ?? FILTER_LABELS.all;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Filter Action Center: ${activeFilter}`}
          className={cn(TRIGGER_CLASS)}
          data-testid="action-center-filter-trigger"
          type="button"
        >
          <span>{activeFilter}</span>
          <ChevronDown className="text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (ACTION_CENTER_FILTERS.includes(value as ActionCenterFilter)) {
              onFilterChange(value as ActionCenterFilter);
            }
          }}
          value={filter}
        >
          {availableFilters.map((candidate) => (
            <DropdownMenuRadioItem
              data-testid={`action-center-filter-${candidate}`}
              key={candidate}
              value={candidate}
            >
              {FILTER_LABELS[candidate]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
