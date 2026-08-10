import { BarChart3, GitPullRequestArrow, ShieldX, Users } from "lucide-react";

import type { MainDashboardOverview } from "./mainDashboardTypes";

const numberFormatter = new Intl.NumberFormat("en-US");

type MainDashboardKpisProps = {
  overview: MainDashboardOverview;
  teamCount: number;
  aidaCount: number;
  solutionClusterCount: number;
};

const MainDashboardKpis = ({
  overview,
  teamCount,
  aidaCount,
  solutionClusterCount,
}: MainDashboardKpisProps) => {
  const cards = [
    {
      label: "Tickets in scope",
      value: numberFormatter.format(overview.ticketCount),
      meta: `${overview.ticketCount === 1 ? "ticket" : "tickets"} after search and filters`,
      icon: BarChart3,
      iconClassName: "bg-primary/10 text-primary",
    },
    {
      label: "AIDA",
      value: numberFormatter.format(aidaCount),
      meta: `${aidaCount === 1 ? "value" : "values"} available in the current filter scope`,
      icon: GitPullRequestArrow,
      iconClassName: "bg-success/10 text-success",
    },
    {
      label: "Solution Cluster",
      value: numberFormatter.format(solutionClusterCount),
      meta: `${solutionClusterCount === 1 ? "value" : "values"} available in the current filter scope`,
      icon: ShieldX,
      iconClassName: "bg-destructive/10 text-destructive",
    },
    {
      label: "Teams in scope",
      value: numberFormatter.format(teamCount),
      meta: `${teamCount === 1 ? "team" : "teams"} represented in the current table scope`,
      icon: Users,
      iconClassName: "bg-warning/10 text-warning",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;

        return (
          <div
            key={card.label}
            className="workbench-kpi-card"
            role="article"
            aria-label={card.label}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="kpi-label">{card.label}</p>
                <p className="kpi-value">{card.value}</p>
              </div>
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-2xl ${card.iconClassName}`}
              >
                <Icon className="h-5 w-5" />
              </span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{card.meta}</p>
          </div>
        );
      })}
    </div>
  );
};

export default MainDashboardKpis;