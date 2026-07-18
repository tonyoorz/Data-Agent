import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { GRAPH_DEFINITION_VERSION } from "../../server/agentRuntime/contracts.mjs";
import {
  FAKE_MODEL_FIXTURE_VERSION,
  FAKE_MODEL_ID,
  fetchWithTimeout,
  parseSseEvents,
  startLocalAgentHarness,
} from "./agentRuntimeHarness.mjs";

const TERMINAL_EVENT_TO_STATUS = Object.freeze({
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
});

const REGISTERED_TOOL_NAMES = new Set([
  "query_semantic_metrics",
  "query_semantic_records",
  "query_traceability",
  "query_dashboard_summary",
  "query_testing_coverage_project_status",
  "query_defect_high_frequency_analysis",
  "query_full_picture_module",
  "search_duplicates",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeErrorCode(value, fallback = "EVALUATOR_FAILED") {
  const raw = String(value || "");
  return /^[A-Z][A-Z0-9_:-]{2,79}$/.test(raw) ? raw : fallback;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function deepSubset(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item, index) => deepSubset(actual[index], item));
  }
  if (expected && typeof expected === "object") {
    return Boolean(actual) && typeof actual === "object" && Object.entries(expected)
      .every(([key, value]) => deepSubset(actual[key], value));
  }
  return Object.is(actual, expected);
}

function terminalEvents(events) {
  return events.filter((event) => TERMINAL_EVENT_TO_STATUS[event.type]);
}

function observationErrorCodes(observation) {
  return new Set([
    observation.httpError?.code,
    observation.run?.error?.code,
    ...observation.events
      .filter((event) => event.type === "run.failed" || event.type === "tool.failed")
      .map((event) => event.payload?.code),
  ].filter(Boolean).map((value) => safeErrorCode(value)));
}

function buildForbiddenCorpus(observation) {
  const values = [
    observation.answerText,
    ...observation.tools,
    ...observation.events.map((event) => event.type),
    ...observation.events.map((event) => event.payload?.code),
    ...observation.events.map((event) => event.payload?.safeMessage),
  ];
  return values.filter(Boolean).join("\n").toLowerCase();
}

function safeSemanticFrameSummary(frame) {
  if (!frame || typeof frame !== "object") return frame;
  return {
    ontologyVersion: frame.ontologyVersion,
    schemaFingerprint: frame.schemaFingerprint,
    intent: frame.intent,
    entityIds: frame.entityIds,
    metricIds: frame.metricIds,
    dimensionIds: frame.dimensionIds,
    timeFieldId: frame.time?.fieldId,
    ambiguityCodes: frame.ambiguities?.map((item) => item.code) || [],
  };
}

function safeQueryPlanSummary(plan) {
  if (!plan || typeof plan !== "object") return plan;
  return {
    planRef: plan.planId ? sha256(plan.planId).slice(0, 16) : undefined,
    version: plan.version,
    status: plan.status,
    stepCount: plan.steps?.length || 0,
    tools: plan.steps?.map((step) => step.toolName) || [],
  };
}

function safeModelTurnSummaries(turns) {
  return (turns || []).map((turn) => ({
    turnRef: turn.turnId ? sha256(turn.turnId).slice(0, 16) : undefined,
    purpose: turn.purpose,
    modelId: turn.modelId,
    status: turn.status,
    finishReason: turn.finishReason,
    usage: turn.usage,
  }));
}

function pushAssertion(assertions, key, pass, expected, actual, message) {
  assertions.push({ key, pass: Boolean(pass), expected, actual, ...(message ? { message } : {}) });
}

