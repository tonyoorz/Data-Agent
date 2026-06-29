import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findLatestQGateDashboardReport,
  resolveQGateDashboardHtmlPath,
} from "../../../server/qgateReports.mjs";

const roots: string[] = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "vizion-qgate-report-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("qgateReports", () => {
  it("finds the newest dashboard report and ignores compare html", () => {
    const root = makeRoot();
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
    const root = makeRoot();

    expect(findLatestQGateDashboardReport(root)).toEqual({
      available: false,
      message: "No QGate KPI Dashboard report has been generated yet.",
    });
  });

  it("rejects traversal and non-dashboard html names", () => {
    const root = makeRoot();
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