import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/utils";

import type {
  MainDashboardOutcomeKey,
  MainDashboardTeamOutcomeRow,
} from "./mainDashboardTypes";
import {
  createTeamExpansionChartData,
  type TeamExpansionChartRow,
} from "./teamExpansionChartData";

type TeamExpansionPanelProps = {
  teamOutcomeRows: MainDashboardTeamOutcomeRow[];
  selectedOutcomeKey?: MainDashboardOutcomeKey | null;
  selectedTeam?: string | null;
  onSelectTeamOutcome: (
    team: string,
    outcomeKey: MainDashboardOutcomeKey,
  ) => void;
};

const TEAM_OUTCOME_OPTIONS: Array<{
  key: MainDashboardOutcomeKey;
  label: string;
  color: string;
  legendClassName: string;
  getCount: (row: MainDashboardTeamOutcomeRow) => number;
  getPercent: (row: MainDashboardTeamOutcomeRow) => number;
}> = [
  {
    key: "resolvedForward",
    label: "Resolved Forward (08 -> 06)",
    color: "hsl(var(--success))",
    legendClassName: "bg-success",
    getCount: (row) => row.resolvedForwardCount,
    getPercent: (row) => row.resolvedForwardTeamPercent,
  },
  {
    key: "rejectedDirectly",
    label: "Rejected Directly (01 -> 09)",
    color: "hsl(var(--destructive))",
    legendClassName: "bg-destructive",
    getCount: (row) => row.rejectedDirectlyCount,
    getPercent: (row) => row.rejectedDirectlyTeamPercent,
  },
];

type TeamOutcomeBarShapeProps = {
  fill?: string;
  height?: number;
  payload?: TeamExpansionChartRow;
  width?: number;
  x?: number;
  y?: number;
};

function formatPercent(value: number) {
  const rounded = Number(value.toFixed(2));

  if (Number.isInteger(rounded)) {
    return `${rounded}%`;
  }

  return `${rounded}%`;
}

function formatTicketCount(value: number) {
  return value.toLocaleString();
}

function TeamOutcomeBarShape({
  fill,
  height = 0,
  payload,
  width = 0,
  x = 0,
  y = 0,
  outcomeKey,
  outcomeLabel,
  onSelectTeamOutcome,
  selectedOutcomeKey,
  selectedTeam,
}: TeamOutcomeBarShapeProps & {
  outcomeKey: MainDashboardOutcomeKey;
  outcomeLabel: string;
  onSelectTeamOutcome: (
    team: string,
    outcomeKey: MainDashboardOutcomeKey,
  ) => void;
  selectedOutcomeKey?: MainDashboardOutcomeKey | null;
  selectedTeam?: string | null;
}) {
  const team = payload?.team;
  const isSelected = selectedTeam === team && selectedOutcomeKey === outcomeKey;
  const isDisabled = !!selectedOutcomeKey && selectedOutcomeKey !== outcomeKey;
  const visibleHeight = height > 0 ? Math.max(height, 6) : 2;
  const adjustedY = y + height - visibleHeight;

  const handleSelect = () => {
    if (!team || isDisabled) {
      return;
    }

    onSelectTeamOutcome(team, outcomeKey);
  };

  return (
    <g>
      <rect
        x={x}
        y={adjustedY}
        width={width}
        height={visibleHeight}
        rx={6}
        ry={6}
        fill={fill}
        opacity={isDisabled ? 0.32 : 0.95}
        stroke={isSelected ? "hsl(var(--ring))" : "transparent"}
        strokeWidth={isSelected ? 2 : 0}
      />
      <g
        onClick={handleSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleSelect();
          }
        }}
        style={{ cursor: isDisabled ? "not-allowed" : "pointer" }}
      >
        <rect
          x={x - 4}
          y={Math.max(adjustedY - 24, 0)}
          width={width + 8}
          height={visibleHeight + 24}
          fill="transparent"
        />
      </g>
    </g>
  );
}

