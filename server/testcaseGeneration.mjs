// Test-case generation pipeline: closed-loop, two-stage generation.
//
// Stage 1 derives a machine-checkable test design model (equivalence classes /
// boundaries / combinations) from the defect + verified context. Stage 2 writes the
// test case against that model. The loop then runs: verify (heuristics, incl.
// model_coverage in the Python verifier) → judge (LLM) → regenerate with feedback,
// up to TESTCASE_MAX_GENERATION_ROUNDS (default 3).
//
// Every stage-1 failure degrades silently to the single-stage P0 behavior.

import { resolveChatModelConfig } from "./chatModelConfig.mjs";
import { callChatCompletion } from "./chatCompletionClient.mjs";
import { parseModelJson } from "./modelJson.mjs";
import { judgeTestCase, resolveJudgeModel } from "./testCaseJudge.mjs";
import { buildTestModel, computeModelCoverage, formatTestModelForPrompt, testModelEnabled } from "./testModel.mjs";

const GENERATION_TIMEOUT_MS = 120000;

const SYSTEM_PROMPT_BASE = [
  "You are a test case generator for BMW ALM Octane (workspace 1002/2001).",
  "Generate a structured manual test case (test_manual) from a defect's reproduction information.",
  "",
  "Output format — return a JSON object with exactly these fields:",
  '{"testName": "[project][SW] Regression - short summary (D<defect_id>)", "descriptionHtml": "<html><body>...</body></html>", "stepsText": "- [PreCon] ...\\n- action step\\n- ? checkpoint"}',
  "",
  "Description HTML sections: Objective, Reference (defect link), Preconditions, baseline/regression tables (if quantitative data), pass/fail criteria.",
  "Steps text format: one step per line, prefixed by kind: '- [PreCon] <text>' (precondition), '- <text>' (action step), '- ? <text>' (checkpoint/expected result).",
  "Do NOT put the procedure in the description — it goes in stepsText only.",
  "Checkpoints must have specific values/thresholds (numbers, percentages), not vague 'check it works'.",
  "Ground every factual claim (signal names, thresholds, build IDs, tools) in the defect info or the verified business context — never invent values.",
];

const SYSTEM_PROMPT_MODEL_SUFFIX = [
  "",
  "When a test design model is provided, additionally return the field",
  '"combinationCoverage": an array of the combination ids your checkpoints actually cover.',
  "Every combination listed in the model MUST be covered by at least one checkpoint.",
];

function systemPromptFor(testModelText) {
  return (testModelText ? [...SYSTEM_PROMPT_BASE, ...SYSTEM_PROMPT_MODEL_SUFFIX] : SYSTEM_PROMPT_BASE).join("\n");
}

export function resolveMaxGenerationRounds(env = process.env) {
  const parsed = Number.parseInt(String(env.TESTCASE_MAX_GENERATION_ROUNDS || "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.min(5, Math.max(1, parsed));
}

function buildUserPrompt({ defectInfo, fewShotText, contextText, testModelText, previousAttempt, feedback }) {
  const lines = [
    `Defect ID: ${defectInfo.defect_id}`,
    `Name: ${defectInfo.name}`,
    `Severity: ${defectInfo.severity}`,
    `Software: ${defectInfo.software_version}`,
    `ECU: ${defectInfo.assigned_ecu}`,
    `Lead model: ${defectInfo.lead_model}`,
    `Project: ${defectInfo.project}`,
    "",
    "Defect description:",
    defectInfo.description?.slice(0, 3000) || "(no description)",
  ];

  if (contextText) {
    lines.push("", "Verified business context (factual background — ground your test in it):", contextText);
  }
  if (testModelText) {
    lines.push("", testModelText);
  }
  if (fewShotText) {
    lines.push("", `Reference test cases (style/structure examples):\n${fewShotText}`);
  }

  if (previousAttempt && feedback) {
    lines.push(
      "",
      "QUALITY FEEDBACK — your previous draft failed automated quality checks:",
      feedback,
      "",
      "Previous draft:",
      `testName: ${previousAttempt.testName}`,
      "stepsText:",
      previousAttempt.stepsText,
      "",
      "Rewrite the test case and fix every issue listed above. Keep what was already correct.",
    );
  }

  lines.push("", "Generate the test case now. Return ONLY the JSON object, no markdown code fence.");
  return lines.join("\n");
}

function sanitizeCombinationCoverage(value) {
  if (!Array.isArray(value)) return [];
  return value.map((id) => String(id || "").trim()).filter(Boolean).slice(0, 50);
}

export async function generateTestCaseContent({
  defectInfo,
  fewShotText = "",
  contextText = "",
  testModelText = "",
  chatConfig,
  previousAttempt = null,
  feedback = "",
  env = process.env,
  fetchImpl = fetch,
}) {
  if (!chatConfig?.credential) {
    throw new Error("LLM credentials not configured — set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY");
  }

  const messages = [
    { role: "system", content: systemPromptFor(testModelText) },
    { role: "user", content: buildUserPrompt({ defectInfo, fewShotText, contextText, testModelText, previousAttempt, feedback }) },
  ];

  let content = await callChatCompletion({ messages, chatConfig, env, fetchImpl, timeoutMs: GENERATION_TIMEOUT_MS });
  let parsed = parseModelJson(content);

  if (!parsed) {
    // One repair retry: the model wrapped or broke the JSON — ask it to return valid JSON only.
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: "Your previous reply was not a valid JSON object. Return ONLY the JSON object with fields testName, descriptionHtml, stepsText (and combinationCoverage when a test design model was provided) — no prose, no markdown fences.",
    });
    content = await callChatCompletion({ messages, chatConfig, env, fetchImpl, timeoutMs: GENERATION_TIMEOUT_MS });
    parsed = parseModelJson(content);
    if (!parsed) {
      throw new Error("LLM did not return a JSON object");
    }
  }

  return {
    testName: String(
      parsed.testName || `[${defectInfo.project}] Regression - ${defectInfo.name?.slice(0, 60)} (D${defectInfo.defect_id})`,
    ),
    descriptionHtml: String(parsed.descriptionHtml || ""),
    stepsText: String(parsed.stepsText || ""),
    combinationCoverage: sanitizeCombinationCoverage(parsed.combinationCoverage),
  };
}

