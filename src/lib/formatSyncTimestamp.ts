export function formatSyncTimestamp(value: string | null | undefined) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return trimmedValue;
  }

  const secondPrecisionMatch = trimmedValue.match(
    /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})/,
  );

  if (secondPrecisionMatch) {
    return `${secondPrecisionMatch[1]} ${secondPrecisionMatch[2]}`;
  }

  const parsedTimestamp = Date.parse(trimmedValue);

  if (Number.isNaN(parsedTimestamp)) {
    return trimmedValue;
  }

  return new Date(parsedTimestamp).toISOString().replace("T", " ").slice(0, 19);
}