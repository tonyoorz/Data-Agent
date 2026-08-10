# QGate KPI Dashboard Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a left-sidebar `QGate KPI Report` page that displays the latest generated `QGate KPI Dashboard` standalone HTML report without changing existing AI Chat, Main Dashboard, or QGate report generation behavior.

**Architecture:** Keep the existing Python-generated report as the source of truth. Add two read-only Node endpoints for latest-report discovery and safe HTML serving, then render the HTML in an iframe from a small React page registered in the existing dashboard shell.

**Tech Stack:** Node `http` server with `fs/path`, React 18, Vite, Tailwind utility classes, Vitest.

---

## File Structure

- Create: `server/qgateReports.mjs`
  - Finds the latest dashboard HTML under `docs/qgate-reports/generated_runs/`.
  - Builds iframe metadata.
  - Safely resolves requested dashboard HTML files.
- Modify: `server/index.mjs`
  - Adds `GET /api/qgate-reports/latest-dashboard`.
  - Adds `GET /api/qgate-reports/dashboard-html?run=<run>&file=<file>`.
- Create: `src/components/dashboard/pages/QGateKpiReport.tsx`
  - Fetches latest report metadata.
  - Renders empty/error/loading states.
  - Renders an iframe when the report exists.
- Modify: `src/components/dashboard/DashboardSidebar.tsx`
  - Adds one sidebar item.
- Modify: `src/pages/Index.tsx`
  - Adds the page title and switch case.
- Create: `src/test/server/qgateReports.test.ts`
  - Tests latest report selection and path validation.
- Create: `src/test/qgate-report/QGateKpiReport.test.tsx`
  - Tests empty state and iframe rendering.

Do not add a generate endpoint. Do not integrate `2024 vs 2025 KPI Analysis`. Do not rewrite the report as React components.

---

### Task 1: Server Report Discovery

**Files:**
- Create: `server/qgateReports.mjs`
- Test: `src/test/server/qgateReports.test.ts`

- [ ] **Step 1: Write the server helper tests**

Create `src/test/server/qgateReports.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findLatestQGateDashboardReport,
  resolveQGateDashboardHtmlPath,
} from "../../../server/qgateReports.mjs";

describe("qgateReports", () => {
  it("finds the newest dashboard report and ignores compare html", () => {
    const root = join(process.cwd(), "tmp-qgate-report-test", String(Date.now()));
    const oldRun = join(root, "20260611_120000");
    const newRun = join(root, "20260612_090000");
    mkdirSync(oldRun, { recursive: true });
    mkdirSync(newRun, { recursive: true });
    writeFileSync(join(oldRun, "qgate_kpi_dashboard_20260611_120000.html"), "old", "utf8");
    writeFileSync(join(newRun, "qgate_kpi_compare_2025_2026_20260612_090000.html"), "compare", "utf8");
    writeFileSync(join(newRun, "qgate_kpi_dashboard_20260612_090000.html"), "new", "utf8");

    const report = findLatestQGateDashboardReport(root);

    expect(report).toMatchObject({
      available: true,
      run: "20260612_090000",
      fileName: "qgate_kpi_dashboard_20260612_090000.html",
      iframeUrl:
        "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
    });
  });

  it("returns unavailable when no dashboard report exists", () => {
    const root = join(process.cwd(), "tmp-qgate-report-empty", String(Date.now()));
    mkdirSync(root, { recursive: true });

    expect(findLatestQGateDashboardReport(root)).toEqual({
      available: false,
      message: "No QGate KPI Dashboard report has been generated yet.",
    });
  });

  it("rejects traversal and non-dashboard html names", () => {
    const root = join(process.cwd(), "tmp-qgate-report-safe", String(Date.now()));
    const runDir = join(root, "20260612_090000");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "qgate_kpi_dashboard_20260612_090000.html"), "ok", "utf8");

    expect(() => resolveQGateDashboardHtmlPath(root, "..", "qgate_kpi_dashboard_x.html")).toThrow(
      "Invalid QGate report path",
    );
    expect(() =>
      resolveQGateDashboardHtmlPath(root, "20260612_090000", "qgate_kpi_compare_2025_2026.html"),
    ).toThrow("Invalid QGate dashboard file");
    expect(resolveQGateDashboardHtmlPath(root, "20260612_090000", "qgate_kpi_dashboard_20260612_090000.html")).toContain(
      "qgate_kpi_dashboard_20260612_090000.html",
    );
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
& 'C:\nvm4w\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run src/test/server/qgateReports.test.ts
```

