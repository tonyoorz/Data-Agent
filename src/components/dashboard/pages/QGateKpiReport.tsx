import { useCallback, useEffect, useState } from "react";

type LatestDashboardResponse =
  | {
      available: true;
      run: string;
      fileName: string;
      generatedAt?: string;
      iframeUrl: string;
    }
  | {
      available: false;
      message: string;
    };

const QGateKpiReport = () => {
  const [report, setReport] = useState<LatestDashboardResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/qgate-reports/latest-dashboard");
      if (!response.ok) {
        throw new Error("Failed to load QGate KPI Dashboard report metadata.");
      }
      setReport((await response.json()) as LatestDashboardResponse);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load QGate KPI Dashboard report metadata.",
      );
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  return (
    <section className="-m-6 h-[calc(100vh-65px)] overflow-hidden bg-white">
      {loading ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading QGate KPI Dashboard...
        </div>
      ) : error ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
          {error}
        </div>
      ) : report?.available ? (
        <iframe
          title="QGate KPI Dashboard report"
          src={report.iframeUrl}
          className="h-full w-full border-0 bg-white"
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {report?.message || "No QGate KPI Dashboard report has been generated yet."}
        </div>
      )}
    </section>
  );
};

export default QGateKpiReport;