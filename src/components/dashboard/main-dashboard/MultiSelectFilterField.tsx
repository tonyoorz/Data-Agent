import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type MultiSelectFilterFieldProps = {
  label: string;
  options: string[];
  selectedValues: string[];
  onToggleValue: (value: string) => void;
};

function getTriggerText(options: string[], selectedValues: string[]) {
  if (selectedValues.length === 0) {
    return options.length === 0 ? "No values" : "Any";
  }

  if (selectedValues.length === 1) {
    return selectedValues[0];
  }

  return `${selectedValues[0]} +${selectedValues.length - 1}`;
}

const MultiSelectFilterField = ({
  label,
  options,
  selectedValues,
  onToggleValue,
}: MultiSelectFilterFieldProps) => {
  return (
    <div className="space-y-1.5">
      <p className="workbench-filter-label">{label}</p>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="workbench-filter-trigger"
            aria-label={`${label} filter`}
          >
            <span className="min-w-0 flex-1 truncate">{getTriggerText(options, selectedValues)}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{selectedValues.length || options.length}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[260px] rounded-xl border-border/80 p-0">
          <div className="border-b border-border/70 px-4 py-3">
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">{options.length} available values</p>
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto p-2">
            {options.length > 0 ? (
              options.map((option) => {
                const isSelected = selectedValues.includes(option);

                return (
                  <CheckboxPrimitive.Root
                    key={option}
                    checked={isSelected}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onCheckedChange={() => onToggleValue(option)}
                    aria-label={`${label} ${option}`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary text-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground">
                      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
                        <Check className="h-4 w-4" />
                      </CheckboxPrimitive.Indicator>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{option}</span>
                  </CheckboxPrimitive.Root>
                );
              })
            ) : (
              <p className="px-3 py-4 text-sm text-muted-foreground">No values available.</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default MultiSelectFilterField;