Expected: fail because `server/qgateReports.mjs` does not exist.

- [ ] **Step 3: Implement the helper**

Create `server/qgateReports.mjs`:

```js
import fs from "node:fs";
import path from "node:path";

const DASHBOARD_FILE_RE = /^qgate_kpi_dashboard_.*\.html$/;
const RUN_DIR_RE = /^\d{8}_\d{6}$/;

export const defaultQGateReportsRoot = path.resolve(
  process.cwd(),
  "docs",
  "qgate-reports",
  "generated_runs",
);

export function findLatestQGateDashboardReport(root = defaultQGateReportsRoot) {
  if (!fs.existsSync(root)) {
    return unavailable();
  }

  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_DIR_RE.test(entry.name))
    .flatMap((entry) => {
      const runDir = path.join(root, entry.name);
      return fs
        .readdirSync(runDir, { withFileTypes: true })
        .filter((file) => file.isFile() && DASHBOARD_FILE_RE.test(file.name))
        .map((file) => {
          const filePath = path.join(runDir, file.name);
          return {
            run: entry.name,
            fileName: file.name,
            filePath,
            mtimeMs: fs.statSync(filePath).mtimeMs,
          };
        });
    })
    .sort((left, right) => right.run.localeCompare(left.run) || right.mtimeMs - left.mtimeMs);

  const latest = candidates[0];
  if (!latest) {
    return unavailable();
  }

  return {
    available: true,
    run: latest.run,
    fileName: latest.fileName,
    generatedAt: new Date(latest.mtimeMs).toISOString(),
    iframeUrl: `/api/qgate-reports/dashboard-html?run=${encodeURIComponent(latest.run)}&file=${encodeURIComponent(latest.fileName)}`,
  };
}

export function resolveQGateDashboardHtmlPath(root, run, fileName) {
  if (!RUN_DIR_RE.test(String(run || ""))) {
    throw new Error("Invalid QGate report path");
  }
  if (!DASHBOARD_FILE_RE.test(String(fileName || ""))) {
    throw new Error("Invalid QGate dashboard file");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, run, fileName);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Invalid QGate report path");
  }
  if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
    throw new Error("QGate dashboard file not found");
  }
  return resolvedFile;
}

function unavailable() {
  return {
    available: false,
    message: "No QGate KPI Dashboard report has been generated yet.",
  };
}
```

- [ ] **Step 4: Run the helper test**

Run:

```powershell
& 'C:\nvm4w\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run src/test/server/qgateReports.test.ts
```

Expected: pass.

---

### Task 2: Server Routes

**Files:**
- Modify: `server/index.mjs`
- Test: `src/test/server/qgateReports.test.ts`

- [ ] **Step 1: Wire the helper into the Node API**

In `server/index.mjs`, add this import near other local imports:

```js
import {
  defaultQGateReportsRoot,
  findLatestQGateDashboardReport,
  resolveQGateDashboardHtmlPath,
} from "./qgateReports.mjs";
```

Inside the request handler, after `/health` and before POST endpoints, add:

```js
    if (request.method === "GET" && url.pathname === "/api/qgate-reports/latest-dashboard") {
      sendJson(response, 200, findLatestQGateDashboardReport(defaultQGateReportsRoot));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qgate-reports/dashboard-html") {
      const filePath = resolveQGateDashboardHtmlPath(
        defaultQGateReportsRoot,
        url.searchParams.get("run"),
        url.searchParams.get("file"),
      );
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(fs.readFileSync(filePath));
      return;
    }
```

- [ ] **Step 2: Run a syntax check**

Run:

```powershell
& 'C:\nvm4w\nodejs\node.exe' --check .\server\index.mjs
```

Expected: no syntax errors.

---

### Task 3: Frontend Page and Registration

**Files:**
- Create: `src/components/dashboard/pages/QGateKpiReport.tsx`
- Modify: `src/components/dashboard/DashboardSidebar.tsx`
- Modify: `src/pages/Index.tsx`
- Test: `src/test/qgate-report/QGateKpiReport.test.tsx`

- [ ] **Step 1: Write the frontend tests**