const TeamExpansionPanel = ({
  teamOutcomeRows,
  selectedOutcomeKey,
  selectedTeam,
  onSelectTeamOutcome,
}: TeamExpansionPanelProps) => {
  const { rows: chartData, maxTicketCount } = createTeamExpansionChartData(teamOutcomeRows);
  const chartWidth = Math.max(chartData.length * 132, 760);

  return (
    <section className="workbench-panel min-w-0 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Team Expansion</h2>
      </div>

      {teamOutcomeRows.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border/80 bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          No team data is available in the current filtered scope.
        </div>
      ) : (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            {TEAM_OUTCOME_OPTIONS.map((option) => (
              <span key={option.key} className="flex items-center gap-2">
                <span className={cn("h-2.5 w-2.5 rounded-full", option.legendClassName)} />
                {option.label}
              </span>
            ))}
          </div>

          <div className="mt-4 overflow-x-auto">
            <div className="relative" style={{ width: `${chartWidth}px` }}>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 z-10 grid w-full gap-6 px-[42px]"
                style={{ gridTemplateColumns: `repeat(${chartData.length}, minmax(0, 1fr))` }}
              >
                {chartData.map((row) => (
                  <div key={`${row.team}-labels`} className="grid grid-cols-2 gap-2 text-center text-[11px] font-semibold text-slate-600">
                    <span>{formatPercent(row.resolvedForwardPercent)}</span>
                    <span>{formatPercent(row.rejectedDirectlyPercent)}</span>
                  </div>
                ))}
              </div>
              <div data-testid="team-expansion-chart" className="w-full">
                <BarChart
                  width={chartWidth}
                  height={300}
                  data={chartData}
                  margin={{ top: 42, right: 8, left: 0, bottom: 12 }}
                  barGap={6}
                  barCategoryGap={24}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 90%)" vertical={false} />
                  <XAxis
                    dataKey="team"
                    angle={-16}
                    textAnchor="end"
                    interval={0}
                    height={64}
                    tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, Math.max(maxTicketCount, 1)]}
                    allowDecimals={false}
                    tickFormatter={(value) => formatTicketCount(Number(value))}
                    tick={{ fontSize: 11, fill: "hsl(220, 10%, 50%)" }}
                    axisLine={false}
                    tickLine={false}
                    width={42}
                  />
                  <Tooltip
                    cursor={false}
                    labelFormatter={(label, payload) => payload?.[0]?.payload?.team ?? label}
                    formatter={(value, _name, item) => {
                      const isResolved = item.dataKey === "resolvedForwardValue";
                      const count = isResolved
                        ? item.payload.resolvedForwardValue
                        : item.payload.rejectedDirectlyValue;
                      const percent = isResolved
                        ? item.payload.resolvedForwardPercent
                        : item.payload.rejectedDirectlyPercent;

                      return [
                        `${formatTicketCount(count)} tickets (${formatPercent(percent)})`,
                        isResolved
                          ? "Resolved Forward (08 -> 06)"
                          : "Rejected Directly (01 -> 09)",
                      ];
                    }}
                    contentStyle={{
                      borderRadius: 12,
                      border: "1px solid hsl(220, 16%, 90%)",
                      boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)",
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    dataKey="resolvedForwardValue"
                    fill={TEAM_OUTCOME_OPTIONS[0].color}
                    name={TEAM_OUTCOME_OPTIONS[0].label}
                    shape={(props) => (
                      <TeamOutcomeBarShape
                        {...props}
                        outcomeKey="resolvedForward"
                        outcomeLabel={TEAM_OUTCOME_OPTIONS[0].label}
                        onSelectTeamOutcome={onSelectTeamOutcome}
                        selectedOutcomeKey={selectedOutcomeKey}
                        selectedTeam={selectedTeam}
                      />
                    )}
                  />
                  <Bar
                    dataKey="rejectedDirectlyValue"
                    fill={TEAM_OUTCOME_OPTIONS[1].color}
                    name={TEAM_OUTCOME_OPTIONS[1].label}
                    shape={(props) => (
                      <TeamOutcomeBarShape
                        {...props}
                        outcomeKey="rejectedDirectly"
                        outcomeLabel={TEAM_OUTCOME_OPTIONS[1].label}
                        onSelectTeamOutcome={onSelectTeamOutcome}
                        selectedOutcomeKey={selectedOutcomeKey}
                        selectedTeam={selectedTeam}
                      />
                    )}
                  />
                </BarChart>
              </div>
            </div>
          </div>

          <div className="sr-only">
            {teamOutcomeRows.map((row) =>
              TEAM_OUTCOME_OPTIONS.map((option) => {
                const isDisabled =
                  !!selectedOutcomeKey && selectedOutcomeKey !== option.key;
                const isSelected =
                  selectedTeam === row.problemFinderTeam &&
                  selectedOutcomeKey === option.key;

                return (
                  <button
                    key={`${row.problemFinderTeam}-${option.key}`}
                    type="button"
                    aria-label={`${row.problemFinderTeam} ${option.label}`}
                    aria-pressed={isSelected}
                    aria-disabled={isDisabled}
                    disabled={isDisabled}
                    onClick={() =>
                      onSelectTeamOutcome(row.problemFinderTeam, option.key)
                    }
                  >
                    {row.problemFinderTeam} {option.label}
                  </button>
                );
              }),
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default TeamExpansionPanel;
