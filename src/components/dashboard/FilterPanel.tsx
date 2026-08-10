import { useState } from "react";
import { Calendar, ChevronDown, Filter, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const statusOptions = [
  "00-Draft", "01-New", "02-Pre-Analysis", "03-In Analysis",
  "04-In Progress", "05-In Testing", "07-In Pre-Verification",
];

const FilterPanel = () => {
  const [expanded, setExpanded] = useState(true);
  const [selectedYear, setSelectedYear] = useState(["2026"]);
  const [selectedStatuses, setSelectedStatuses] = useState([
    "01-New", "03-In Analysis", "04-In Progress", "05-In Testing",
  ]);
  const [searchQuery, setSearchQuery] = useState("");

  const toggleStatus = (s: string) => {
    setSelectedStatuses((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  };

  return (
    <div className="dashboard-card">
      {/* Search bar */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索缺陷 ID 或名称..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 pl-10 bg-muted/50 border-0 focus-visible:ring-1"
          />
        </div>
        <Button size="sm" className="h-10 px-5">
          搜索
        </Button>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-secondary transition-colors"
        >
          <Filter className="h-4 w-4" />
          筛选
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Filter fields */}
      {expanded && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 p-5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {/* Year */}
          <FilterField label="年份">
            <div className="flex flex-wrap gap-1.5">
              {selectedYear.map((y) => (
                <Badge key={y} variant="secondary" className="gap-1 bg-primary/10 text-primary border-0">
                  {y}
                  <X className="h-3 w-3 cursor-pointer" onClick={() => setSelectedYear([])} />
                </Badge>
              ))}
            </div>
          </FilterField>

          {/* Project */}
          <FilterField label="项目">
            <SelectPlaceholder text="选择项目..." />
          </FilterField>

          {/* Date Range */}
          <FilterField label="日期范围">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              <span>开始日期</span>
              <span>→</span>
              <span>结束日期</span>
            </div>
          </FilterField>

          {/* AIDA */}
          <FilterField label="AIDA">
            <SelectPlaceholder text="选择 AIDA..." />
          </FilterField>

          {/* Status */}
          <FilterField label="状态" className="col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {statusOptions.map((s) => {
                const isSelected = selectedStatuses.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() => toggleStatus(s)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      isSelected
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground hover:bg-secondary"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </FilterField>

          {/* PU */}
          <FilterField label="PU">
            <SelectPlaceholder text="选择 PU..." />
          </FilterField>

          {/* Tester */}
          <FilterField label="测试人员">
            <SelectPlaceholder text="选择测试人员..." />
          </FilterField>

          {/* FV */}
          <FilterField label="FV (功能变体)">
            <SelectPlaceholder text="选择 FV..." />
          </FilterField>

          {/* ECU */}
          <FilterField label="ECU">
            <SelectPlaceholder text="选择 ECU..." />
          </FilterField>

          {/* Market */}
          <FilterField label="市场">
            <SelectPlaceholder text="选择市场..." />
          </FilterField>

          {/* Lead Model */}
          <FilterField label="主导车型">
            <SelectPlaceholder text="选择车型..." />
          </FilterField>
        </div>
      )}
    </div>
  );
};

const FilterField = ({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={className}>
    <p className="filter-label mb-1.5">{label}</p>
    {children}
  </div>
);

const SelectPlaceholder = ({ text }: { text: string }) => (
  <button className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-muted/30 px-3 text-sm text-muted-foreground hover:bg-secondary/50 transition-colors">
    <span>{text}</span>
    <ChevronDown className="h-3.5 w-3.5" />
  </button>
);

export default FilterPanel;
