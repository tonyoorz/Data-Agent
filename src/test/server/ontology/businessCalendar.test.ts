// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  QGATE_SEQUENCE,
  fiscalQuarters,
  fiscalYearOf,
  qgateWindow,
  resolveBusinessTime,
  resolveTestWeek,
  sameBusinessWindowLastYear,
  testWeekRange,
} from "../../../../server/ontology/businessCalendar.mjs";

const anchorAt = "2026-08-15T04:00:00.000Z"; // 2026-08-15 12:00 Asia/Shanghai (Saturday)
const sopAt = "2026-07-01"; // nominal SOP anchor for Q-Gate windows

function nextDay(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

describe("businessCalendar fiscal year", () => {
  it("defaults to calendar-aligned fiscal years", () => {
    expect(fiscalYearOf("2026-08-15")).toEqual({
      fiscalYear: 2026,
      startMonth: 1,
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });

  it("honours a non-January fiscal start at both boundaries", () => {
    expect(fiscalYearOf("2026-03-31", { startMonth: 4 }).fiscalYear).toBe(2025);
    const aprilFy = fiscalYearOf("2026-04-01", { startMonth: 4 });
    expect(aprilFy).toMatchObject({ fiscalYear: 2026, start: "2026-04-01", end: "2027-03-31" });
  });

  it("rejects invalid fiscal start months", () => {
    expect(() => fiscalYearOf("2026-08-15", { startMonth: 13 })).toThrow("BUSINESS_FISCAL_START_MONTH_INVALID");
  });
});

describe("businessCalendar fiscal quarters", () => {
  it("splits the calendar fiscal year into four quarters", () => {
    const result = fiscalQuarters("2026-08-15");
    expect(result).toMatchObject({ fiscalYear: 2026, currentQuarter: 3 });
    expect(result.quarters).toEqual([
      { quarter: 1, label: "FY2026-Q1", start: "2026-01-01", end: "2026-03-31" },
      { quarter: 2, label: "FY2026-Q2", start: "2026-04-01", end: "2026-06-30" },
      { quarter: 3, label: "FY2026-Q3", start: "2026-07-01", end: "2026-09-30" },
      { quarter: 4, label: "FY2026-Q4", start: "2026-10-01", end: "2026-12-31" },
    ]);
  });

  it("keeps quarter numbering fiscal-relative for an April fiscal year", () => {
    const result = fiscalQuarters("2026-08-15", { startMonth: 4 });
    expect(result).toMatchObject({ fiscalYear: 2026, currentQuarter: 2 });
    expect(result.quarters[0]).toEqual({ quarter: 1, label: "FY2026-Q1", start: "2026-04-01", end: "2026-06-30" });
    expect(result.quarters[3]).toEqual({ quarter: 4, label: "FY2026-Q4", start: "2027-01-01", end: "2027-03-31" });
  });
});

describe("businessCalendar test weeks (ISO Monday weeks)", () => {
  it("resolves the anchor's test week with an ISO label", () => {
    expect(resolveTestWeek(anchorAt)).toEqual({ label: "2026-W33", start: "2026-08-10", end: "2026-08-16" });
  });

  it("assigns early-January dates to the previous ISO year's last week", () => {
    expect(resolveTestWeek("2027-01-02T02:00:00.000Z")).toEqual({ label: "2026-W53", start: "2026-12-28", end: "2027-01-03" });
  });

  it("starts ISO week 1 in the previous calendar year when needed", () => {
    expect(resolveTestWeek("2026-01-01T10:00:00.000Z")).toEqual({ label: "2026-W01", start: "2025-12-29", end: "2026-01-04" });
  });

  it("expands an explicit test week label", () => {
    expect(testWeekRange("2026-W33")).toEqual({ label: "2026-W33", start: "2026-08-10", end: "2026-08-16" });
    expect(testWeekRange("2026-W01")).toEqual({ label: "2026-W01", start: "2025-12-29", end: "2026-01-04" });
    expect(testWeekRange("2025-W52")).toEqual({ label: "2025-W52", start: "2025-12-22", end: "2025-12-28" });
  });

  it("rejects week labels that do not exist in the given ISO year", () => {
    expect(() => testWeekRange("2025-W53")).toThrow("BUSINESS_TEST_WEEK_OUT_OF_RANGE");
    expect(() => testWeekRange("week 33")).toThrow("BUSINESS_TEST_WEEK_LABEL_INVALID");
  });

  it("round-trips resolveTestWeek through testWeekRange", () => {
    for (const probe of ["2026-08-15T04:00:00.000Z", "2027-01-02T02:00:00.000Z", "2026-01-01T10:00:00.000Z"]) {
      const resolved = resolveTestWeek(probe);
      expect(testWeekRange(resolved.label)).toEqual(resolved);
    }
  });
});

describe("businessCalendar Q-Gate windows", () => {
  it("maps a gate to its nominal pre-SOP window", () => {
    expect(qgateWindow("QG5", sopAt)).toMatchObject({ gateName: "QG5", order: 5, start: "2025-11-01", end: "2026-01-31" });
    expect(qgateWindow("G8", sopAt)).toMatchObject({ start: "2026-07-01", end: "2026-07-31" });
  });

  it("normalizes Chinese and English gate spellings to the same window", () => {
    expect(qgateWindow("Q-Gate 5", sopAt)).toEqual(qgateWindow("质量门 G5", sopAt));
    expect(qgateWindow("QG5", sopAt)).toEqual(qgateWindow("G5", sopAt));
  });

  it("returns null for unknown gates and cites its source", () => {
    expect(qgateWindow("QG9", sopAt)).toBeNull();
    expect(qgateWindow("", sopAt)).toBeNull();
    expect(qgateWindow("QG0", sopAt).source).toContain("quality.qgate");
  });

  it("tiles the pre-SOP cadence contiguously in gate order", () => {
    expect(QGATE_SEQUENCE).toHaveLength(9);
    for (let order = 0; order < 8; order += 1) {
      const current = qgateWindow(`QG${order}`, sopAt);
      const next = qgateWindow(`QG${order + 1}`, sopAt);
      expect(current.order).toBeLessThan(next.order);
      expect(nextDay(current.end)).toBe(next.start);
    }
  });
});

describe("businessCalendar same window last year", () => {
  it("shifts plain windows by one calendar year", () => {
    expect(sameBusinessWindowLastYear({ start: "2026-08-10", end: "2026-08-16" })).toEqual({ start: "2025-08-10", end: "2025-08-16" });
  });

  it("collapses Feb 29 to Feb 28 in non-leap years", () => {
    expect(sameBusinessWindowLastYear({ start: "2024-02-29", end: "2024-03-05" })).toEqual({ start: "2023-02-28", end: "2023-03-05" });
  });

  it("snaps to whole fiscal quarters when alignToFiscal is set", () => {
    expect(sameBusinessWindowLastYear({ start: "2026-08-10", end: "2026-08-16" }, { alignToFiscal: true })).toEqual({ start: "2025-07-01", end: "2025-09-30" });
    expect(sameBusinessWindowLastYear({ start: "2026-07-01", end: "2026-09-30" }, { alignToFiscal: true, startMonth: 4 })).toEqual({ start: "2025-07-01", end: "2025-09-30" });
  });
});

describe("businessCalendar resolveBusinessTime", () => {
  it("resolves Chinese test-week wording with an explicit year", () => {
    expect(resolveBusinessTime("2026年第33周测试缺陷趋势", { anchorAt })).toMatchObject({
      businessKind: "test_week",
      label: "2026-W33",
      start: "2026-08-10",
      end: "2026-08-16",
      timezone: "Asia/Shanghai",
    });
  });

  it("resolves the current test week from bare 测试周 wording", () => {
    expect(resolveBusinessTime("本周测试周缺陷趋势", { anchorAt })).toMatchObject({ businessKind: "test_week", label: "2026-W33" });
  });

  it("resolves Chinese Q-Gate wording against the SOP anchor", () => {
    expect(resolveBusinessTime("质量门G5的缺陷密度如何", { anchorAt, sopAt })).toMatchObject({
      businessKind: "qgate_window",
      label: "QG5",
      start: "2025-11-01",
      end: "2026-01-31",
    });
  });

  it("resolves Chinese quarter wording including previous quarter", () => {
    expect(resolveBusinessTime("第3季度新增缺陷", { anchorAt })).toMatchObject({ businessKind: "fiscal_quarter", start: "2026-07-01", end: "2026-09-30", label: "FY2026-Q3" });
    expect(resolveBusinessTime("上季度缺陷对比", { anchorAt })).toMatchObject({ businessKind: "fiscal_quarter", start: "2026-04-01", end: "2026-06-30", label: "FY2026-Q2" });
  });

  it("resolves Chinese fiscal-year wording", () => {
    expect(resolveBusinessTime("财年2025缺陷总数", { anchorAt })).toMatchObject({ businessKind: "fiscal_year", label: "FY2025", start: "2025-01-01", end: "2025-12-31" });
    expect(resolveBusinessTime("本财年缺陷总数", { anchorAt })).toMatchObject({ businessKind: "fiscal_year", label: "FY2026" });
  });

  it("resolves Chinese YoY wording to the same fiscal window last year", () => {
    expect(resolveBusinessTime("去年同期缺陷同比怎么样", { anchorAt })).toEqual({
      timezone: "Asia/Shanghai",
      anchorAt,
      businessKind: "yoy_same_period",
      label: "去年同期",
      start: "2025-01-01",
      end: "2025-08-15",
      reference: { start: "2026-01-01", end: "2026-08-15" },
    });
  });

  it("resolves English trigger wording", () => {
    expect(resolveBusinessTime("defects in test week 33", { anchorAt })).toMatchObject({ businessKind: "test_week", label: "2026-W33" });
    expect(resolveBusinessTime("W33 defect summary", { anchorAt })).toMatchObject({ businessKind: "test_week", start: "2026-08-10" });
    expect(resolveBusinessTime("FY2025 overview", { anchorAt })).toMatchObject({ businessKind: "fiscal_year", start: "2025-01-01", end: "2025-12-31" });
    expect(resolveBusinessTime("defect trend for Q3 2026", { anchorAt })).toMatchObject({ businessKind: "fiscal_quarter", start: "2026-07-01", end: "2026-09-30" });
    expect(resolveBusinessTime("year over year comparison", { anchorAt })).toMatchObject({ businessKind: "yoy_same_period", start: "2025-01-01" });
    expect(resolveBusinessTime("Q-Gate 5 status", { anchorAt, sopAt })).toMatchObject({ businessKind: "qgate_window", label: "QG5" });
  });

  it("returns null for non-business time wording", () => {
    expect(resolveBusinessTime("最近7天新增缺陷", { anchorAt })).toBeNull();
    expect(resolveBusinessTime("查一下张三的权限配置", { anchorAt })).toBeNull();
    expect(resolveBusinessTime("", { anchorAt })).toBeNull();
    expect(resolveBusinessTime(null, { anchorAt })).toBeNull();
  });

  it("keeps scope fields compatible with timeResolver shape", () => {
    const scope = resolveBusinessTime("2026年第33周测试缺陷", { anchorAt });
    expect(Object.keys(scope)).toEqual(expect.arrayContaining(["start", "end", "timezone", "businessKind"]));
    expect(scope.timezone).toBe("Asia/Shanghai");
    expect(scope.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
