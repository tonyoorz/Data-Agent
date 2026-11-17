// Stage-1 test design model for two-stage testcase generation.
//
// Before the LLM writes any test steps, it first derives a machine-checkable test
// design model from the defect + verified context: equivalence classes per input
// dimension, boundary classes flagged, and the selected class combinations the test
// must cover (pairwise-style selection with rationale when the space is large).
// The generated test case is then validated against this model — combination
// coverage becomes a computable, auditable number instead of LLM self-assessment.
//
// Everything here degrades to null: a model that fails validation or cannot be
// built leaves the pipeline exactly as it was before this module existed.

import { callChatCompletion } from "./chatCompletionClient.mjs";
import { parseModelJson } from "./modelJson.mjs";

const BUILD_TIMEOUT_MS = 90000;
const MAX_DIMENSIONS = 8;
const MAX_CLASSES_PER_DIMENSION = 12;
const MAX_COMBINATIONS = 12;

const TEST_MODEL_SYSTEM_PROMPT = [
  "You are a test design analyst for BMW ALM Octane manual test cases, applying systematic",
  "test design techniques (equivalence partitioning, boundary value analysis, combination selection).",
  "",
  "From the defect and verified business context, derive a test design model. Return ONLY a JSON object:",
  '{"dimensions":[{"name":"<short dimension name>","aspect":"<what varies>","classes":[{"id":"<dim1-c1>","name":"<equivalence class>","isBoundary":false}]}],',
  '"combinations":[{"id":"TC-1","classRefs":["<dim1-c1>","<dim2-c1>"],"priority":"high|normal|low","rationale":"<why this combination>"}]}',
  "",
  "Rules:",
  "- Dimensions are the input/environment aspects that matter for this defect (e.g. drive mode, software build, signal state, temperature range). Typically 2-4 dimensions.",
  "- Classes are the equivalence classes of each dimension; mark boundary/edge classes with isBoundary: true.",
  "- Combinations are the class selections the test must actually cover. Prefer defect-relevant, boundary, and default-vs-candidate contrasts over exhaustive enumeration; when dimensions multiply, select pairwise-style and say why in rationale.",
  "- ids must be unique; classRefs must reference existing class ids.",
  "- Ground every class name in the defect info or provided context — never invent signal names, thresholds, or build ids.",
  "Do not wrap the JSON in markdown fences.",
].join("\n");

