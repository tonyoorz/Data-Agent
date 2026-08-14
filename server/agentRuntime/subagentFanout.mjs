/**
 * P1: Subagent fan-out.
 * Parallel delegated tool queries with a join barrier and per-branch
 * budget isolation. One branch failing never sinks the others; results
 * merge with branch attribution for evidence gates.
 */

function nowDefault() {
  return new Date();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createSubagentFanout({ budgetGuard, now = nowDefault, maxBranches = 4 } = {}) {
  const guard = budgetGuard ?? null;

  return {
    /**
     * Run branches in parallel. Each branch: { name, run: async () => result }.
     * Returns { ok, failed, timings } with branch attribution preserved.
     */
    async run(branches) {
      const list = (Array.isArray(branches) ? branches : []).filter((branch) => branch && typeof branch.run === "function");
      if (!list.length) return { ok: [], failed: [], timings: {} };
      if (list.length > maxBranches) {
        throw new Error(`FANOUT_INVALID: ${list.length} branches exceed max ${maxBranches}`);
      }

      const started = now();
      const settled = await Promise.allSettled(
        list.map(async (branch) => {
          if (guard && !guard.canAdmitFullStep()) {
            throw new Error(`BRANCH_BUDGET_EXCEEDED:${branch.name}`);
          }
          const branchStart = now().getTime();
          const result = await branch.run();
          if (guard) guard.recordToolStep();
          return { name: branch.name, result, durationMs: now().getTime() - branchStart };
        })
      );

      const ok = [];
      const failed = [];
      const timings = {};
      settled.forEach((outcome, index) => {
        const branch = list[index];
        if (outcome.status === "fulfilled") {
          ok.push({ branch: branch.name, result: outcome.value.result });
          timings[branch.name] = outcome.value.durationMs;
        } else {
          const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          failed.push({ branch: branch.name, reason });
          timings[branch.name] = -1;
        }
      });

      return { ok, failed, timings, wallMs: now() - started };
    },

    /**
     * Compose a synthesis prompt from fan-out results for the finalize step.
     * Each branch contributes an attributed evidence block.
     */
    composeEvidence(fanout, { formatter } = {}) {
      const format = typeof formatter === "function" ? formatter : (result) => JSON.stringify(result).slice(0, 800);
      const blocks = [];
      for (const item of fanout.ok ?? []) {
        blocks.push(`## evidence:${item.branch}\n${format(item.result)}`);
      }
      for (const item of fanout.failed ?? []) {
        blocks.push(`## evidence:${item.branch} (FAILED: ${item.reason})\n- not available in this answer`);
      }
      return blocks.join("\n\n");
    },
  };
}
