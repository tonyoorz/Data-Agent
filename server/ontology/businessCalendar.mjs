// Business calendar semantics for the automotive test-quality domain.
//
// Complements timeResolver.mjs (calendar-relative natural language) with the
// *business* time axis: ISO test weeks (Monday boundary, cross-year ISO rules),
// pre-SOP Q-Gate windows, fiscal year / fiscal quarters, and same-business-
// window-last-year (YoY) comparisons.
//
// Conventions (mirrored from timeResolver.mjs on purpose — that module only
// exports resolveTimeScopes, so helpers are duplicated to stay standalone):
//   - All windows are inclusive Asia/Shanghai calendar dates, "YYYY-MM-DD".
//   - Date math is done in UTC over Shanghai-shifted local parts.
//   - anchorAt accepts anything `new Date()` understands (ISO string / ms / Date).
//
// resolveBusinessTime(text, {anchorAt}) is the single entry point. It returns a
// scope shaped like timeResolver's ({start, end, timezone}) plus `businessKind`,
// or `null` when the text carries no business-time trigger (callers should then
// fall back to resolveTimeScopes).

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const CHINESE_NUMBERS = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

// ---------------------------------------------------------------------------
// Date helpers (UTC-day arithmetic only; see header note)
// ---------------------------------------------------------------------------

function parts(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function dateValue({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

function localDateParts(anchorAt) {
  const instant = new Date(anchorAt);
  if (Number.isNaN(instant.getTime())) throw new Error("SEMANTIC_TIME_ANCHOR_INVALID");
  return parts(new Date(instant.getTime() + SHANGHAI_OFFSET_MS));
}

function formatDate(value) {
  const { year, month, day } = value instanceof Date ? parts(value) : value;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function endOfMonthParts(year, month) {
  return parts(new Date(Date.UTC(year, month, 0)));
}

function monthShift({ year, month }, delta) {
  return parts(new Date(Date.UTC(year, month - 1 + delta, 1)));
}

function dayClampedToMonth({ year, month, day }) {
  const last = endOfMonthParts(year, month).day;
  return { year, month, day: Math.min(day, last) };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeStartMonth(opts) {
  const startMonth = opts?.startMonth ?? 1;
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new Error("BUSINESS_FISCAL_START_MONTH_INVALID");
  }
  return startMonth;
}

function toDateParts(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("BUSINESS_CALENDAR_DATE_INVALID");
    return parts(value);
  }
  if (typeof value === "number") return localDateParts(value);
  if (typeof value === "string") {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) return { year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3]) };
    return localDateParts(value);
  }
  if (value && Number.isInteger(value.year) && Number.isInteger(value.month) && Number.isInteger(value.day)) {
    return { year: value.year, month: value.month, day: value.day };
  }
  throw new Error("BUSINESS_CALENDAR_DATE_INVALID");
}

function parseCnNumber(value) {
  const raw = String(value);
  if (/^\d+$/.test(raw)) return Number(raw);
  let total = 0;
  let seen = false;
  for (const ch of raw) {
    if (ch === "十") {
      total = (total || 1) * 10;
      seen = true;
    } else if (Object.prototype.hasOwnProperty.call(CHINESE_NUMBERS, ch)) {
      total += CHINESE_NUMBERS[ch];
      seen = true;
    } else {
      return NaN;
    }
  }
  return seen ? total : NaN;
}

function singleYearHint(raw, fallback) {
  const years = [...new Set([...String(raw).matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])))];
  return years.length === 1 ? years[0] : fallback;
}

// ---------------------------------------------------------------------------
// Fiscal year / quarters
// ---------------------------------------------------------------------------

export function fiscalYearOf(date, opts = {}) {
  const startMonth = normalizeStartMonth(opts);
  const p = toDateParts(date);
  const fiscalYear = p.month >= startMonth ? p.year : p.year - 1;
  return {
    fiscalYear,
    startMonth,
    start: formatDate({ year: fiscalYear, month: startMonth, day: 1 }),
    end: formatDate(endOfMonthParts(fiscalYear + 1, startMonth - 1)),
  };
}

