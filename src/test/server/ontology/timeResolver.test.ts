// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveTimeScopes } from "../../../../server/ontology/timeResolver.mjs";

const anchorAt = "2026-07-15T04:00:00.000Z";
const fieldId = "time.defect_creation_date";

describe("Ontology time resolver", () => {
  it("anchors recent windows to inclusive Asia/Shanghai calendar dates", () => {
    const result = resolveTimeScopes({ query: "最近一周新增缺陷", fieldId, anchorAt });
    expect(result.timeScopes).toEqual([
      {
        role: "primary",
        fieldId,
        start: "2026-07-09",
        end: "2026-07-15",
        timezone: "Asia/Shanghai",
        relativeText: "最近一周",
        anchorAt,
      },
    ]);
  });

  it("defaults bare recent wording to the latest seven calendar days", () => {
    const recentAnchor = "2026-08-06T07:00:00.000Z";
    const result = resolveTimeScopes({ query: "最近出现的严重缺陷", fieldId, anchorAt: recentAnchor });

    expect(result.timeScopes).toEqual([
      {
        role: "primary",
        fieldId,
        start: "2026-07-31",
        end: "2026-08-06",
        timezone: "Asia/Shanghai",
        relativeText: "最近7天",
        anchorAt: recentAnchor,
      },
    ]);
    expect(result.assumptions).toEqual(["RECENT_DEFAULTS_TO_LAST_7_DAYS"]);
  });

  it("resolves previous calendar week and month without model-generated dates", () => {
    expect(resolveTimeScopes({ query: "上周缺陷", fieldId, anchorAt }).timeScopes[0]).toMatchObject({ start: "2026-07-06", end: "2026-07-12" });
    expect(resolveTimeScopes({ query: "上月缺陷", fieldId, anchorAt }).timeScopes[0]).toMatchObject({ start: "2026-06-01", end: "2026-06-30" });
  });

  it("resolves recent calendar months before explicit-month matching", () => {
    expect(resolveTimeScopes({ query: "最近三个月新增缺陷趋势", fieldId, anchorAt }).timeScopes[0]).toMatchObject({
      start: "2026-05-01",
      end: "2026-07-15",
      relativeText: "最近三个月",
    });
  });

  it("returns governed current-versus-previous week and month windows", () => {
    expect(resolveTimeScopes({ query: "本周比上周新增缺陷", fieldId, anchorAt }).timeScopes).toMatchObject([
      { role: "baseline", start: "2026-07-06", end: "2026-07-12" },
      { role: "comparison", start: "2026-07-13", end: "2026-07-15" },
    ]);
    expect(resolveTimeScopes({ query: "本月比上月新增缺陷", fieldId, anchorAt }).timeScopes).toMatchObject([
      { role: "baseline", start: "2026-06-01", end: "2026-06-30" },
      { role: "comparison", start: "2026-07-01", end: "2026-07-15" },
    ]);
  });

  it("separates creation, resolution, and test-finished fields supplied by the governed metric", () => {
    const result = resolveTimeScopes({ query: "2026 年测试执行数", fieldId: "time.test_finished_date", anchorAt });
    expect(result.timeScopes[0]).toMatchObject({ fieldId: "time.test_finished_date", start: "2026-01-01", end: "2026-12-31" });
  });

  it("returns two explicit comparison periods", () => {
    const result = resolveTimeScopes({ query: "2025 vs 2026 缺陷数", fieldId, anchorAt });
    expect(result.timeScopes).toMatchObject([
      { role: "baseline", start: "2025-01-01", end: "2025-12-31" },
      { role: "comparison", start: "2026-01-01", end: "2026-12-31" },
    ]);
  });
});
