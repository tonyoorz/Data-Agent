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

export function collectTicketMonthOptions(ticketRows: MainDashboardTicketRow[]) {
  return Array.from(
    new Set(
      ticketRows
        .map((row) => getTicketMonthValue(row.ticketDate))
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