export function fiscalQuarters(date, opts = {}) {
  const startMonth = normalizeStartMonth(opts);
  const p = toDateParts(date);
  const { fiscalYear } = fiscalYearOf(p, { startMonth });
  const offsetMonths = (p.year - fiscalYear) * 12 + (p.month - startMonth);
  const currentQuarter = Math.floor(offsetMonths / 3) + 1;
  const quarters = [1, 2, 3, 4].map((quarter) => {
    const monthIndex = startMonth - 1 + (quarter - 1) * 3;
    return {
      quarter,
      label: `FY${fiscalYear}-Q${quarter}`,
      start: formatDate(parts(new Date(Date.UTC(fiscalYear, monthIndex, 1)))),
      end: formatDate(parts(new Date(Date.UTC(fiscalYear, monthIndex + 3, 0)))),
    };
  });
  return { fiscalYear, startMonth, currentQuarter, quarters };
}

// ---------------------------------------------------------------------------
// Test weeks — ISO 8601 Monday-start weeks, label "2026-W33".
// ISO cross-year rule: a week belongs to the ISO year holding its Thursday,
// so Jan 1-3 can belong to the previous year's last week (and Dec 29-31 to
// the next ISO year's W01).
// ---------------------------------------------------------------------------

function mondayOf(p) {
  const date = dateValue(p);
  const dow = date.getUTCDay() || 7;
  return parts(addDays(date, -(dow - 1)));
}

function isoWeekOf(mondayParts) {
  const thursday = addDays(dateValue(mondayParts), 3);
  const isoYear = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000) + 1;
  const week = Math.floor((dayOfYear - 1) / 7) + 1;
  return { isoYear, week };
}

export function resolveTestWeek(anchorAt) {
  const anchor = localDateParts(anchorAt);
  const monday = mondayOf(anchor);
  const { isoYear, week } = isoWeekOf(monday);
  return {
    label: `${isoYear}-W${pad2(week)}`,
    start: formatDate(monday),
    end: formatDate(addDays(dateValue(monday), 6)),
  };
}

export function testWeekRange(label) {
  const match = /^(\d{4})-[Ww](\d{1,2})$/.exec(String(label ?? "").trim());
  if (!match) throw new Error("BUSINESS_TEST_WEEK_LABEL_INVALID");
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) throw new Error("BUSINESS_TEST_WEEK_LABEL_INVALID");
  // ISO week 1 is the week containing January 4th.
  const monday = addDays(dateValue(mondayOf({ year, month: 1, day: 4 })), (week - 1) * 7);
  const iso = isoWeekOf(parts(monday));
  if (iso.isoYear !== year || iso.week !== week) throw new Error("BUSINESS_TEST_WEEK_OUT_OF_RANGE");
  return {
    label: `${year}-W${pad2(week)}`,
    start: formatDate(monday),
    end: formatDate(addDays(monday, 6)),
  };
}

// ---------------------------------------------------------------------------
// Q-Gate windows — nominal pre-SOP cadence.
//
// Source note: ontology/v1/entities.json `quality.qgate` (v1.0.0) exposes only
// qgate_id / pu_id / result — no ordered gate-stage property — so the sequence
// below is a module constant (nominal automotive pre-SOP Q-gate cadence tiling
// the 36 months before SOP). Revisit when the entity gains a gate-stage field.
// Windows are contiguous: QG(n) end + 1 day === QG(n+1) start, ending at SOP month.
// ---------------------------------------------------------------------------

const QGATE_SEQUENCE_SOURCE =
  "HARDCODED_NOMINAL_PRE_SOP_CADENCE_36M (quality.qgate entity v1.0.0 has no ordered gate property; pending ontology support)";

