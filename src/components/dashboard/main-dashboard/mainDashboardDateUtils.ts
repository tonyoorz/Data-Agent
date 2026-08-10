import type { MainDashboardTicketRow } from "./mainDashboardTypes";

export function parseTicketDateValue(value?: string | null) {
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const dateMatch = trimmedValue.match(/(\d{4}-\d{2}-\d{2})/);

  if (dateMatch) {
    const [year, month, day] = dateMatch[1].split("-").map(Number);

    return {
      label: dateMatch[1],
      monthLabel: dateMatch[1].slice(0, 7),
      sortValue: Date.UTC(year, month - 1, day),
    };
  }

  const parsedTimestamp = Date.parse(trimmedValue);

  if (Number.isNaN(parsedTimestamp)) {
    return null;
  }

  const normalizedLabel = new Date(parsedTimestamp).toISOString().slice(0, 10);

  return {
    label: normalizedLabel,
    monthLabel: normalizedLabel.slice(0, 7),
    sortValue: parsedTimestamp,
  };
}

export function getTicketMonthValue(value?: string | null) {
  return parseTicketDateValue(value)?.monthLabel ?? null;
}

export function collectTicketMonthOptions(
  ticketRows: MainDashboardTicketRow[],
  getDateValue: (row: MainDashboardTicketRow) => string | null | undefined = (row) => row.ticketDate,
) {
  return Array.from(
    new Set(
      ticketRows
        .map((row) => getTicketMonthValue(getDateValue(row)))
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) => right.localeCompare(left));
}

export function getLatestTicketDateLabel(ticketRows: MainDashboardTicketRow[]) {
  return ticketRows.reduce<string | null>((latestLabel, row) => {
    const candidate = parseTicketDateValue(row.ticketDate);

    if (!candidate) {
      return latestLabel;
    }

    const currentLatest = parseTicketDateValue(latestLabel);

    if (!currentLatest || candidate.sortValue > currentLatest.sortValue) {
      return candidate.label;
    }

    return latestLabel;
  }, null);
}

export function getLatestTicketMonthValue(ticketRows: MainDashboardTicketRow[]) {
  return ticketRows.reduce<string | null>((latestMonth, row) => {
    const candidate = parseTicketDateValue(row.ticketDate);

    if (!candidate) {
      return latestMonth;
    }

    const currentLatest = latestMonth
      ? parseTicketDateValue(`${latestMonth}-01`)
      : null;

    if (!currentLatest || candidate.sortValue > currentLatest.sortValue) {
      return candidate.monthLabel;
    }

    return latestMonth;
  }, null);
}

function formatMonthDate(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function getDaysInUtcMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function shiftUtcDateByMonths(year: number, monthIndex: number, day: number, monthDelta: number) {
  const absoluteMonthIndex = year * 12 + monthIndex + monthDelta;
  const nextYear = Math.floor(absoluteMonthIndex / 12);
  const nextMonthIndex = absoluteMonthIndex % 12;
  const nextDay = Math.min(day, getDaysInUtcMonth(nextYear, nextMonthIndex));

  return {
    year: nextYear,
    monthIndex: nextMonthIndex,
    day: nextDay,
  };
}

function shiftUtcDateByDays(year: number, monthIndex: number, day: number, dayDelta: number) {
  const shiftedDate = new Date(Date.UTC(year, monthIndex, day));
  shiftedDate.setUTCDate(shiftedDate.getUTCDate() + dayDelta);

  return {
    year: shiftedDate.getUTCFullYear(),
    monthIndex: shiftedDate.getUTCMonth(),
    day: shiftedDate.getUTCDate(),
  };
}

export function getRecentCreationTimeRangeFromAnchor(anchorValue?: string | null, dayCount = 14) {
  const anchor = parseTicketDateValue(anchorValue);

  if (!anchor) {
    return {
      startDate: "",
      endDate: "",
    };
  }

  const [anchorYear, anchorMonthNumber, anchorDay] = anchor.label.split("-").map(Number);

  if (!anchorYear || !anchorMonthNumber || !anchorDay) {
    return {
      startDate: "",
      endDate: "",
    };
  }

  const startDate = shiftUtcDateByDays(
    anchorYear,
    anchorMonthNumber - 1,
    anchorDay,
    -Math.max(dayCount - 1, 0),
  );

  return {
    startDate: formatMonthDate(startDate.year, startDate.monthIndex, startDate.day),
    endDate: anchor.label,
  };
}

export function getRecentCreationTimeRange(months: string[], dayCount = 14) {
  if (months.length === 0) {
    return {
      startDate: "",
      endDate: "",
    };
  }

  const latestMonth = months[months.length - 1];
  const [latestYear, latestMonthNumber] = latestMonth.split("-").map(Number);

  if (!latestYear || !latestMonthNumber) {
    return {
      startDate: "",
      endDate: "",
    };
  }

  const latestMonthIndex = latestMonthNumber - 1;
  const latestDay = getDaysInUtcMonth(latestYear, latestMonthIndex);
  const startDate = shiftUtcDateByDays(
    latestYear,
    latestMonthIndex,
    latestDay,
    -Math.max(dayCount - 1, 0),
  );

  return {
    startDate: formatMonthDate(startDate.year, startDate.monthIndex, startDate.day),
    endDate: formatMonthDate(latestYear, latestMonthIndex, latestDay),
  };
}

export function getCoveredYearsForCreationTimeRange(startDate: string, endDate: string) {
  const parsedStart = parseTicketDateValue(startDate);
  const parsedEnd = parseTicketDateValue(endDate);
  const firstYear = parsedStart ? Number(parsedStart.label.slice(0, 4)) : null;
  const lastYear = parsedEnd ? Number(parsedEnd.label.slice(0, 4)) : firstYear;

  if (!firstYear && !lastYear) {
    return [];
  }

  const startYear = Math.min(firstYear ?? lastYear ?? 0, lastYear ?? firstYear ?? 0);
  const endYear = Math.max(firstYear ?? lastYear ?? 0, lastYear ?? firstYear ?? 0);
  const years: string[] = [];

  for (let year = endYear; year >= startYear; year -= 1) {
    years.push(String(year));
  }

  return years;
}