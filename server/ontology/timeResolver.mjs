const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const CHINESE_NUMBERS = Object.freeze({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十二: 12 });

function localDateParts(anchorAt) {
  const instant = new Date(anchorAt);
  if (Number.isNaN(instant.getTime())) throw new Error("SEMANTIC_TIME_ANCHOR_INVALID");
  const shifted = new Date(instant.getTime() + SHANGHAI_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function dateValue({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

function parts(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function formatDate(value) {
  const { year, month, day } = value instanceof Date ? parts(value) : value;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(value, days) {
  const date = value instanceof Date ? new Date(value) : dateValue(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function endOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0));
}

function startOfMonthOffset(anchor, monthOffset) {
  return new Date(Date.UTC(anchor.year, anchor.month - 1 + monthOffset, 1));
}

function currentMonday(anchorDate) {
  const day = anchorDate.getUTCDay() || 7;
  return addDays(anchorDate, -(day - 1));
}

function makeScope({ role = "primary", fieldId, start, end, anchorAt, relativeText }) {
  return {
    role,
    fieldId,
    start: formatDate(start),
    end: formatDate(end),
    timezone: "Asia/Shanghai",
    ...(relativeText ? { relativeText } : {}),
    anchorAt: new Date(anchorAt).toISOString(),
  };
}
function parsedCount(value) {
  if (/^\d+$/.test(value)) return Number(value);
  return CHINESE_NUMBERS[value] || 1;
}

function explicitYears(query) {
  return [...String(query).matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
}

export function resolveTimeScopes({ query, fieldId, anchorAt }) {
  if (!fieldId) return { timeScopes: [], assumptions: [] };
  const text = String(query || "");
  const anchor = localDateParts(anchorAt);
  const anchorDate = dateValue(anchor);
  const explicitDate = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (explicitDate) {
    const value = { year: Number(explicitDate[1]), month: Number(explicitDate[2]), day: Number(explicitDate[3]) };
    return { timeScopes: [makeScope({ fieldId, start: value, end: value, anchorAt })], assumptions: [] };
  }

  const comparesCurrentAndPreviousWeek = /(?:本周|这周)\s*(?:比|对比|比较|相比|vs\.?|versus)\s*上周|上周\s*(?:和|与|比|对比|比较|相比|vs\.?)\s*(?:本周|这周)|(?:this|current)\s+week\s*(?:vs\.?|versus|compared?\s+(?:with|to))\s*(?:last|previous)\s+week/i.test(text);
  if (comparesCurrentAndPreviousWeek) {
    const monday = currentMonday(anchorDate);
    return {
      timeScopes: [
        makeScope({ role: "baseline", fieldId, start: addDays(monday, -7), end: addDays(monday, -1), anchorAt, relativeText: "上周" }),
        makeScope({ role: "comparison", fieldId, start: monday, end: anchorDate, anchorAt, relativeText: "本周" }),
      ],
      assumptions: [],
    };
  }

  const comparesCurrentAndPreviousMonth = /(?:本月|这个月)\s*(?:比|对比|比较|相比|vs\.?|versus)\s*(?:上月|上个月)|(?:上月|上个月)\s*(?:和|与|比|对比|比较|相比|vs\.?)\s*(?:本月|这个月)|(?:this|current)\s+month\s*(?:vs\.?|versus|compared?\s+(?:with|to))\s*(?:last|previous)\s+month/i.test(text);
  if (comparesCurrentAndPreviousMonth) {
    const previousMonthEnd = addDays({ ...anchor, day: 1 }, -1);
    const previous = parts(previousMonthEnd);
    return {
      timeScopes: [
        makeScope({ role: "baseline", fieldId, start: { ...previous, day: 1 }, end: previousMonthEnd, anchorAt, relativeText: "上月" }),
        makeScope({ role: "comparison", fieldId, start: { ...anchor, day: 1 }, end: anchorDate, anchorAt, relativeText: "本月" }),
      ],
      assumptions: [],
    };
  }

  const recentMatch = /最近\s*([一二两三四五六七八九十十二\d]+)\s*(天|周|个?月)|近\s*([一二两三四五六七八九十十二\d]+)\s*(天|周|个?月)|(?:last|recent)\s+(\d+)\s+(days?|weeks?|months?)/i.exec(text);
  if (recentMatch || /最近一周|近一周|last\s+week/i.test(text)) {
    const rawCount = recentMatch?.[1] || recentMatch?.[3] || recentMatch?.[5] || "1";
    const unit = recentMatch?.[2] || recentMatch?.[4] || recentMatch?.[6] || "周";
    const count = Math.max(1, parsedCount(rawCount));
    if (/月|month/i.test(unit)) {
      return {
        timeScopes: [makeScope({ fieldId, start: startOfMonthOffset(anchor, -(count - 1)), end: anchorDate, anchorAt, relativeText: recentMatch?.[0] })],
        assumptions: [],
      };
    }
    const days = /周|week/i.test(unit) ? count * 7 : count;
    return {
      timeScopes: [makeScope({ fieldId, start: addDays(anchorDate, -(days - 1)), end: anchorDate, anchorAt, relativeText: recentMatch?.[0] || "最近一周" })],
      assumptions: [],
    };
  }

  if (/上周|previous\s+week/i.test(text)) {
    const monday = currentMonday(anchorDate);
    return {
      timeScopes: [makeScope({ fieldId, start: addDays(monday, -7), end: addDays(monday, -1), anchorAt, relativeText: "上周" })],
      assumptions: [],
    };
  }

  if (/本周|这周|current\s+week|this\s+week/i.test(text)) {
    return {
      timeScopes: [makeScope({ fieldId, start: currentMonday(anchorDate), end: anchorDate, anchorAt, relativeText: "本周" })],
      assumptions: [],
    };
  }

  const monthMatch = /(?:(20\d{2})\s*年)?\s*([一二三四五六七八九十十二\d]{1,3})\s*月/.exec(text);
  if (monthMatch && !/本月|上月/.test(monthMatch[0])) {
    const year = monthMatch[1] ? Number(monthMatch[1]) : anchor.year;
    const month = parsedCount(monthMatch[2]);
    if (month < 1 || month > 12) throw new Error("SEMANTIC_TIME_MONTH_INVALID");
    return {
      timeScopes: [makeScope({ fieldId, start: { year, month, day: 1 }, end: endOfMonth(year, month), anchorAt })],
      assumptions: monthMatch[1] ? [] : ["MONTH_USES_ANCHOR_YEAR"],
    };
  }

  if (/本月|current\s+month/i.test(text)) {
    return {
      timeScopes: [makeScope({ fieldId, start: { ...anchor, day: 1 }, end: anchorDate, anchorAt, relativeText: "本月" })],
      assumptions: [],
    };
  }

  if (/上月|上个月|previous\s+month/i.test(text)) {
    const previousMonthEnd = addDays({ ...anchor, day: 1 }, -1);
    const previous = parts(previousMonthEnd);
    return {
      timeScopes: [makeScope({ fieldId, start: { ...previous, day: 1 }, end: previousMonthEnd, anchorAt, relativeText: "上月" })],
      assumptions: [],
    };
  }

  const years = [...new Set(explicitYears(text))];
  if (years.length >= 2 && /对比|比较|相比|\bvs\.?\b|versus/i.test(text)) {
    return {
      timeScopes: years.slice(0, 2).map((year, index) => makeScope({
        role: index === 0 ? "baseline" : "comparison",
        fieldId,
        start: { year, month: 1, day: 1 },
        end: { year, month: 12, day: 31 },
        anchorAt,
      })),
      assumptions: [],
    };
  }
  if (years.length) {
    const year = years[0];
    return { timeScopes: [makeScope({ fieldId, start: { year, month: 1, day: 1 }, end: { year, month: 12, day: 31 }, anchorAt })], assumptions: [] };
  }
  if (/今年|本年度|current\s+year/i.test(text)) {
    return {
      timeScopes: [makeScope({ fieldId, start: { year: anchor.year, month: 1, day: 1 }, end: anchorDate, anchorAt, relativeText: "今年" })],
      assumptions: [],
    };
  }
  return {
    timeScopes: [makeScope({ fieldId, start: { year: anchor.year, month: 1, day: 1 }, end: anchorDate, anchorAt })],
    assumptions: ["TIME_DEFAULTS_TO_ANCHOR_YEAR_TO_DATE"],
  };
}
