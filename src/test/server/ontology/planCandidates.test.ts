// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPlanCandidateGenerator } from "../../../../server/ontology/planCandidates.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";
import { createQueryPlanner, validatePlan } from "../../../../server/ontology/queryPlanner.mjs";

const NOW = "2026-08-16T02:00:00.000Z";
const actor = { actorId: "c", scopeHash: "c-scope", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
const registry = createOntologyRegistry();
const resolver = createSemanticResolver({ registry, now: () => NOW });
const planner = createQueryPlanner({ registry });
const gen = createPlanCandidateGenerator({ planner, registry });

function frameFor(q) {
  return resolver.resolve({ query: q, actor, requestAnchorAt: NOW });
}

describe("planCandidates (multi-path planning, CHASE-SQL style)", () => {
  it("multi-dim query yields >=2 candidates with distinct fingerprints", () => {
    const frame = frameFor("缺陷按 ECU 和严重度分布");
    const candidates = gen.generateCandidates({ frame, actor, query: "缺陷按 ECU 和严重度分布" });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const fps = new Set(candidates.map((c) => c.plan.executionFingerprint ?? c.plan.planId));
    expect(fps.size).toBe(candidates.length); // all distinct
  });

  it("every candidate passes validatePlan and stays semantically equivalent (same metric set)", () => {
    const frame = frameFor("缺陷按 ECU 和严重度分布");
    const candidates = gen.generateCandidates({ frame, actor, query: "缺陷按 ECU 和严重度分布" });
    for (const c of candidates) {
      expect(() => validatePlan(c.plan)).not.toThrow();
      expect(c.kind).toMatch(/^(direct|decomposed|constraintFirst)$/);
      // same governed metric set across candidates (decomposed may repeat per-step)
      const metricIds = [...new Set(c.plan.steps.flatMap((s) => s.metricIds))];
      expect(metricIds.sort()).toEqual([...frame.metricIds].sort());
    }
  });

  it("simple single-metric single-dim query may yield fewer candidates (honest, no fake paths)", () => {
    const frame = frameFor("缺陷总数");
    const candidates = gen.generateCandidates({ frame, actor, query: "缺陷总数" });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates[0].kind).toBe("direct");
  });

  it("clarification-denied frame propagates without candidate explosion", () => {
    const frame = frameFor("缺陷怎么样"); // ambiguous → needs_clarification
    const candidates = gen.generateCandidates({ frame, actor, query: "缺陷怎么样" });
    // plan status may be needs_clarification — candidates carry it, no throw
    for (const c of candidates) {
      expect(["valid", "needs_clarification", "denied"]).toContain(c.plan.status);
    }
  });

  it("LLM hook is optional — rule-based generation works without a model", () => {
    const frame = frameFor("回归覆盖率现在多少");
    const candidates = gen.generateCandidates({ frame, actor, query: "回归覆盖率现在多少" });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.every((c) => !c.viaLlm)).toBe(true);
  });
});
