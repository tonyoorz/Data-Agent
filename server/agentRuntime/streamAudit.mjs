function normalizedFailureCode(value) {
  const code = String(value || "").trim();
  return /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(code) ? code : "";
}

export function buildAgentStreamAuditEvent(completed = {}) {
  const terminalStatus = String(completed?.terminal?.status
    || (completed?.answerValidation?.valid === false ? "blocked" : "completed"));
  const failureCode = normalizedFailureCode(completed?.terminal?.code || completed?.streamMetrics?.failureCode);
  return {
    runId: completed.runtimeResult?.runId || "",
    threadId: completed.runtimeResult?.threadId || "",
    actorScope: completed.runtimeResult?.actorScope || {},
    type: "agent-stream-completed",
    terminalStatus,
    ...(failureCode ? { failureCode } : {}),
    ...(Number.isFinite(Number(completed.streamMetrics?.streamTotalMs))
      ? { latencyMs: Number(completed.streamMetrics.streamTotalMs) }
      : {}),
    citationValidation: completed.answerValidation
      ? completed.answerValidation.valid ? "pass" : "blocked"
      : "not_required",
    ...(completed.answerValidation?.violations?.length
      ? { answerValidationViolations: completed.answerValidation.violations.map(String) }
      : {}),
  };
}
