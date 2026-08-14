/**
 * P1: Data health footnotes.
 * Answers carry data-quality notes (freshness, completeness) so users see
 * confidence context instead of naked numbers.
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build a health note set from dataset freshness/completeness signals.
 * inputs: { datasets: [{ name, lastRefreshedAt, expectedFrequencyHours, completeness }] }
 */
export function buildDataHealth({ datasets, now = () => new Date() } = {}) {
  const notes = [];
  const entries = [];
  const at = now();

  for (const dataset of Array.isArray(datasets) ? datasets : []) {
    if (!isRecord(dataset)) continue;
    const name = String(dataset.name || "dataset");
    const refreshed = dataset.lastRefreshedAt ? new Date(dataset.lastRefreshedAt) : null;
    const expectedHours = Number(dataset.expectedFrequencyHours) > 0 ? Number(dataset.expectedFrequencyHours) : null;
    const completeness = Number(dataset.completeness);

    let stalenessHours = null;
    if (refreshed && !Number.isNaN(refreshed.getTime())) {
      stalenessHours = Math.max(0, (at - refreshed) / 3_600_000);
    }

    let severity = "ok";
    if (stalenessHours !== null && expectedHours && stalenessHours > expectedHours * 2) {
      severity = "stale";
      notes.push(`${name}: 数据刷新延迟 ${Math.round(stalenessHours)}h（预期 ${expectedHours}h 内）`);
    } else if (Number.isFinite(completeness) && completeness < 0.95) {
      severity = "partial";
      notes.push(`${name}: 当期数据完整度 ${(completeness * 100).toFixed(0)}%，统计可能偏低`);
    }

    entries.push({ name, lastRefreshedAt: dataset.lastRefreshedAt ?? null, stalenessHours, completeness: Number.isFinite(completeness) ? completeness : null, severity });
  }

  return {
    ok: notes.length === 0,
    severity: notes.length ? "warning" : "ok",
    notes,
    entries,
    evaluatedAt: at.toISOString(),
  };
}
