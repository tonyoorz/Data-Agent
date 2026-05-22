import { cn } from "@/lib/utils";

import type {
  MainDashboardOutcomeKey,
  MainDashboardOutcomeSummaryRow,
} from "./mainDashboardTypes";

type OutcomePanelProps = {
  outcomeSummary: MainDashboardOutcomeSummaryRow[];
  selectedOutcomeKey?: MainDashboardOutcomeKey | null;
  onToggleOutcome: (outcomeKey: MainDashboardOutcomeKey) => void;
};

function getBarClassName(outcomeKey: MainDashboardOutcomeKey) {
  return outcomeKey === "resolvedForward" ? "bg-success" : "bg-destructive";
}

const OutcomePanel = ({
  outcomeSummary,
  selectedOutcomeKey,
  onToggleOutcome,
}: OutcomePanelProps) => {
  return (
    <section className="workbench-panel p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">Solution Outcome</h2>
      </div>

      {outcomeSummary.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border/80 bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          No outcome data is available in the current filtered scope.
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {outcomeSummary.map((row) => {
            const isActive = selectedOutcomeKey === row.key;

            return (
              <button
                key={row.key}
                type="button"
                aria-label={row.label}
                aria-pressed={isActive}
                className={cn(
                  "w-full border-b px-0 py-3 text-left transition-colors last:border-b-0",
                  isActive
                    ? "border-primary/60"
                    : "border-border/60 hover:border-primary/30",
                )}
                onClick={() => onToggleOutcome(row.key)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">{row.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.count} of {row.denominator} tickets in scope
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-semibold tracking-tight text-foreground">
                      {row.percent}%
                    </p>
                    <p className="text-xs text-muted-foreground">{row.count} tickets</p>
                  </div>
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    <span>0%</span>
                    <span>100%</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted/60">
                  <div
                    className={cn("h-full rounded-full", getBarClassName(row.key))}
                    style={{ width: `${Math.min(row.percent, 100)}%` }}
                  />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default OutcomePanel;