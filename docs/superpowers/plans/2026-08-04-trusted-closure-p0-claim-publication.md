# Trusted Closure P0.3 Claim Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unsupported governed semantic numerical, record-ID, and causal claims from reaching SSE, while preserving direct streaming when no governed semantic evidence exists.

**Architecture:** Semantic tool evidence carries the returned `data` rows in memory with its provenance envelope. The final model's sanitized SSE payloads are buffered only when the LangGraph handler supplies governed semantic evidence. At terminal completion, a deterministic validator compares each cited numeric value and record identifier with its cited evidence, blocks causal language, and releases either the buffered payloads or a fixed safe fallback after emitting `answer-validation`.

**Tech Stack:** Node.js ESM, LangGraph, Vitest, existing SSE sanitizer and ontology registry.

---

## Task 1: Define Claim-to-Evidence Regression Tests

**Files:**

- Modify: `src/test/server/answerValidator.test.ts`
- Modify: `src/test/server/mainAgentEvidence.test.ts`
- Modify: `src/test/server/companyChat.test.ts`
- Modify: `src/test/server/agentRuntime/langGraphChatHandler.test.ts`

- [x] **Step 1: Write failing validator cases for supported and unsupported claims**

```ts
const semanticEvidence = [{
  toolCallId: "call-1",
  tool: "query_semantic_metrics",
  ontologyVersion: "v1",
  schemaFingerprint: registry.fingerprint,
  evidence: { kind: "semantic_metric_result", metricValues: { "defect.count": 1 } },
  data: [{ "product.ecu": "HU", "defect.count": 1, defect_id: "D-1" }],
}];

expect(validateAnswerTextCitations({
  text: '<cite source="call-1">缺陷数是 999999</cite>',
  evidence: semanticEvidence,
  registry,
  evidenceGate: { status: "pass" },
})).toMatchObject({ valid: false, violations: ["ANSWER_NUMERIC_CLAIM_UNSUPPORTED:call-1"] });

expect(validateAnswerTextCitations({
  text: '<cite source="call-1">缺陷数是 1，记录为 D-1</cite>',
  evidence: semanticEvidence,
  registry,
  evidenceGate: { status: "pass" },
})).toEqual({ valid: true, violations: [] });
```

Also cover an uncited number, an unknown record ID, a causal phrase, and a blocked upstream evidence gate.

- [x] **Step 2: Write a failing evidence-envelope test**

```ts
expect(buildToolEvidence({ toolCall, result, intent: "metric_query" })).toMatchObject({
  data: [{ defect_id: "D-1", "defect.count": 1 }],
});
```

- [x] **Step 3: Replace the informational streaming test with publication-gate tests**

```ts
expect(streamedText).not.toContain("999999");
expect(streamedText).toContain("未发布未经证据验证的数据结论");
expect(streamedText.indexOf('"type":"answer-validation"')).toBeLessThan(streamedText.indexOf("未发布未经证据验证的数据结论"));
```

Add a valid cited response whose validation event precedes its released `1` claim. Keep the pre-existing no-evidence streaming test unchanged.

- [x] **Step 4: Make handler plumbing fail explicitly**

```ts
expect(streamCompletion).toHaveBeenCalledWith(expect.objectContaining({
  answerValidation: expect.objectContaining({ evidenceGate: expect.objectContaining({ status: "pass" }) }),
}));
```

- [x] **Step 5: Run the focused suite and confirm RED**

Run:

```powershell
npm test -- --run src/test/server/answerValidator.test.ts src/test/server/mainAgentEvidence.test.ts src/test/server/companyChat.test.ts src/test/server/agentRuntime/langGraphChatHandler.test.ts
```

Expected: numerical/record validation is absent, tool evidence lacks `data`, invalid text is still streamed, and handler lacks `evidenceGate` plumbing.

## Task 2: Extend the Deterministic Claim Validator

**Files:**

- Modify: `server/answerValidator.mjs`
- Modify: `server/mainAgentEvidence.mjs`
- Test: `src/test/server/answerValidator.test.ts`
- Test: `src/test/server/mainAgentEvidence.test.ts`

- [x] **Step 1: Preserve semantic result rows in tool evidence**

```js
return compactObject({
  // Existing provenance fields.
  data: Array.isArray(body?.data) ? body.data : undefined,
  pagination: body?.pagination,
});
```

Only the in-process evidence envelope changes; no new API response field is introduced.

- [x] **Step 2: Parse complete citation claims and evidence scalars**

```js
export function extractCitationClaims(text) {
  // Return [{ toolCallId, text }] only for complete <cite source="...">...</cite> spans.
}
```

Collect normalized numeric scalars and stable identifier-shaped strings from each cited evidence item's `evidence`, `summary`, `data`, and `pagination` fields. Do not mine arbitrary revision strings or tool-call IDs as evidence.

- [x] **Step 3: Extend `validateAnswerTextCitations()`**