function assertExpected(observation, expected, assertions) {
  const errorCodes = observationErrorCodes(observation);
  for (const [key, expectedValue] of Object.entries(expected || {})) {
    if (key === "terminal") {
      pushAssertion(assertions, key, observation.terminal === expectedValue, expectedValue, observation.terminal);
      continue;
    }
    if (key === "events") {
      const missing = expectedValue.filter((type) => !observation.eventTypes.includes(type));
      pushAssertion(assertions, key, missing.length === 0, expectedValue, observation.eventTypes, missing.length ? `Missing events: ${missing.join(", ")}` : undefined);
      continue;
    }
    if (key === "tool") {
      pushAssertion(assertions, key, observation.tools.includes(expectedValue), expectedValue, observation.tools);
      continue;
    }
    if (key === "modelInvoked") {
      const actual = observation.modelInvocations > 0;
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }
    if (key === "tokens") {
      const corpus = `${observation.answerText}\n${stableJson(observation.events.map((event) => event.payload))}`;
      const missing = expectedValue.filter((token) => !corpus.includes(String(token)));
      pushAssertion(assertions, key, missing.length === 0, expectedValue, missing.length ? { missing } : expectedValue);
      continue;
    }
    if (key === "grounding") {
      const actual = observation.run?.answer?.groundingStatus
        || observation.graphState?.answer?.groundingStatus
        || observation.answerMetadata?.groundingStatus
        || observation.graphState?.evidence?.[0]?.quality?.groundingStatus;
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }
    if (key === "missingness") {
      const actual = observation.graphState?.evidence?.map((item) => item.quality?.missingness) || [];
      pushAssertion(assertions, key, actual.includes(expectedValue), expectedValue, actual);
      continue;
    }
    if (key === "evidenceType") {
      const actual = observation.graphState?.evidence?.map((item) => item.evidenceType) || [];
      pushAssertion(assertions, key, actual.includes(expectedValue), expectedValue, actual);
      continue;
    }
    if (key === "limitations") {
      const actual = observation.run?.answer?.limitations || observation.graphState?.answer?.limitations || observation.answerMetadata?.limitations || [];
      const pass = typeof expectedValue === "boolean" ? (actual.length > 0) === expectedValue : deepSubset(actual, expectedValue);
      pushAssertion(assertions, key, pass, expectedValue, { count: actual.length });
      continue;
    }
    if (key === "evidenceCoverage") {
      const claims = observation.graphState?.claims || [];
      const accepted = new Set(observation.graphState?.claimValidation?.acceptedClaimIds || []);
      const metadataAccepted = observation.answerMetadata?.acceptedClaimIds || [];
      const citedClaims = new Set((observation.answerMetadata?.citations || []).flatMap((citation) => citation.claimIds || []));
      const actual = claims.length
        ? [...accepted].every((claimId) => Boolean(claims.find((item) => item.claimId === claimId)?.evidenceIds?.length))
        : metadataAccepted.every((claimId) => citedClaims.has(claimId));
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }
    if (key === "derivedClaim") {
      const accepted = new Set(observation.graphState?.claimValidation?.acceptedClaimIds || []);
      const actual = (observation.graphState?.claims || []).some((claim) => claim.type === "derived" && claim.derivation?.formula && accepted.has(claim.claimId));
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }
    if (key === "citationCoverage") {
      const answer = observation.run?.answer || observation.graphState?.answer || observation.answerMetadata || {};
      const accepted = answer.acceptedClaimIds || [];
      const cited = new Set((answer.citations || []).flatMap((citation) => citation.claimIds || []));
      const actual = accepted.length > 0 && accepted.every((claimId) => cited.has(claimId));
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }
    if (key === "denial" || key === "code") {
      pushAssertion(assertions, key, errorCodes.has(String(expectedValue)), expectedValue, [...errorCodes]);
      continue;
    }
    if (key === "runCount") {
      pushAssertion(assertions, key, observation.runCount === expectedValue, expectedValue, observation.runCount);
      continue;
    }
    if (key === "terminalEventCount") {
      pushAssertion(assertions, key, observation.terminalEventCount === expectedValue, expectedValue, observation.terminalEventCount);
      continue;
    }
    if (key === "semanticFrame") {
      pushAssertion(
        assertions,
        key,
        deepSubset(observation.graphState?.semanticFrame, expectedValue),
        expectedValue,
        safeSemanticFrameSummary(observation.graphState?.semanticFrame),
      );
      continue;
    }
    if (key === "queryPlan") {
      pushAssertion(
        assertions,
        key,
        deepSubset(observation.graphState?.plan, expectedValue),
        expectedValue,
        safeQueryPlanSummary(observation.graphState?.plan),
      );
      continue;
    }
    if (key === "dedupe") {
      const actual = observation.duplicateEventCount === 0;
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }
    if (key === "authorizedEventsOnly") {
      const actual = observation.crossActorLeakage === 0;
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }
    if (key === "auditRedacted") {
      const corpus = stableJson(observation.events);
      const actual = !/(access.?code|credential|cookie)/i.test(corpus);
      pushAssertion(assertions, key, actual === expectedValue, expectedValue, actual);
      continue;
    }

    pushAssertion(assertions, key, false, { configured: true }, { observable: false }, `Unsupported expectation key '${key}'`);
  }
}

