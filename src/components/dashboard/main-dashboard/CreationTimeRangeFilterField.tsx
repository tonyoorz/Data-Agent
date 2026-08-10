import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type CreationTimeRangeFilterFieldProps = {
  startDate: string;
  endDate: string;
  onApply: (startDate: string, endDate: string) => void;
};

const CreationTimeRangeFilterField = ({
  startDate,
  endDate,
  onApply,
}: CreationTimeRangeFilterFieldProps) => {
  const [open, setOpen] = useState(false);
  const [draftStartDate, setDraftStartDate] = useState(startDate);
  const [draftEndDate, setDraftEndDate] = useState(endDate);

  useEffect(() => {
    if (!open) {
      setDraftStartDate(startDate);
      setDraftEndDate(endDate);
    }
  }, [startDate, endDate, open]);

  const triggerText = startDate && endDate
    ? `${startDate} to ${endDate}`
    : startDate
      ? `From ${startDate}`
      : endDate
        ? `Until ${endDate}`
        : "Any";
  const hasDraftChanges = draftStartDate !== startDate || draftEndDate !== endDate;

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setDraftStartDate(startDate);
      setDraftEndDate(endDate);
    }
    setOpen(nextOpen);
  };

  const handleApply = () => {
    onApply(draftStartDate, draftEndDate);
    setOpen(false);
  };

  return (
    <div className="space-y-1.5">
      <p className="workbench-filter-label">Creation Time</p>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="workbench-filter-trigger"
            aria-label="Creation Time filter"
          >
            <span className="min-w-0 flex-1 truncate">{triggerText}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{startDate || endDate ? 1 : 0}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[320px] rounded-xl border-border/80 p-4">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Creation Time</p>
              <p className="text-xs text-muted-foreground">Choose a start and end date.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm text-foreground">
                <span>Start</span>
                <Input
                  type="date"
                  aria-label="Creation Time start"
                  value={draftStartDate}
                  onChange={(event) => setDraftStartDate(event.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm text-foreground">
                <span>End</span>
                <Input
                  type="date"
                  aria-label="Creation Time end"
                  value={draftEndDate}
                  onChange={(event) => setDraftEndDate(event.target.value)}
                />
              </label>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={handleApply}
                disabled={!hasDraftChanges}
                aria-label="Apply Creation Time filter"
              >
                Apply
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default CreationTimeRangeFilterField;