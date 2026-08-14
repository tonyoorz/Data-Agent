/**
 * P0-2: Token metering + budget guard.
 * Per-step/per-session token accounting with a hard budget ceiling.
 * When the ceiling is hit the loop degrades (no more tool steps, finalize
 * with a budget-exceeded note) instead of burning unbounded tokens.
 */

const DEFAULT_STEP_BUDGET = 24_000;
const DEFAULT_SESSION_BUDGET = 160_000;
const DEFAULT_TOOL_STEP_BUDGET = 6;

function positiveInt(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

export function createTokenBudgetGuard({
  env = process.env,
  now = () => new Date(),
} = {}) {
  const stepBudget = positiveInt(env.VIZION_TOKEN_STEP_BUDGET, DEFAULT_STEP_BUDGET);
  const sessionBudget = positiveInt(env.VIZION_TOKEN_SESSION_BUDGET, DEFAULT_SESSION_BUDGET);
  const toolStepBudget = positiveInt(env.VIZION_TOOL_STEP_BUDGET, DEFAULT_TOOL_STEP_BUDGET);

  const state = {
    sessionTokens: { input: 0, output: 0, total: 0 },
    steps: 0,
    toolSteps: 0,
    requests: 0,
    exceededAt: null,
    degraded: false,
  };

  function normalizeUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const input = Math.max(0, Number(usage.input ?? usage.prompt_tokens ?? 0) || 0);
    const output = Math.max(0, Number(usage.output ?? usage.completion_tokens ?? 0) || 0);
    const total = Math.max(0, Number(usage.total ?? 0) || input + output);
    return { input, output, total };
  }

  return {
    budgets: { stepBudget, sessionBudget, toolStepBudget },

    snapshot() {
      return {
        session: { ...state.sessionTokens },
        steps: state.steps,
        toolSteps: state.toolSteps,
        requests: state.requests,
        remaining: Math.max(0, sessionBudget - state.sessionTokens.total),
        exceeded: Boolean(state.exceededAt),
        degraded: state.degraded,
        exceededAt: state.exceededAt,
      };
    },

    /** Record one model request's usage. Marks exceeded when over ceiling. */
    recordRequest(usage) {
      const normalized = normalizeUsage(usage);
      if (!normalized) return this.snapshot();
      state.requests += 1;
      state.sessionTokens.input += normalized.input;
      state.sessionTokens.output += normalized.output;
      state.sessionTokens.total += normalized.total;
      if (state.sessionTokens.total > sessionBudget && !state.exceededAt) {
        state.exceededAt = now().toISOString();
      }
      return this.snapshot();
    },

    recordStep() {
      state.steps += 1;
      return this.snapshot();
    },

    recordToolStep() {
      state.toolSteps += 1;
      return this.snapshot();
    },

    /** Can the loop admit another model step? (not exceeded, still under ceiling) */
    canStep() {
      return !state.exceededAt && state.sessionTokens.total < sessionBudget;
    },

    /** Strict variant: require a full unclamped step reserve under the ceiling. */
    canAdmitFullStep() {
      return this.canStep() && state.sessionTokens.total + stepBudget <= sessionBudget;
    },

    /** Can the loop admit another tool execution round? */
    canToolStep() {
      return this.canStep() && state.toolSteps < toolStepBudget;
    },

    /** Force degraded mode (e.g. caller wants to stop early). */
    markDegraded(reason = "manual") {
      state.degraded = true;
      if (!state.exceededAt) state.exceededAt = now().toISOString();
      return { ...this.snapshot(), reason };
    },

    /**
     * Build a budget note for the finalize node so the user-visible answer
     * explains why the agent stopped early.
     */
    budgetNote() {
      if (!state.exceededAt) return null;
      return {
        reason: state.degraded ? "SESSION_BUDGET_DEGRADED" : "SESSION_BUDGET_EXCEEDED",
        spent: state.sessionTokens.total,
        budget: sessionBudget,
        steps: state.steps,
        toolSteps: state.toolSteps,
      };
    },
  };
}
