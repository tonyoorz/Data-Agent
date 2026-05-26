function normalizeSelectionValue(nextValue: string) {
  return nextValue.trim();
}

export function applyFvPointSelection(_currentValues: string[], nextValue: string) {
  const normalizedValue = normalizeSelectionValue(nextValue);
  return normalizedValue ? [normalizedValue] : [];
}

export function applyAidaPointSelection(
  _currentValues: string[],
  nextValue: string,
) {
  const normalizedValue = normalizeSelectionValue(nextValue);
  return normalizedValue ? [normalizedValue] : [];
}