function buildHistoryEntry(round, verification, judge) {
  const heuristicPassed = Boolean(verification?.passed);
  const judgeSkipped = Boolean(judge?.skipped);
  const judgePassed = judgeSkipped ? null : Boolean(judge?.passed);
  const failedCriteria = [
    ...(verification?.criteria || []).filter((c) => c && !c.passed).map((c) => c.name),
    ...(judge?.criteria || []).filter((c) => c && !c.passed).map((c) => c.name),
  ];
  return { round, heuristicPassed, judgePassed, judgeSkipped, failedCriteria };
}

export async function runTestCaseGenerationPipeline({
  runTestCaseBridge,
  defectId,
  env = process.env,
  fetchImpl = fetch,
  judgeFn = judgeTestCase,
  generateFn = generateTestCaseContent,
  buildModelFn = buildTestModel,
  maxRounds: maxRoundsOverride,
}) {
  // Step 1: Python bridge — defect + full-body RAG few-shot + ontology context
  const prepared = await runTestCaseBridge({ action: "prepare", defect_id: defectId });
  if (!prepared?.success || !prepared?.defect_info) {
    const error = new Error(prepared?.error || "failed to prepare defect");
    error.code = "TESTCASE_PREPARE_FAILED";
    throw error;
  }

  const defectInfo = prepared.defect_info;
  const fewShotText = prepared.few_shot_text || "";
  const contextText = prepared.context_text || "";

  const generatorConfig = resolveChatModelConfig(undefined, env);
  const judgeConfig = resolveChatModelConfig(resolveJudgeModel(generatorConfig.model, env), env);
  const envMaxRounds = resolveMaxGenerationRounds(env);
  const maxRounds = Number.isFinite(maxRoundsOverride)
    ? Math.min(envMaxRounds, Math.max(1, Math.round(maxRoundsOverride)))
    : envMaxRounds;

  // Step 2: stage-1 test design model (equivalence classes / boundaries / combinations).
  // Best-effort — any failure degrades to single-stage generation.
  let testModel = null;
  if (testModelEnabled(env)) {
    try {
      testModel = await buildModelFn({ defectInfo, contextText, fewShotText, chatConfig: generatorConfig, env, fetchImpl });
    } catch {
      testModel = null;
    }
  }
  const testModelText = testModel ? formatTestModelForPrompt(testModel) : "";

  let attempt = null;
  let verification = null;
  let judge = null;
  let feedbackText = "";
  const history = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    // Step 3: LLM generation (round 1 fresh; later rounds carry the previous draft + feedback)
    attempt = await generateFn({
      defectInfo,
      fewShotText,
      contextText,
      testModelText,
      chatConfig: generatorConfig,
      previousAttempt: attempt,
      feedback: feedbackText,
      env,
      fetchImpl,
    });

    // Step 4a: programmatic heuristics (fast, deterministic; includes model_coverage
    // when a test design model exists)
    const verifyPayload = {
      action: "verify",
      defect_info: defectInfo,
      description_html: attempt.descriptionHtml,
      steps_text: attempt.stepsText,
    };
    if (testModel) {
      verifyPayload.test_model = testModel;
      verifyPayload.combination_coverage = attempt.combinationCoverage || [];
    }
    const verified = await runTestCaseBridge(verifyPayload);
    verification = verified?.verification || { passed: false, criteria: [], feedback: "verification skipped" };

    // Step 4b: LLM-as-judge (semantic grounding review; degrade to heuristic-only on failure)
    try {
      judge = await judgeFn({
        defectInfo,
        contextText,
        testModelText,
        descriptionHtml: attempt.descriptionHtml,
        stepsText: attempt.stepsText,
        testName: attempt.testName,
        chatConfig: judgeConfig,
        env,
        fetchImpl,
      });
    } catch (error) {
      judge = { passed: false, criteria: [], feedback: "", skipped: true, reason: String(error?.message || error) };
    }

    history.push(buildHistoryEntry(round, verification, judge));

    const heuristicPassed = Boolean(verification.passed);
    const judgePassed = judge.skipped ? true : Boolean(judge.passed);
    if (heuristicPassed && judgePassed) {
      break;
    }

    feedbackText = [
      verification.feedback,
      judge.skipped ? "" : judge.feedback,
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  const modelCoverage = computeModelCoverage(testModel, attempt?.combinationCoverage || [], attempt?.stepsText || "");

  return {
    attempt,
    verification,
    judge,
    generationRounds: history.length,
    history,
    defectInfo,
    testModel,
    modelCoveragePct: modelCoverage ? modelCoverage.coveragePct : null,
    similarCases: prepared.similar_cases || [],
    contextUsed: Boolean(contextText),
    bodiesFetched: Number(prepared.bodies_fetched || 0),
  };
}
