export function formatSyncTimestamp(value: string | null | undefined) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return trimmedValue;
  }

  const secondPrecisionMatch = trimmedValue.match(/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/);

  if (secondPrecisionMatch) {
    const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmedValue);
    const isoCandidate = hasExplicitTimezone
      ? trimmedValue
      : trimmedValue.replace(" ", "T") + "Z";
    const parsedWithUtcFallback = Date.parse(isoCandidate);

    if (!Number.isNaN(parsedWithUtcFallback)) {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = formatter.formatToParts(new Date(parsedWithUtcFallback));
      const partMap = new Map(parts.map((part) => [part.type, part.value]));

      return `${partMap.get("year")}-${partMap.get("month")}-${partMap.get("day")} ${partMap.get("hour")}:${partMap.get("minute")}:${partMap.get("second")}`;
    }
  }

  const parsedTimestamp = Date.parse(trimmedValue);

  if (Number.isNaN(parsedTimestamp)) {
    return trimmedValue;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(parsedTimestamp));
  const partMap = new Map(parts.map((part) => [part.type, part.value]));

  return `${partMap.get("year")}-${partMap.get("month")}-${partMap.get("day")} ${partMap.get("hour")}:${partMap.get("minute")}:${partMap.get("second")}`;
}