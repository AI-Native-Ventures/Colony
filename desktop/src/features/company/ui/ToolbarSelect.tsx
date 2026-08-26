import { ChevronDown } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/**
 * A labelled single-choice dropdown for a work-surface toolbar (group by,
 * sort, filter, columns). Shared by the list and board screens so the two
 * surfaces' controls look and behave identically.
 */
export function ToolbarSelect({
  label,
  testId,
  value,
  values,
  valueLabels,
  onChange,
}: {
  label: string;
  onChange: (value: string) => void;
  testId: string;
  value: string;
  valueLabels: Record<string, string>;
  values: readonly string[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-7 gap-1 px-2 text-xs"
          data-testid={testId}
          size="xs"
          variant="ghost"
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium">{valueLabels[value] ?? value}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup onValueChange={onChange} value={value}>
          {values.map((entry) => (
            <DropdownMenuRadioItem key={entry} value={entry}>
              {valueLabels[entry] ?? entry}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
