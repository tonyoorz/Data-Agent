import { useEffect, useMemo, useState } from "react";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, ChevronDown, Search } from "lucide-react";
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
  triggerAriaLabel?: string;
  anyLabel?: string;
  noValuesLabel?: string;
  availableValuesLabel?: string;
  applyMode?: "instant" | "deferred";
  onApplyValues?: (values: string[]) => void;
  compact?: boolean;
};

function toggleSelectionValue(currentValues: string[], nextValue: string) {
  return currentValues.includes(nextValue)
    ? currentValues.filter((value) => value !== nextValue)
    : [...currentValues, nextValue];
}

function haveSameValues(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function getTriggerText(
  options: string[],
  selectedValues: string[],
  anyLabel: string,
  noValuesLabel: string,
) {
  if (selectedValues.length === 0) {
    return options.length === 0 ? noValuesLabel : anyLabel;
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
  triggerAriaLabel,
  anyLabel = "Any",
  noValuesLabel = "No values",
  availableValuesLabel = "available values",
  applyMode = "instant",
  onApplyValues,
  compact = false,
}: MultiSelectFilterFieldProps) => {
  const [open, setOpen] = useState(false);
  const [draftValues, setDraftValues] = useState<string[]>(selectedValues);
  const [searchText, setSearchText] = useState("");

  const isDeferred = applyMode === "deferred";
  const visibleOptions = useMemo(() => {
    const normalizedQuery = searchText.trim().toLowerCase();
    if (!normalizedQuery) {
      return options;
    }

    return options.filter((option) => option.toLowerCase().includes(normalizedQuery));
  }, [options, searchText]);

  useEffect(() => {
    if (!open) {
      setDraftValues(selectedValues);
      setSearchText("");
    }
  }, [open, selectedValues]);

  const triggerClassName = compact
    ? "workbench-filter-trigger h-9 rounded-lg px-2.5 text-[13px]"
    : "workbench-filter-trigger";

  const applyDraftValues = () => {
    if (haveSameValues(draftValues, selectedValues)) {
      setOpen(false);
      return;
    }

    onApplyValues?.(draftValues);
    setOpen(false);
  };

  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      <p className="workbench-filter-label">{label}</p>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setDraftValues(selectedValues);
            setSearchText("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={triggerClassName}
            aria-label={triggerAriaLabel ?? `${label} filter`}
          >
            <span className="min-w-0 flex-1 truncate">
              {getTriggerText(options, selectedValues, anyLabel, noValuesLabel)}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{selectedValues.length || options.length}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[280px] rounded-xl border-border/80 p-0">
          <div className="border-b border-border/70 px-4 py-3">
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">{options.length} {availableValuesLabel}</p>
          </div>
          {isDeferred ? (
            <div className="border-b border-border/70 px-3 py-2.5">
              <label className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 py-2">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder={`搜索${label}`}
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>
          ) : null}
          <div className="max-h-56 space-y-1 overflow-y-auto p-2">
            {visibleOptions.length > 0 ? (
              visibleOptions.map((option) => {
                const isSelected = (isDeferred ? draftValues : selectedValues).includes(option);

                return (
                  <CheckboxPrimitive.Root
                    key={option}
                    checked={isSelected}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onCheckedChange={() => {
                      if (isDeferred) {
                        setDraftValues((current) => toggleSelectionValue(current, option));
                        return;
                      }

                      onToggleValue(option);
                    }}
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
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {options.length === 0 ? `${noValuesLabel}.` : "没有匹配结果。"}
              </p>
            )}
          </div>
          {isDeferred ? (
            <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setDraftValues([])}
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                清空
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-border/80 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={applyDraftValues}
                  className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                >
                  应用筛选
                </button>
              </div>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default MultiSelectFilterField;