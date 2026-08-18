import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type RunSummary = {
  runRef: string;
  intent: string;
  outcome: string;
  evidenceStatus: string;
  citationValidation: string;
  toolNames: string[];
  latencyMs?: number;
  tokenUsage?: TokenUsage;
};

type OperationsSummary = {
  totalRuns: number;
  byOutcome: Record<string, number>;
  byEvidenceStatus: Record<string, number>;
  latency: { p50Ms: number | null; p95Ms: number | null };
  tokenUsage?: TokenUsage | null;
  citationValidation: Record<string, number>;
  topFailureCodes: Array<{ code: string; count: number }>;
  recoveryOutcomes: Record<string, number>;
  runs: RunSummary[];
};

type RunDetail = {
  run: RunSummary;
  timeline: Array<Record<string, unknown>>;
};

function displayCount(value: number | undefined) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function displayLatency(value: number | null | undefined) {
  return value == null ? "-" : `${Math.round(value)} ms`;
}

function displayTokens(value: number | null | undefined) {
  return value == null ? "-" : displayCount(value);
}

async function operationsFetch(path: string) {
  let token = "";
  try {
    const session = await supabase.auth.getSession();
    token = typeof session.data?.session?.access_token === "string" ? session.data.session.access_token.trim() : "";
  } catch {
    token = "";
  }
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(String(payload?.error || "AGENT_OPERATIONS_UNAVAILABLE")), { code: payload?.error });
  }
  return payload;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-background px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

const AgentOperations = () => {
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState("");

  const loadSummary = async () => {
    setLoading(true);
    setErrorCode("");
    try {
      const next = await operationsFetch("/api/agent-operations/summary") as OperationsSummary;
      setSummary(next);
    } catch (error) {
      setSummary(null);
      setDetail(null);
      setErrorCode(String((error as { code?: string })?.code || "AGENT_OPERATIONS_UNAVAILABLE"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSummary();
  }, []);

  const loadRun = async (runId: string) => {
    try {
      const next = await operationsFetch(`/api/agent-operations/runs/${encodeURIComponent(runId)}`) as RunDetail;
      setDetail(next);
    } catch (error) {
      setErrorCode(String((error as { code?: string })?.code || "AGENT_OPERATIONS_UNAVAILABLE"));
    }
  };

  if (loading) {
    return (
      <section className="dashboard-card flex min-h-40 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading operations
      </section>
    );
  }

  if (errorCode) {
    const denied = errorCode === "AGENT_OPERATIONS_ACCESS_DENIED";
    return (
      <Alert variant="destructive">
        {denied ? <ShieldAlert className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        <AlertTitle>{denied ? "Access denied" : "Operations unavailable"}</AlertTitle>
        <AlertDescription>
          {denied ? "This view requires the agent.operations.read policy." : "The operations summary could not be loaded."}
        </AlertDescription>
      </Alert>
    );
  }

  if (!summary) return null;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Agent Operations</h2>
          <p className="text-xs text-muted-foreground">Sanitized runtime outcomes and recovery signals</p>
        </div>
        <Button type="button" variant="outline" size="icon" onClick={() => void loadSummary()} title="Refresh operations" aria-label="Refresh operations">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </section>

      <section className="grid gap-px border border-border bg-border sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Runs" value={displayCount(summary.totalRuns)} />
        <Metric label="Completed" value={displayCount(summary.byOutcome.completed)} />
        <Metric label="Denied" value={displayCount(summary.byOutcome.denied)} />
        <Metric label="P50 latency" value={displayLatency(summary.latency.p50Ms)} />
        <Metric label="P95 latency" value={displayLatency(summary.latency.p95Ms)} />
        <Metric label="Tokens" value={displayTokens(summary.tokenUsage?.totalTokens)} />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="dashboard-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">Recent runs</h3>
            <span className="text-xs text-muted-foreground">Evidence pass {displayCount(summary.byEvidenceStatus.pass)}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-border bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Run</th>
                  <th className="px-4 py-2 font-medium">Intent</th>
                  <th className="px-4 py-2 font-medium">Outcome</th>
                  <th className="px-4 py-2 font-medium">Evidence</th>
                  <th className="px-4 py-2 font-medium">Citation</th>
                  <th className="px-4 py-2 font-medium">Tools</th>
                </tr>
              </thead>
              <tbody>
                {summary.runs.map((run) => (
                  <tr key={run.runRef} className="border-b border-border/70 last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <button type="button" className="font-mono text-primary hover:underline" onClick={() => void loadRun(run.runRef)}>{run.runRef}</button>
                    </td>
                    <td className="px-4 py-2">{run.intent}</td>
                    <td className="px-4 py-2">{run.outcome}</td>
                    <td className="px-4 py-2">{run.evidenceStatus}</td>
                    <td className="px-4 py-2">{run.citationValidation}</td>
                    <td className="px-4 py-2">{run.toolNames.join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dashboard-card p-4">
          <h3 className="text-sm font-semibold text-foreground">Signals</h3>
          <dl className="mt-4 space-y-3 text-xs">
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Citation pass</dt><dd className="font-medium">{displayCount(summary.citationValidation.pass)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Citation blocked</dt><dd className="font-medium">{displayCount(summary.citationValidation.blocked)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Recovered</dt><dd className="font-medium">{displayCount(summary.recoveryOutcomes.recovered)}</dd></div>
          </dl>
          <div className="mt-5 border-t border-border pt-4">
            <h4 className="text-xs font-semibold text-foreground">Failure codes</h4>
            <ul className="mt-2 space-y-2 text-xs">
              {summary.topFailureCodes.length ? summary.topFailureCodes.map((item) => (
                <li key={item.code} className="flex items-center justify-between gap-3"><span className="font-mono text-muted-foreground">{item.code}</span><span>{item.count}</span></li>
              )) : <li className="text-muted-foreground">None</li>}
            </ul>
          </div>
        </section>
      </div>

      {detail ? (
        <section className="dashboard-card p-4">
          <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /><h3 className="text-sm font-semibold text-foreground">Run timeline: {detail.run.runRef}</h3></div>
          <pre className="mt-3 max-h-64 overflow-auto bg-muted/40 p-3 text-xs text-muted-foreground">{JSON.stringify(detail.timeline, null, 2)}</pre>
        </section>
      ) : null}
    </div>
  );
};

export default AgentOperations;