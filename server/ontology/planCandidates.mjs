/**
 * PlanCandidates (P0-B2): multi-path governed query planning (CHASE-SQL style).
 * Generates 1-3 candidate plans for the SAME semantic frame:
 *   - direct:          planner output as-is
 *   - decomposed:      one step per dimension (per-dim aggregation decomposition)
 *   - constraintFirst: alternative grouping order (dims reversed)
 * Multi-path is only offered when it is honest (>= 2 dimensions, aggregate-family
 * intent). Trace/similarity/record intents get the single direct path.
 * All candidates pass validatePlan — voting happens downstream (planVoting).
 * Optional LLM hook reserved (viaLlm) — v1 is rule-based only.
 */
import {
  createQueryPlanId,
  fingerprintQueryPlanSteps,
} from "./queryPlanner.mjs";

const MULTI_PATH_INTENTS = new Set(["aggregate", "trend", "rank", "compare"]);

function renumberSteps(steps) {
  return steps.map((step, index) => ({
    ...step,
    stepId: `s${index + 1}`,
    dependsOn: index === 0 ? [] : [`s${index}`],
  }));
}

function mergePlan({ template, steps, frame }) {
  const executionFingerprint = fingerprintQueryPlanSteps(steps);
  return {
    ...template,
    planId: createQueryPlanId({
      frame,
      actorScopeHash: template.actorScopeHash,
      sourceQueryFingerprint: template.sourceQueryFingerprint,
      executionFingerprint,
    }),
    executionFingerprint,
    steps,
  };
}

export function createPlanCandidateGenerator({ planner, registry, llm = null } = {}) {
  if (!planner) throw new Error("PLAN_CANDIDATES_INVALID: planner required");
  if (!registry) throw new Error("PLAN_CANDIDATES_INVALID: registry required");

  function tryPlan(frame, actor, query) {
    try {
      return planner.createPlan({ frame, actor, query });
    } catch {
      return null;
    }
  }

  function generateCandidates({ frame, actor, query }) {
    if (!frame) throw new Error("PLAN_CANDIDATES_INVALID: frame required");
    const candidates = [];

    const direct = tryPlan(frame, actor, query);
    if (!direct) return candidates;
    candidates.push({ kind: "direct", plan: direct, viaLlm: false });

    const dims = frame.dimensionIds ?? [];
    const multiPathable = MULTI_PATH_INTENTS.has(frame.intent) && dims.length >= 2 && direct.status === "valid";
    if (!multiPathable) return candidates;

    // decomposed: per-dimension steps merged into one governed plan
    const perDimSteps = [];
    let allDimsPlanned = true;
    for (const dim of dims) {
      const variant = { ...frame, dimensionIds: [dim] };
      const plan = tryPlan(variant, actor, query);
      if (!plan || plan.status !== "valid" || !plan.steps.length) { allDimsPlanned = false; break; }
      perDimSteps.push(...plan.steps);
    }
    if (allDimsPlanned && perDimSteps.length > 1) {
      const steps = renumberSteps(perDimSteps);
      candidates.push({
        kind: "decomposed",
        plan: mergePlan({ template: direct, steps, frame }),
        viaLlm: false,
      });
    }

    // constraintFirst: alternative grouping order (reversed dims)
    const reversed = { ...frame, dimensionIds: [...dims].reverse() };
    const reversedPlan = tryPlan(reversed, actor, query);
    if (reversedPlan && reversedPlan.status === "valid" && reversedPlan.steps.length) {
      const steps = renumberSteps(reversedPlan.steps);
      if (steps.length !== direct.steps.length
        || fingerprintQueryPlanSteps(steps) !== fingerprintQueryPlanSteps(direct.steps)) {
        candidates.push({
          kind: "constraintFirst",
          plan: mergePlan({ template: direct, steps: reversedPlan.steps.length ? steps : steps, frame: reversed }),
          viaLlm: false,
        });
      }
    }

    return candidates;
  }

  return Object.freeze({ generateCandidates, llmAvailable: Boolean(llm) });
}