```js
const validation = validateAnswerContract({ answer, evidence, registry });
// Reject numeric text outside complete citations, cited numeric values absent from that citation's evidence,
// cited record identifiers absent from that citation's rows, and causal wording.
// For evidenceGate.status === "blocked", allow only a non-numeric, non-record, non-causal limitation response.
return { valid: violations.length === 0, violations: uniqueViolations };
```

Use stable violation IDs: `ANSWER_NUMERIC_CLAIM_UNCITED`, `ANSWER_NUMERIC_CLAIM_UNSUPPORTED:<toolCallId>`, `ANSWER_RECORD_CLAIM_UNSUPPORTED:<toolCallId>`, `ANSWER_CAUSAL_CLAIM_UNSUPPORTED`, and `ANSWER_SEMANTIC_EVIDENCE_BLOCKED`. Do not echo rejected model values or record identifiers.

- [x] **Step 4: Run validator and evidence tests to confirm GREEN**

Run:

```powershell
npm test -- --run src/test/server/answerValidator.test.ts src/test/server/mainAgentEvidence.test.ts
```

Expected: valid cited claims pass; mismatched, uncited, unknown-record, causal, and blocked-evidence claims fail.

## Task 3: Gate Final SSE Publication

**Files:**

- Modify: `server/companyChat.mjs`
- Modify: `server/agentRuntime/langGraphChatHandler.mjs`
- Modify: `src/test/server/companyChat.test.ts`
- Modify: `src/test/server/agentRuntime/langGraphChatHandler.test.ts`

- [x] **Step 1: Pass only governed semantic evidence and its evidence-gate status to the final stream**

```js
const semanticEvidence = evidence.filter((item) => ["query_semantic_metrics", "query_semantic_records"].includes(item?.tool));
return semanticEvidence.length ? { semanticEvidence, registry, evidenceGate } : undefined;
```

The handler must leave legacy-only tool answers on the existing ungated path until tool convergence moves them behind the Semantic Kernel.

- [x] **Step 2: Buffer sanitized final payloads only in governed mode**

```js
const gateEnabled = Boolean(answerValidation?.semanticEvidence?.length);
// Sanitizer records visible text in both modes.
// In gateEnabled mode it stores sanitized payloads, rather than calling writeSseEvent immediately.
```

Keep preface tool events streaming immediately. Limit the buffered visible answer to 64 KiB; overflow is a validation failure and must produce the safe fallback.

- [x] **Step 3: Validate before publishing final content**

```js
const validation = validateAnswerTextCitations({
  text: state.visibleContentParts.join(""),
  evidence: answerValidation.semanticEvidence,
  registry: answerValidation.registry,
  evidenceGate: answerValidation.evidenceGate,
});

writeSseEvent(response, { type: "answer-validation", ...validation });
if (validation.valid) publishBufferedPayloads();
else writeSseEvent(response, { choices: [{ delta: { content: "系统未发布未经证据验证的数据结论。请缩小查询范围后重试。" } }] });
```

Write `[DONE]` only after validation and either buffered output or the safe fallback. Preserve the current direct upstream forwarding path when no semantic evidence is supplied.

- [x] **Step 4: Run streaming and handler tests to confirm GREEN**

Run:

```powershell
npm test -- --run src/test/server/companyChat.test.ts src/test/server/agentRuntime/langGraphChatHandler.test.ts
```

Expected: invalid claims never reach streamed content; valid claims are released after their validation event; no-evidence streaming still forwards chunks.

## Task 4: Verify the Claim Publication Slice

**Files:**

- Test: `src/test/server/answerValidator.test.ts`
- Test: `src/test/server/mainAgentEvidence.test.ts`
- Test: `src/test/server/companyChat.test.ts`
- Test: `src/test/server/agentRuntime/langGraphChatHandler.test.ts`
- Test: `src/test/server/semanticAnalysisClosure.e2e.test.ts`

- [x] **Step 1: Run the P0 Claim gate regression slice**

Run:

```powershell
npm test -- --run src/test/server/answerValidator.test.ts src/test/server/mainAgentEvidence.test.ts src/test/server/companyChat.test.ts src/test/server/agentRuntime/langGraphChatHandler.test.ts src/test/server/semanticAnalysisClosure.e2e.test.ts
```

Expected: all tests pass, including same-snapshot aggregate-to-records evidence and pre-publication validation.

- [x] **Step 2: Run lint, syntax, and diff checks**

Run:

```powershell
npm run lint -- --quiet
node --check server/answerValidator.mjs
node --check server/mainAgentEvidence.mjs
node --check server/companyChat.mjs
node --check server/agentRuntime/langGraphChatHandler.mjs
git diff --check
```

Expected: no lint or syntax errors, no whitespace errors, and no unplanned files.

### Scope Boundaries

- Do not claim arbitrary natural-language facts are verified; this gate covers governed semantic numeric values, stable record identifiers, citations, and causal wording.
- Do not stream governed final-answer text before validation; buffering is intentional and limited to 64 KiB.
- Do not migrate legacy analytics tools in this slice; their model visibility is handled by the separate tool-convergence P0 task.
- Do not add a second model call, structured-output parser service, or online multi-agent layer.
