// LLM-as-judge for generated test cases.
//
// A second, independent model call that semantically reviews the generated draft against
// the source defect and the verified ontology context. Complements the programmatic
// heuristics in backend/analytics/test_case_verifier.py: heuristics catch format problems,
// the judge catches "plausible but hollow" content — un-grounded thresholds, checkpoints
// that don't target the defect's failure mode, steps a tester could not execute.
//
// Judge reliability practices applied here:
// - different model family than the generator (decorrelate errors) via TESTCASE_JUDGE_MODEL
//   or auto-selection from the allowed model list;
// - structured rubric output (one JSON verdict, per-criterion evidence);
// - the judge is a pre-filter, not a gate: on any failure the pipeline degrades to
//   heuristic-only and the human reviewer remains the final authority.

import { getChatModelOptions } from "./chatModelConfig.mjs";
import { callChatCompletion } from "./chatCompletionClient.mjs";
import { parseModelJson } from "./modelJson.mjs";

const JUDGE_TIMEOUT_MS = 90000;

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict QA reviewer judging an LLM-generated manual test case for BMW ALM Octane.",
  "Evaluate the draft against the source defect and the verified business context provided below.",
  "You are the quality gate before a human reviewer: be strict and concrete.",
  "",
  "Return ONLY a JSON object with exactly this shape:",
  '{"criteria":[{"name":"<criterion>","passed":true,"score":0.0,"evidence":"...","missing":["..."]}],"passed":true,"feedback":"..."}',
  "",
  "Criteria (judge each one, in this order):",
  "- failure_mode_coverage: the steps actually reproduce or directly target the defect's failure mode, not a generic regression test",
  "- oracle_strength: every '?' checkpoint has a specific, falsifiable expected result (concrete values, thresholds, or observable states)",
  "- grounding: every factual claim — signal names, thresholds, build IDs, tool names — is traceable to the defect info or the provided context; flag invented values",
  "- executability: a tester could execute the steps as written (clear preconditions, concrete actions, required builds/tools named)",
  "- completeness: covers the defect scenario plus the obvious boundary/regression aspect where applicable",
  "",
  "Rules: score is 0.0-1.0 and score < 0.6 means passed=false. 'missing' lists concrete deficits.",
  "'feedback' must give specific, actionable regeneration guidance (empty string when everything passes).",
  "Do not wrap the JSON in markdown fences.",
].join("\n");

function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function resolveJudgeModel(generatorModel, env = process.env) {
  const explicit = String(env.TESTCASE_JUDGE_MODEL || "").trim();
  if (explicit) {
    return explicit;
  }
  const options = getChatModelOptions(env);
  const generator = String(generatorModel || "").toLowerCase();
  const different = options.find((model) => model.toLowerCase() !== generator);
  return different || options[0] || generatorModel;
}

function normalizeVerdict(parsed) {
  const rawCriteria = Array.isArray(parsed?.criteria) ? parsed.criteria : [];
  const criteria = rawCriteria
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      name: String(c.name || "unknown"),
      passed: Boolean(c.passed),
      score: Number.isFinite(Number(c.score)) ? Math.max(0, Math.min(1, Number(c.score))) : (c.passed ? 1 : 0),
      evidence: String(c.evidence || ""),
      missing: Array.isArray(c.missing) ? c.missing.map((m) => String(m)).filter(Boolean) : [],
    }));
  const passed = criteria.length > 0 && criteria.every((c) => c.passed);
  return {
    passed,
    criteria,
    feedback: String(parsed?.feedback || ""),
  };
}

export async function judgeTestCase({
  defectInfo,
  contextText = "",
  testModelText = "",
  descriptionHtml = "",
  stepsText = "",
  testName = "",
  chatConfig,
  env = process.env,
  fetchImpl = fetch,
}) {
  if (!chatConfig?.credential) {
    throw new Error("LLM credentials not configured for the test-case judge");
  }

  const userPrompt = [
    `Source defect ID: ${defectInfo.defect_id}`,
    `Name: ${defectInfo.name}`,
    `Severity: ${defectInfo.severity}`,
    `Software: ${defectInfo.software_version}`,
    `ECU: ${defectInfo.assigned_ecu}`,
    `Lead model: ${defectInfo.lead_model}`,
    `Project: ${defectInfo.project}`,
    "",
    "Defect description:",
    String(defectInfo.description || "").slice(0, 3000) || "(no description)",
    ...(contextText
      ? ["", "Verified business context (factual background only):", String(contextText).slice(0, 4000)]
      : []),
    ...(testModelText
      ? ["", "Test design model (authoritative combination list — judge completeness against it):", String(testModelText).slice(0, 4000)]
      : []),
    "",
    "Generated test case to judge:",
    `Name: ${testName}`,
    "Steps:",
    String(stepsText || "(no steps)"),
    "Description (plain text):",
    htmlToText(descriptionHtml).slice(0, 1500) || "(no description)",
    "",
    "Judge the test case now. Return ONLY the JSON verdict object.",
  ].join("\n");

  const content = await callChatCompletion({
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    chatConfig,
    env,
    fetchImpl,
    timeoutMs: JUDGE_TIMEOUT_MS,
    label: "judge model",
  });
  const parsed = parseModelJson(content);
  if (!parsed) {
    throw new Error("judge model did not return a JSON verdict");
  }
  return normalizeVerdict(parsed);
}