Create `src/test/qgate-report/QGateKpiReport.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import QGateKpiReport from "@/components/dashboard/pages/QGateKpiReport";

describe("QGateKpiReport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an empty state when no dashboard report exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: false,
          message: "No QGate KPI Dashboard report has been generated yet.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<QGateKpiReport />);

    expect(await screen.findByText("No QGate KPI Dashboard report has been generated yet.")).toBeInTheDocument();
  });

  it("renders the latest dashboard report iframe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          run: "20260612_090000",
          fileName: "qgate_kpi_dashboard_20260612_090000.html",
          generatedAt: "2026-06-12T09:00:00.000Z",
          iframeUrl:
            "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<QGateKpiReport />);

    const frame = await screen.findByTitle("QGate KPI Dashboard report");
    expect(frame).toHaveAttribute(
      "src",
      "/api/qgate-reports/dashboard-html?run=20260612_090000&file=qgate_kpi_dashboard_20260612_090000.html",
    );
    expect(screen.getByText("20260612_090000")).toBeInTheDocument();
  });
});

describe("DashboardSidebar", () => {
  it("exposes QGate KPI Report navigation", () => {
    render(<DashboardSidebar active="main-dashboard" onNavigate={() => {}} />);

    expect(screen.getByText("QGate KPI Report")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the failing frontend test**

Run:

```powershell
& 'C:\nvm4w\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run src/test/qgate-report/QGateKpiReport.test.tsx
```

Expected: fail because the page does not exist.

- [ ] **Step 3: Add the page component**

Create `src/components/dashboard/pages/QGateKpiReport.tsx`:

```tsx
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

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

  const loadReport = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/qgate-reports/latest-dashboard");
      if (!response.ok) throw new Error("Failed to load QGate KPI Dashboard report metadata.");
      setReport((await response.json()) as LatestDashboardResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load QGate KPI Dashboard report metadata.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadReport();
  }, []);

  return (
    <section className="dashboard-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">QGate KPI Dashboard</h2>
          <p className="text-xs text-muted-foreground">
            {report?.available ? report.run : "Latest generated standalone report"}
          </p>
        </div>
        <button
          type="button"
          onClick={loadReport}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex min-h-[520px] items-center justify-center text-sm text-muted-foreground">Loading QGate KPI Dashboard...</div>
      ) : error ? (
        <div className="flex min-h-[520px] items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>
      ) : report?.available ? (
        <iframe
          title="QGate KPI Dashboard report"
          src={report.iframeUrl}
          className="h-[calc(100vh-170px)] min-h-[640px] w-full border-0 bg-white"
        />
      ) : (
        <div className="flex min-h-[520px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {report?.message || "No QGate KPI Dashboard report has been generated yet."}
        </div>
      )}
    </section>
  );
};

export default QGateKpiReport;
```

- [ ] **Step 4: Register the sidebar item**

In `src/components/dashboard/DashboardSidebar.tsx`, add `FileBarChart` to the lucide import and add one nav item before AI Chat:

```tsx
  FileBarChart,
```

```tsx
  { id: "qgate-kpi-report", label: "QGate KPI Report", icon: FileBarChart },
```

- [ ] **Step 5: Register the page**

In `src/pages/Index.tsx`, add the import:

```tsx
import QGateKpiReport from "@/components/dashboard/pages/QGateKpiReport";
```

Add the title entry:

```tsx
  "qgate-kpi-report": {
    title: "QGate KPI Report",
    subtitle: "QGate KPI Dashboard 迁移视图",
  },
```

Add the switch case before `ai-chat`:

```tsx
      case "qgate-kpi-report":
        return <QGateKpiReport />;
```

- [ ] **Step 6: Run the frontend test**

Run:

```powershell
& 'C:\nvm4w\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run src/test/qgate-report/QGateKpiReport.test.tsx
```

Expected: pass.

---

### Task 4: Focused Validation

**Files:**
- No new files unless a focused validation exposes a local defect.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
& 'C:\nvm4w\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run src/test/server/qgateReports.test.ts src/test/qgate-report/QGateKpiReport.test.tsx
```

Expected: pass.

- [ ] **Step 2: Run a Node syntax check**

Run:

```powershell
& 'C:\nvm4w\nodejs\node.exe' --check .\server\index.mjs
```

Expected: pass.

- [ ] **Step 3: Run broader build only if package metadata is valid**

Run:

```powershell
& 'C:\nvm4w\nodejs\npm.cmd' run build
```

Expected: pass. If this fails because `package.json` is invalid, repair only the JSON syntax and rerun this command.

---

## Deliberate Skips

- skipped: `2024 vs 2025 KPI Analysis`; add when the dashboard page is stable and the user asks for compare integration.
- skipped: `POST /api/qgate-reports/generate`; add when users need browser-triggered report generation.
- skipped: React/Recharts rewrite; add only if iframe isolation is not acceptable after real usage.