function assertForbidden(observation, forbidden, assertions) {
  const corpus = buildForbiddenCorpus(observation);
  for (const value of forbidden || []) {
    const found = corpus.includes(String(value).toLowerCase());
    pushAssertion(assertions, `forbidden:${value}`, !found, false, found, found ? `Forbidden marker observed: ${value}` : undefined);
  }
}

export function loadEvalSuite(suitePath, schemaPath = "evals/main-agent/schema/eval-case.schema.json") {
  const raw = fs.readFileSync(suitePath, "utf8");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const cases = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`INVALID_EVAL_JSON:${suitePath}:${index + 1}:${error.message}`);
    }
    if (!validate(parsed)) {
      throw new Error(`INVALID_EVAL_CASE:${parsed?.case_id || index + 1}:${ajv.errorsText(validate.errors)}`);
    }
    return parsed;
  });
  if (cases.length === 0) throw new Error(`EMPTY_EVAL_SUITE:${suitePath}`);
  const ids = cases.map((item) => item.case_id);
  if (new Set(ids).size !== ids.length) throw new Error(`DUPLICATE_EVAL_CASE_ID:${suitePath}`);
  return { cases, raw, fingerprint: sha256(raw) };
}

export async function executeHttpEvalCase(caseDefinition, {
  baseUrl,
  harness,
  timeoutMs = 10000,
  sequence = 0,
  model = FAKE_MODEL_ID,
  requestHeaders = {},
} = {}) {
  harness?.setCase(caseDefinition);
  const startedAt = Date.now();
  const callOffset = harness?.calls.length || 0;
  const requestBody = {
    schemaVersion: "1.0",
    messageId: `eval-${caseDefinition.case_id}-${sequence}`,
    threadVersion: 0,
    message: {
      role: "user",
      text: String(caseDefinition.request?.text || ""),
      artifactRefs: caseDefinition.request?.artifactRefs || [],
    },
    selectedModel: String(model || caseDefinition.request?.selectedModel || FAKE_MODEL_ID),
    useDefectContext: caseDefinition.request?.useDefectContext === true,
    useAnalyticsContext: caseDefinition.request?.useAnalyticsContext === true,
    eventProtocolVersion: "1.0",
  };
  let startedBody;
  let httpError;
  let events = [];

  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/agent/runs`, {
      method: "POST",
      redirect: "error",
      headers: { ...requestHeaders, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(requestBody),
    }, timeoutMs);
    startedBody = await response.json();
    if (response.status !== 202) {
      httpError = { status: response.status, ...startedBody };
    } else {
      const streamResponse = await fetchWithTimeout(`${baseUrl}${startedBody.eventsUrl}?follow=1`, {
        redirect: "error",
        headers: { ...requestHeaders, accept: 'text/event-stream; profile="agent-v1"' },
      }, timeoutMs);
      if (!streamResponse.ok) {
        httpError = { status: streamResponse.status, ...(await streamResponse.json()) };
      } else {
        events = parseSseEvents(await streamResponse.text());
      }
    }
  } catch (error) {
    httpError = { code: error?.name === "AbortError" ? "REQUEST_TIMEOUT" : String(error?.code || error?.message || "EVAL_REQUEST_FAILED") };
  }

  const runId = startedBody?.runId;
  let run;
  let graphState;
  if (runId && harness) {
    try {
      run = harness.deps.threadStore.getRun({ actor: harness.actor, runId });
      graphState = harness.states.get(runId);
    } catch (error) {
      httpError ||= { code: String(error?.code || error?.message || "RUN_OBSERVATION_FAILED") };
    }
  }
  const terminals = terminalEvents(events);
  const uniqueEventIds = new Set(events.map((event) => event.eventId).filter(Boolean));
  const tools = events.filter((event) => event.type === "tool.started").map((event) => event.payload?.toolName).filter(Boolean);
  const modelInvocations = events.filter((event) => event.type === "model.completed").length;
  const firstAnswerIndex = events.findIndex((event) => event.type === "answer.delta");
  const toolStartedBeforeAnswer = firstAnswerIndex >= 0 && events.slice(0, firstAnswerIndex).some((event) => event.type === "tool.started");
  const toolCompletedBeforeAnswer = firstAnswerIndex >= 0 && events.slice(0, firstAnswerIndex).some((event) => event.type === "tool.completed" || event.type === "tool.failed");
  const eventAnswer = events.filter((event) => event.type === "answer.delta").map((event) => event.payload?.text || "").join("");
  const answerMetadata = events.find((event) => event.type === "answer.completed")?.payload;

  return {
    caseId: caseDefinition.case_id,
    runId,
    threadId: startedBody?.threadId,
    runCount: startedBody?.runId ? 1 : 0,
    durationMs: Date.now() - startedAt,
    request: requestBody,
    httpError,
    events,
    eventTypes: events.map((event) => event.type),
    terminal: terminals.length ? TERMINAL_EVENT_TO_STATUS[terminals.at(-1).type] : run?.status,
    terminalEventCount: terminals.length,
    duplicateEventCount: Math.max(0, events.filter((event) => event.eventId).length - uniqueEventIds.size),
    crossActorLeakage: events.filter((event) => runId && event.runId !== runId).length,
    unsupportedTools: tools.filter((name) => !REGISTERED_TOOL_NAMES.has(name)),
    earlyAnswerBytes: toolStartedBeforeAnswer && !toolCompletedBeforeAnswer ? Buffer.byteLength(eventAnswer, "utf8") : 0,
    tools,
    modelInvocations,
    toolCalls: harness ? harness.calls.slice(callOffset) : [],
    answerText: run?.answer?.text || graphState?.answer?.text || eventAnswer,
    answerMetadata,
    run,
    graphState,
  };
}

function summarizeObservation(observation) {
  const answer = observation.run?.answer || observation.graphState?.answer || observation.answerMetadata || {};
  const semanticFrame = observation.graphState?.semanticFrame;
  const queryPlan = observation.graphState?.plan;
  return {
    runRef: observation.runId ? sha256(observation.runId).slice(0, 16) : undefined,
    threadRef: observation.threadId ? sha256(observation.threadId).slice(0, 16) : undefined,
    durationMs: observation.durationMs,
    terminal: observation.terminal,
    terminalEventCount: observation.terminalEventCount,
    eventTypes: observation.eventTypes,
    tools: observation.tools,
    modelInvocations: observation.modelInvocations,
    modelTurns: safeModelTurnSummaries(observation.graphState?.modelTurns),
    answer: {
      contentHash: answer.contentHash || (observation.answerText ? sha256(observation.answerText) : undefined),
      groundingStatus: answer.groundingStatus,
      acceptedClaimCount: answer.acceptedClaimIds?.length || 0,
      citationCount: answer.citations?.length || 0,
      assumptionCount: answer.assumptions?.length || 0,
      limitationCount: answer.limitations?.length || 0,
    },
    semanticFrame: safeSemanticFrameSummary(semanticFrame),
    queryPlan: safeQueryPlanSummary(queryPlan),
    evidenceCount: observation.graphState?.evidence?.length || 0,
    claimCount: observation.graphState?.claims?.length || 0,
    acceptedClaimCount: observation.graphState?.claimValidation?.acceptedClaimIds?.length || answer.acceptedClaimIds?.length || 0,
    httpError: observation.httpError ? { status: observation.httpError.status, code: safeErrorCode(observation.httpError.code, "EVAL_REQUEST_FAILED") } : undefined,
    duplicateEventCount: observation.duplicateEventCount,
    crossActorLeakage: observation.crossActorLeakage,
    unsupportedTools: observation.unsupportedTools,
    earlyAnswerBytes: observation.earlyAnswerBytes,
  };
}

function hardGatesFrom(observations) {
  const terminalCases = observations.filter((item) => item.terminalEventCount === 1).length;
  const plannerModelCases = observations.filter((item) => item.modelInvocations > 0).length;
  return {
    terminalEventCoverage: observations.length ? terminalCases / observations.length : 0,
    plannerModelCoverage: observations.length ? plannerModelCases / observations.length : 0,
    crossActorLeakage: observations.reduce((sum, item) => sum + item.crossActorLeakage, 0),
    unsupportedTools: observations.reduce((sum, item) => sum + item.unsupportedTools.length, 0),
    earlyAnswerBytes: observations.reduce((sum, item) => sum + item.earlyAnswerBytes, 0),
    duplicateTerminalEvents: observations.reduce((sum, item) => sum + Math.max(0, item.terminalEventCount - 1), 0),
  };
}

function hardGatesPass(gates) {
  return gates.terminalEventCoverage === 1
    && gates.plannerModelCoverage === 1
    && gates.crossActorLeakage === 0
    && gates.unsupportedTools === 0
    && gates.earlyAnswerBytes === 0
    && gates.duplicateTerminalEvents === 0;
}

export async function evaluateCases(cases, {
  executeCase,
  suite,
  suiteFingerprint,
  mode = "langgraph",
  model = FAKE_MODEL_ID,
  qualification = "baseline",
  ontologyFingerprint = "legacy-v0",
} = {}) {
  if (typeof executeCase !== "function") throw new Error("EVAL_EXECUTE_CASE_REQUIRED");
  const caseResults = [];
  const observations = [];
  for (const [index, caseDefinition] of cases.entries()) {
    let observation;
    try {
      observation = await executeCase(caseDefinition, index);
    } catch (error) {
      observation = {
        caseId: caseDefinition.case_id,
        durationMs: 0,
        events: [],
        eventTypes: [],
        tools: [],
        modelInvocations: 0,
        terminalEventCount: 0,
        duplicateEventCount: 0,
        crossActorLeakage: 0,
        unsupportedTools: [],
        earlyAnswerBytes: 0,
        httpError: { code: safeErrorCode(error?.code, "EVAL_CASE_CRASHED") },
      };
    }
    observations.push(observation);
    const assertions = [];
    assertExpected(observation, caseDefinition.expected, assertions);
    assertForbidden(observation, caseDefinition.forbidden, assertions);
    caseResults.push({
      caseId: caseDefinition.case_id,
      group: caseDefinition.group,
      language: caseDefinition.language,
      passed: assertions.every((assertion) => assertion.pass),
      assertions,
      observation: summarizeObservation(observation),
    });
  }

  const hardGates = hardGatesFrom(observations);
  const failedCaseIds = caseResults.filter((item) => !item.passed).map((item) => item.caseId);
  const report = {
    schemaVersion: "2.0",
    generatedAt: new Date().toISOString(),
    suite,
    suiteFingerprint,
    mode,
    model,
    modelFixtureVersion: model === FAKE_MODEL_ID ? FAKE_MODEL_FIXTURE_VERSION : "external-certified",
    qualification,
    ontologyFingerprint,
    graphDefinitionVersion: GRAPH_DEFINITION_VERSION,
    caseCount: cases.length,
    passedCaseCount: cases.length - failedCaseIds.length,
    failedCaseCount: failedCaseIds.length,
    failedCaseIds,
    hardGates,
    hardGatesPassed: hardGatesPass(hardGates),
    passed: failedCaseIds.length === 0 && hardGatesPass(hardGates),
    cases: caseResults,
    environment: {
      node: process.version,
      platform: process.platform,
      cpus: os.cpus().length,
      memoryBytes: os.totalmem(),
    },
  };
  return report;
}

function readOntologyFingerprint(repoRoot) {
  const fingerprintPath = path.join(repoRoot, "ontology/generated/fingerprint.txt");
  return fs.existsSync(fingerprintPath) ? fs.readFileSync(fingerprintPath, "utf8").trim() : "legacy-v0";
}

export async function evaluateSuite({
  suitePath,
  schemaPath = "evals/main-agent/schema/eval-case.schema.json",
  baseUrl,
  timeoutMs = 10000,
  mode = "langgraph",
  model = FAKE_MODEL_ID,
  requestHeaders,
  qualification = "baseline",
} = {}) {
  const loaded = loadEvalSuite(suitePath, schemaPath);
  const repoRoot = process.cwd();
  const harness = baseUrl ? null : await startLocalAgentHarness({
    policyOptions: { runStartRatePerMinute: 6000, runStartBurst: Math.max(100, loaded.cases.length + 1) },
  });
  try {
    return await evaluateCases(loaded.cases, {
      suite: suitePath,
      suiteFingerprint: loaded.fingerprint,
      mode,
      model,
      qualification,
      ontologyFingerprint: readOntologyFingerprint(repoRoot),
      executeCase: (caseDefinition, index) => executeHttpEvalCase(caseDefinition, {
        baseUrl: baseUrl || harness.baseUrl,
        harness,
        timeoutMs,
        sequence: index,
        model,
        requestHeaders,
      }),
    });
  } finally {
    await harness?.cleanup();
  }
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function reportToJunit(report) {
  const testCases = report.cases.map((item) => {
    const failures = item.assertions.filter((assertion) => !assertion.pass);
    const failureXml = failures.length
      ? `<failure message="${xmlEscape(failures.map((failure) => failure.key).join(", "))}">${xmlEscape(stableJson(failures))}</failure>`
      : "";
    return `<testcase classname="main-agent.${xmlEscape(item.group)}" name="${xmlEscape(item.caseId)}">${failureXml}</testcase>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="main-agent" tests="${report.caseCount}" failures="${report.failedCaseCount}">${testCases}</testsuite>\n`;
}
