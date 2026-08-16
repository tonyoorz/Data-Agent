// @vitest-environment node
import { describe, expect, it } from "vitest";
import { voteOnPlans } from "../../../../server/ontology/planVoting.mjs";

/** Deterministic fake executor over a tiny governed "dataset". */
function makeExecutor(table) {
  const calls = [];
  const executeFn = async (plan) => {
    calls.push(plan.executionFingerprint ?? JSON.stringify(plan.steps));
    // aggregate: sum per dim bucket — deterministic per plan semantics
    const key = plan.steps.map((s) => `${s.operation}:${(s.metricIds ?? []).join("+")}:${(s.dimensionIds ?? s.canonicalArgs?.query?.dimensions ?? []).join("*")}`).join("|");
    const rows = table[key] ?? [];
    return { rows, signature: `${rows.length}:${rows.reduce((acc, r) => acc + r.value, 0)}` };
  };
  executeFn.calls = calls;
  return executeFn;
}

const plan = (fingerprint, key) => ({
  executionFingerprint: fingerprint,
  steps: [{ operation: "semantic_metric_query", metricIds: ["defect.count"], dimensionIds: [key] }],
  kind: "test",
});

describe("planVoting (execution-guided voting)", () => {
  it("all candidates agree → UNANIMOUS with winner", async () => {
    const exec = makeExecutor({ "semantic_metric_query:defect.count:ecu": [{ value: 3 }, { value: 5 }] });
    const r = await voteOnPlans({
      candidates: [
        { kind: "direct", plan: plan("fp-1", "ecu") },
        { kind: "decomposed", plan: plan("fp-2", "ecu") },
        { kind: "constraintFirst", plan: plan("fp-3", "ecu") },
      ],
      executeFn: exec,
    });
    expect(r.verdict).toBe("UNANIMOUS");
    expect(r.winner.plan.executionFingerprint).toBe("fp-1");
    expect(r.evidence.agreeing).toBe(3);
  });

  it("2/3 agree → MAJORITY, winner from the majority", async () => {
    const exec = makeExecutor({
      "semantic_metric_query:defect.count:ecu": [{ value: 8 }],
      "semantic_metric_query:defect.count:severity": [{ value: 2 }, { value: 6 }],
    });
    const r = await voteOnPlans({
      candidates: [
        { kind: "direct", plan: plan("fp-1", "ecu") },
        { kind: "decomposed", plan: plan("fp-2", "ecu") },
        { kind: "constraintFirst", plan: plan("fp-3", "severity") },
      ],
      executeFn: exec,
    });
    expect(r.verdict).toBe("MAJORITY");
    expect(r.winner.plan.executionFingerprint).toBe("fp-1");
    expect(r.evidence.dissenters.length).toBe(1);
  });

  it("all disagree → DISAGREE, NO winner, clarification guidance", async () => {
    const exec = makeExecutor({
      "semantic_metric_query:defect.count:ecu": [{ value: 1 }],
      "semantic_metric_query:defect.count:severity": [{ value: 2 }],
      "semantic_metric_query:defect.count:team": [{ value: 3 }],
    });
    const r = await voteOnPlans({
      candidates: [
        { kind: "direct", plan: plan("fp-1", "ecu") },
        { kind: "decomposed", plan: plan("fp-2", "severity") },
        { kind: "constraintFirst", plan: plan("fp-3", "team") },
      ],
      executeFn: exec,
    });
    expect(r.verdict).toBe("DISAGREE");
    expect(r.winner).toBeNull();
    expect(r.action).toBe("clarify");
    expect(r.evidence.candidateDifferences.length).toBe(3);
  });

  it("single candidate always UNANIMOUS (degenerates gracefully)", async () => {
    const exec = makeExecutor({ "semantic_metric_query:defect.count:ecu": [{ value: 4 }] });
    const r = await voteOnPlans({
      candidates: [{ kind: "direct", plan: plan("fp-1", "ecu") }],
      executeFn: exec,
    });
    expect(r.verdict).toBe("UNANIMOUS");
    expect(r.winner).toBeTruthy();
  });

  it("execution error in one candidate → excluded from voting, others proceed", async () => {
    const exec = makeExecutor({ "semantic_metric_query:defect.count:ecu": [{ value: 4 }] });
    let boom = false;
    const wrapped = async (p) => {
      if (p.executionFingerprint === "fp-boom") { boom = true; throw new Error("EXEC_FAILED"); }
      return exec(p);
    };
    const r = await voteOnPlans({
      candidates: [
        { kind: "direct", plan: plan("fp-1", "ecu") },
        { kind: "constraintFirst", plan: plan("fp-boom", "ecu") },
      ],
      executeFn: wrapped,
    });
    expect(boom).toBe(true);
    expect(r.verdict).toBe("UNANIMOUS");
    expect(r.evidence.executed).toBe(2);
    expect(r.evidence.errors.length).toBe(1);
  });
});
