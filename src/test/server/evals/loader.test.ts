import { describe, it, expect } from "vitest";
import { loadGoldenDataset, validateCase, INTENTS, DOMAINS } from "./loader.mjs";

describe("golden eval dataset v1", () => {
  it("loads exactly 50 cases", () => {
    const { cases } = loadGoldenDataset();
    expect(cases).toHaveLength(50);
  });

  it("every case passes schema validation", () => {
    const { cases } = loadGoldenDataset();
    for (const c of cases) {
      const problems = validateCase(c);
      expect(problems, `case ${c.id}: ${problems.join("; ")}`).toEqual([]);
    }
  });

  it("has unique ids and non-empty questions", () => {
    const { cases } = loadGoldenDataset();
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(50);
    for (const c of cases) expect(c.q.trim().length).toBeGreaterThan(3);
  });

  it("covers >= 15 intents", () => {
    const { stats } = loadGoldenDataset();
    const covered = Object.entries(stats.byIntent).filter(([, n]) => n > 0).length;
    expect(covered).toBeGreaterThanOrEqual(15);
  });

  it("all referenced metrics/dims exist in compiled ontology", () => {
    const { cases, ontology } = loadGoldenDataset();
    const metricIds = new Set(ontology.metrics.map((m: { id: string }) => m.id));
    const dimIds = new Set(ontology.dimensions.map((d: { id: string }) => d.id));
    for (const c of cases) {
      for (const m of c.expect.metrics ?? []) {
        expect(metricIds.has(m), `${c.id} metric ${m} not in ontology`).toBe(true);
      }
      for (const d of c.expect.dims ?? []) {
        expect(dimIds.has(d), `${c.id} dim ${d} not in ontology`).toBe(true);
      }
      for (const f of Object.keys(c.expect.filters ?? {})) {
        expect(dimIds.has(f), `${c.id} filter key ${f} not a governed dimension`).toBe(true);
      }
    }
  });

  it("domain distribution matches quota (+/- 2)", () => {
    const quota: Record<string, number> = {
      defect: 12,
      testing: 10,
      traceability: 6,
      organization: 5,
      longtail: 7,
      clarify: 5,
      reject: 5,
    };
    expect(Object.keys(quota).sort()).toEqual(DOMAINS.slice().sort());
    const { stats } = loadGoldenDataset();
    for (const [domain, want] of Object.entries(quota)) {
      const got = stats.byDomain[domain] ?? 0;
      expect(Math.abs(got - want), `${domain}: got ${got}, want ${want}±2`).toBeLessThanOrEqual(2);
    }
  });

  it("exports the 16 governed intents", () => {
    expect(INTENTS).toHaveLength(16);
    expect(INTENTS).toContain("metric_query");
    expect(INTENTS).toContain("business_risk_assessment");
  });
});
