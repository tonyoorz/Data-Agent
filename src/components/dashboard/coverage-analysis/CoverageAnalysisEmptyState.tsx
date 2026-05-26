import { AlertTriangle, Database } from "lucide-react";

type CoverageAnalysisEmptyStateProps = {
  title: string;
  description: string;
  missingFields?: string[];
};

const CoverageAnalysisEmptyState = ({
  title,
  description,
  missingFields = [],
}: CoverageAnalysisEmptyStateProps) => {
  const hasMissingFields = missingFields.length > 0;

  return (
    <section className="dashboard-card p-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-dashed border-border/80 bg-muted/20 p-6 sm:flex-row sm:items-start">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-background text-primary shadow-sm">
          {hasMissingFields ? <AlertTriangle className="h-6 w-6" /> : <Database className="h-6 w-6" />}
        </div>
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          {hasMissingFields ? (
            <p className="text-sm font-medium text-foreground">
              Missing fields: {missingFields.join(", ")}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default CoverageAnalysisEmptyState;