export const QGATE_SEQUENCE = Object.freeze([
  { gateName: "QG0", order: 0, zhLabel: "项目预选", endMonthsBeforeSop: 30, durationMonths: 6 },
  { gateName: "QG1", order: 1, zhLabel: "概念确认", endMonthsBeforeSop: 24, durationMonths: 6 },
  { gateName: "QG2", order: 2, zhLabel: "方案冻结", endMonthsBeforeSop: 18, durationMonths: 6 },
  { gateName: "QG3", order: 3, zhLabel: "供应商定点", endMonthsBeforeSop: 12, durationMonths: 6 },
  { gateName: "QG4", order: 4, zhLabel: "详细设计发布", endMonthsBeforeSop: 9, durationMonths: 3 },
  { gateName: "QG5", order: 5, zhLabel: "样车试制 OTS", endMonthsBeforeSop: 6, durationMonths: 3 },
  { gateName: "QG6", order: 6, zhLabel: "试生产", endMonthsBeforeSop: 3, durationMonths: 3 },
  { gateName: "QG7", order: 7, zhLabel: "量产准备", endMonthsBeforeSop: 1, durationMonths: 2 },
  { gateName: "QG8", order: 8, zhLabel: "SOP 评审", endMonthsBeforeSop: 0, durationMonths: 1 },
].map(Object.freeze));

function parseGateOrder(gateName) {
  const match = /(\d{1,2})\s*$/.exec(String(gateName ?? "").trim());
  return match ? Number(match[1]) : NaN;
}

/**
 * Nominal calendar window for a pre-SOP Q-Gate.
 * `anchorAt` is the SOP reference instant (start of production anchor).
 * Accepts gate spellings: "QG5", "G5", "Q-Gate 5", "质量门 G5".
 * Returns null for unknown gates; throws when anchorAt is missing/invalid.
 */
export function qgateWindow(gateName, anchorAt) {
  const order = parseGateOrder(gateName);
  const entry = Number.isInteger(order) ? QGATE_SEQUENCE.find((gate) => gate.order === order) : undefined;
  if (!entry) return null;
  if (anchorAt === undefined || anchorAt === null) throw new Error("BUSINESS_QGATE_SOP_ANCHOR_REQUIRED");
  const sop = toDateParts(anchorAt);
  const sopInstant =
    anchorAt instanceof Date ? anchorAt : typeof anchorAt === "object" ? dateValue(anchorAt) : new Date(anchorAt);
  const endMonth = monthShift(sop, -entry.endMonthsBeforeSop);
  const startMonth = monthShift(endMonth, -(entry.durationMonths - 1));
  return {
    gateName: entry.gateName,
    order: entry.order,
    zhLabel: entry.zhLabel,
    start: formatDate(startMonth),
    end: formatDate(endOfMonthParts(endMonth.year, endMonth.month)),
    sopAt: sopInstant.toISOString(),
    source: QGATE_SEQUENCE_SOURCE,
  };
}

// ---------------------------------------------------------------------------
// Same-business-window last year (YoY)
// ---------------------------------------------------------------------------

function quarterIndexWithinFiscalYear(p, fiscalYear, startMonth) {
  const index = Math.floor(((p.year - fiscalYear) * 12 + (p.month - startMonth)) / 3);
  return Math.max(0, Math.min(3, index));
}

/**
 * Shifts an inclusive window back one year.
 * - Default: same calendar dates last year; Feb 29 collapses to Feb 28.
 * - alignToFiscal: snap to the same fiscal quarter(s) of the previous fiscal
 *   year (whole-quarter windows), using opts.startMonth as the fiscal start.
 */