export function testModelEnabled(env = process.env) {
  const raw = String(env.TESTCASE_TEST_MODEL ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function classIndexFrom(dimensions) {
  const byId = new Map();
  for (const dimension of dimensions) {
    for (const cls of dimension.classes) {
      byId.set(cls.id, cls);
    }
  }
  return byId;
}

export function validateTestModel(model) {
  if (!model || typeof model !== "object" || !Array.isArray(model.dimensions) || model.dimensions.length === 0) {
    return null;
  }
  const dimensions = [];
  for (const rawDim of model.dimensions.slice(0, MAX_DIMENSIONS)) {
    if (!rawDim || typeof rawDim !== "object") return null;
    const name = String(rawDim.name || "").trim();
    if (!name) return null;
    const rawClasses = Array.isArray(rawDim.classes) ? rawDim.classes : [];
    const classes = [];
    for (const rawClass of rawClasses.slice(0, MAX_CLASSES_PER_DIMENSION)) {
      if (!rawClass || typeof rawClass !== "object") return null;
      const id = String(rawClass.id || "").trim();
      const clsName = String(rawClass.name || "").trim();
      if (!id || !clsName) return null;
      classes.push(rawClass.isBoundary
        ? { id, name: clsName, isBoundary: true }
        : { id, name: clsName });
    }
    if (classes.length === 0) return null;
    dimensions.push({ name, aspect: String(rawDim.aspect || "").trim() || name, classes });
  }

  const classIndex = classIndexFrom(dimensions);
  const combinations = [];
  const seenComboIds = new Set();
  for (const rawCombo of (Array.isArray(model.combinations) ? model.combinations : []).slice(0, MAX_COMBINATIONS)) {
    if (!rawCombo || typeof rawCombo !== "object") return null;
    const id = String(rawCombo.id || "").trim();
    const classRefs = (Array.isArray(rawCombo.classRefs) ? rawCombo.classRefs : [])
      .map((ref) => String(ref || "").trim())
      .filter(Boolean);
    if (!id || seenComboIds.has(id) || classRefs.length === 0) return null;
    if (classRefs.some((ref) => !classIndex.has(ref))) return null;
    seenComboIds.add(id);
    combinations.push({
      id,
      classRefs,
      priority: String(rawCombo.priority || "normal").trim().toLowerCase(),
      rationale: String(rawCombo.rationale || "").trim().slice(0, 300),
    });
  }
  if (combinations.length === 0) return null;

  return { dimensions, combinations };
}

export async function buildTestModel({
  defectInfo,
  contextText = "",
  fewShotText = "",
  chatConfig,
  env = process.env,
  fetchImpl = fetch,
}) {
  if (!chatConfig?.credential) {
    throw new Error("LLM credentials not configured — set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY");
  }

  const userPrompt = [
    `Defect ID: ${defectInfo.defect_id}`,
    `Name: ${defectInfo.name}`,
    `Severity: ${defectInfo.severity}`,
    `Software: ${defectInfo.software_version}`,
    `ECU: ${defectInfo.assigned_ecu}`,
    `Project: ${defectInfo.project}`,
    "",
    "Defect description:",
    String(defectInfo.description || "").slice(0, 3000) || "(no description)",
    ...(contextText
      ? ["", "Verified business context (factual background):", String(contextText).slice(0, 4000)]
      : []),
    ...(fewShotText
      ? ["", "Domain reference (existing test cases for terminology only):", String(fewShotText).slice(0, 2500)]
      : []),
    "",
    "Derive the test design model now. Return ONLY the JSON object.",
  ].join("\n");

  const content = await callChatCompletion({
    messages: [
      { role: "system", content: TEST_MODEL_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    chatConfig,
    env,
    fetchImpl,
    timeoutMs: BUILD_TIMEOUT_MS,
    label: "test-model",
  });

  const parsed = parseModelJson(content);
  if (!parsed) {
    throw new Error("test model LLM did not return a JSON object");
  }
  const validated = validateTestModel(parsed);
  if (!validated) {
    throw new Error("test model failed structural validation");
  }
  return validated;
}

export function formatTestModelForPrompt(model) {
  if (!model || !Array.isArray(model.dimensions) || !Array.isArray(model.combinations)) {
    return "";
  }
  const classIndex = classIndexFrom(model.dimensions);
  const lines = [
    "Test design model (authoritative — the generated test MUST cover every combination listed below):",
  ];
  for (const dimension of model.dimensions) {
    const classes = dimension.classes
      .map((cls) => `${cls.name}${cls.isBoundary ? " [boundary]" : ""}`)
      .join(" | ");
    lines.push(`Dimension ${dimension.name} (${dimension.aspect}): ${classes}`);
  }
  lines.push("Combinations to cover (every checkpoint must map to at least one):");
  for (const combination of model.combinations) {
    const classNames = combination.classRefs
      .map((ref) => classIndex.get(ref)?.name || ref)
      .join(" + ");
    lines.push(`- ${combination.id} [${combination.priority || "normal"}]: ${classNames}${combination.rationale ? ` — ${combination.rationale}` : ""}`);
  }
  return lines.join("\n");
}

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Trusted coverage computation: a combination counts as covered only when its id is
// claimed in the generated output AND every referenced class name actually appears in
// the step text — keyword cross-validation that defeats empty self-reporting.
export function computeModelCoverage(model, claimedCoverage, stepsText) {
  if (!model || !Array.isArray(model.combinations) || model.combinations.length === 0) {
    return null;
  }
  const classIndex = classIndexFrom(model.dimensions || []);
  const claimed = new Set(
    (Array.isArray(claimedCoverage) ? claimedCoverage : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const stepsNormalized = normalizeForMatch(stepsText);

  const coveredIds = [];
  const uncoveredIds = [];
  for (const combination of model.combinations) {
    if (!claimed.has(combination.id)) {
      uncoveredIds.push(combination.id);
      continue;
    }
    const tokens = combination.classRefs
      .map((ref) => classIndex.get(ref)?.name)
      .filter(Boolean)
      .map(normalizeForMatch)
      .filter((token) => token.length >= 3);
    if (tokens.length > 0 && tokens.every((token) => stepsNormalized.includes(token))) {
      coveredIds.push(combination.id);
    } else {
      uncoveredIds.push(combination.id);
    }
  }
  return {
    coveredIds,
    uncoveredIds,
    coveragePct: Math.round((coveredIds.length / model.combinations.length) * 100),
  };
}
