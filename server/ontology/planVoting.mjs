/**
 * PlanVoting (P0-B3): execution-guided voting over multi-path candidates.
 * Executes all candidates via a governed executeFn, compares result signatures,
 * and returns UNANIMOUS / MAJORITY / DISAGREE.
 * DISAGREE → no winner: caller must clarify ("宁澄清不硬答" — Cortex/Genie philosophy).
 * A candidate's execution error excludes it from voting (recorded, not thrown).
 */

async function executeCandidate(candidate, executeFn) {
  try {
    const result = await executeFn(candidate.plan);
    return { candidate, result, error: null };
  } catch (err) {
    return { candidate, result: null, error: err?.message ?? String(err) };
  }
}

function resultSignature(result) {
  if (!result || typeof result !== "object") return null;
  return String(result.signature ?? JSON.stringify(result.rows ?? result));
}

export async function voteOnPlans({ candidates, executeFn } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error("PLAN_VOTING_INVALID: candidates required");
  }
  if (typeof executeFn !== "function") {
    throw new Error("PLAN_VOTING_INVALID: executeFn required");
  }

  const executions = [];
  for (const candidate of candidates) {
    executions.push(await executeCandidate(candidate, executeFn));
  }
  const ok = executions.filter((e) => !e.error);
  const errors = executions
    .filter((e) => e.error)
    .map((e) => ({ kind: e.candidate.kind, fingerprint: e.candidate.plan.executionFingerprint, error: e.error }));

  // Group agreeing executions by result signature.
  const groups = new Map(); // signature → { signature, members: [execution] }
  for (const execution of ok) {
    const sig = resultSignature(execution.result);
    if (sig === null) continue;
    if (!groups.has(sig)) groups.set(sig, { signature: sig, members: [] });
    groups.get(sig).members.push(execution);
  }

  const ranked = [...groups.values()].sort((a, b) => b.members.length - a.members.length);
  const best = ranked[0] ?? null;
  const executed = executions.length;

  const candidateDifferences = executions.map((e) => ({
    kind: e.candidate.kind,
    fingerprint: e.candidate.plan.executionFingerprint,
    signature: e.error ? `ERROR:${e.error}` : resultSignature(e.result),
    agreed: Boolean(best && !e.error && resultSignature(e.result) === best.signature),
  }));

  const evidence = {
    executed,
    agreeing: best ? best.members.length : 0,
    dissenters: best ? ok.length - best.members.length : ok.length,
    errors,
    groups: ranked.map((g) => ({ signature: g.signature, votes: g.members.length })),
    candidateDifferences,
  };

  // Verdict rules.
  if (!best || ok.length === 0) {
    return { verdict: "DISAGREE", winner: null, action: "clarify", evidence };
  }

  const totalVoters = ok.length;
  if (best.members.length === totalVoters) {
    return {
      verdict: "UNANIMOUS",
      winner: { ...best.members[0].candidate, result: best.members[0].result },
      action: "answer",
      evidence,
    };
  }

  if (best.members.length > totalVoters / 2) {
    return {
      verdict: "MAJORITY",
      winner: { ...best.members[0].candidate, result: best.members[0].result },
      action: "answer",
      evidence: {
        ...evidence,
        dissenters: candidateDifferences.filter((c) => !c.agreed && !c.signature.startsWith("ERROR:")),
      },
    };
  }

  // No majority group → disagreement; never pick arbitrarily.
  return { verdict: "DISAGREE", winner: null, action: "clarify", evidence };
}