export function sameBusinessWindowLastYear(window, opts = {}) {
  const startP = toDateParts(window?.start);
  const endP = toDateParts(window?.end);
  if (!opts.alignToFiscal) {
    return {
      start: formatDate(dayClampedToMonth({ year: startP.year - 1, month: startP.month, day: startP.day })),
      end: formatDate(dayClampedToMonth({ year: endP.year - 1, month: endP.month, day: endP.day })),
    };
  }
  const startMonth = normalizeStartMonth(opts);
  const { fiscalYear } = fiscalYearOf(startP, { startMonth });
  const qStart = quarterIndexWithinFiscalYear(startP, fiscalYear, startMonth);
  const qEnd = quarterIndexWithinFiscalYear(endP, fiscalYear, startMonth);
  return {
    start: formatDate(parts(new Date(Date.UTC(fiscalYear - 1, startMonth - 1 + qStart * 3, 1)))),
    end: formatDate(parts(new Date(Date.UTC(fiscalYear - 1, startMonth - 1 + qEnd * 3 + 3, 0)))),
  };
}

// ---------------------------------------------------------------------------
// Entry point: business-time text resolution
// ---------------------------------------------------------------------------

/**
 * Resolves business-calendar wording to a structured scope.
 * Trigger vocabulary (checked in priority order):
 *   1. test week     — 测试周 / test_week / W33 / 2026-W33 / 第33周 / 2026年第33周
 *   2. Q-Gate        — Q-Gate 5 / QGate5 / QG5 / G5 / 覆盖 gate 5 / 质量门 G5 (needs a number)
 *   3. fiscal quarter— 第3季度 / Q3 / Q3 2026 / 本季度 / 上季度 / last quarter
 *   4. fiscal year   — 财年2026 / 2026财年 / FY2026 / 本财年 / current fiscal year
 *   5. YoY           — 同比 / 去年同期 / year over year / YoY / same period last year
 *
 * opts: { anchorAt, sopAt (SOP anchor for Q-Gate; defaults to anchorAt),
 *         startMonth (fiscal year start; default 1) }
 * Returns {start, end, timezone:"Asia/Shanghai", businessKind, label, anchorAt}
 * (+ sopAt for Q-Gate, + reference for YoY) or null when nothing matches.
 */
export function resolveBusinessTime(text, opts = {}) {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  const anchorMs = opts.anchorAt === undefined ? Date.now() : new Date(opts.anchorAt).getTime();
  const anchor = localDateParts(anchorMs);
  const anchorIso = new Date(anchorMs).toISOString();
  const startMonth = normalizeStartMonth(opts);
  const base = { timezone: "Asia/Shanghai", anchorAt: anchorIso };

  // 1. test week
  const zhWeek = /(?:(20\d{2})\s*年)?\s*第\s*([0-9一二三四五六七八九十]+)\s*个?\s*(?:测试)?周/.exec(raw);
  const isoWeekLabel = /\b(20\d{2})?\s*[-–]?\s*W(\d{1,2})\b/i.exec(raw);
  const weekWithNumber = /(?:测试周|test[_\s]?week)\s*[-#]?\s*(\d{1,2})\b/i.exec(raw);
  let week = null;
  if (zhWeek) {
    const year = zhWeek[1] ? Number(zhWeek[1]) : singleYearHint(raw, anchor.year);
    const weekNumber = parseCnNumber(zhWeek[2]);
    if (weekNumber >= 1 && weekNumber <= 53) week = testWeekRange(`${year}-W${pad2(weekNumber)}`);
  } else if (isoWeekLabel) {
    const year = isoWeekLabel[1] ? Number(isoWeekLabel[1]) : singleYearHint(raw, anchor.year);
    week = testWeekRange(`${year}-W${pad2(Number(isoWeekLabel[2]))}`);
  } else if (weekWithNumber) {
    week = testWeekRange(`${singleYearHint(raw, anchor.year)}-W${pad2(Number(weekWithNumber[1]))}`);
  } else if (/测试周|test[_\s]?week/i.test(raw)) {
    week = resolveTestWeek(anchorMs);
  }
  if (week) {
    return { ...base, businessKind: "test_week", label: week.label, start: week.start, end: week.end };
  }

  // 2. Q-Gate (requires an explicit gate number, or opts via qgateWindow directly)
  const gate = /(?:q[-\s]?gate|qg|\bgate\b|质量门)\s*[-#]?\s*(\d{1,2})\b|\bg\s*[-#]?\s*(\d{1,2})\b/i.exec(raw);
  if (gate && (gate[1] ?? gate[2]) !== undefined) {
    const sopAt = opts.sopAt ?? opts.anchorAt ?? anchorMs;
    const window = qgateWindow(`QG${Number(gate[1] ?? gate[2])}`, sopAt);
    if (window) {
      return { ...base, businessKind: "qgate_window", label: window.gateName, start: window.start, end: window.end, sopAt: window.sopAt };
    }
  }

  // 3. fiscal quarter
  const zhQuarter = /(?:(20\d{2})\s*年)?\s*第\s*([0-9一二三四])\s*个?\s*季度/.exec(raw);
  const enQuarter = /\bQ\s*([1-4])\b/i.exec(raw);
  const currentQuarter = /本季度|本财季|current\s+quarter/i.test(raw);
  const previousQuarter = /上季度|上个季度|上财季|(?:last|previous)\s+quarter/i.test(raw);
  if (zhQuarter || enQuarter || currentQuarter || previousQuarter) {
    const fiscalNow = fiscalQuarters(anchor, { startMonth });
    let targetFiscalYear = fiscalNow.fiscalYear;
    let targetQuarter = fiscalNow.currentQuarter;
    if (zhQuarter || enQuarter) {
      targetQuarter = zhQuarter ? parseCnNumber(zhQuarter[2]) : Number(enQuarter[1]);
      targetFiscalYear = zhQuarter?.[1] ? Number(zhQuarter[1]) : singleYearHint(raw, fiscalNow.fiscalYear);
    } else if (previousQuarter) {
      targetQuarter -= 1;
      if (targetQuarter < 1) {
        targetQuarter += 4;
        targetFiscalYear -= 1;
      }
    }
    const monthIndex = startMonth - 1 + (targetQuarter - 1) * 3;
    return {
      ...base,
      businessKind: "fiscal_quarter",
      label: `FY${targetFiscalYear}-Q${targetQuarter}`,
      start: formatDate(parts(new Date(Date.UTC(targetFiscalYear, monthIndex, 1)))),
      end: formatDate(parts(new Date(Date.UTC(targetFiscalYear, monthIndex + 3, 0)))),
    };
  }

  // 4. fiscal year
  const fiscalYearMatch = /(?:FY\s*)?(20\d{2})\s*财年|财年\s*(20\d{2})|\bFY\s*(20\d{2})/i.exec(raw);
  if (fiscalYearMatch) {
    const year = Number(fiscalYearMatch[1] ?? fiscalYearMatch[2] ?? fiscalYearMatch[3]);
    const fiscal = fiscalYearOf({ year, month: startMonth, day: 1 }, { startMonth });
    return { ...base, businessKind: "fiscal_year", label: `FY${year}`, start: fiscal.start, end: fiscal.end };
  }
  if (/本财年|本财政年度|current\s+fiscal\s+year/i.test(raw)) {
    const fiscal = fiscalYearOf(anchor, { startMonth });
    return { ...base, businessKind: "fiscal_year", label: `FY${fiscal.fiscalYear}`, start: fiscal.start, end: fiscal.end };
  }

  // 5. YoY / same period last year (reference = fiscal year-to-date at anchor)
  if (/同比|去年同期|去年度?同期|same\s+period\s+last\s+year|year[-\s]?over[-\s]?year|\byoy\b/i.test(raw)) {
    const fiscal = fiscalYearOf(anchor, { startMonth });
    const reference = { start: fiscal.start, end: formatDate(anchor) };
    const lastYear = sameBusinessWindowLastYear(reference);
    return { ...base, businessKind: "yoy_same_period", label: "去年同期", start: lastYear.start, end: lastYear.end, reference };
  }

  return null;
}
