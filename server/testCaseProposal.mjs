import { createHash } from "node:crypto";

const ALLOWED_HTML_TAGS = new Set([
  "html", "body", "h1", "h2", "h3", "h4", "p", "br", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "strong", "em", "b", "i", "code", "pre",
]);

export class TestCasePreparationError extends Error {
  constructor(code, statusCode = 500) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function toSafeTestCasePreparationError(error) {
  if (!(error instanceof TestCasePreparationError)) return null;
  return { statusCode: error.statusCode, payload: { success: false, error: error.code } };
}

export function sanitizeTestCaseHtml(value) {
  const withoutActiveContent = String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|svg|math)[^>]*\/?>/gi, "");
  return withoutActiveContent.replace(/<\/?\s*([a-zA-Z0-9-]+)(?:\s[^>]*)?>/g, (tag, rawName) => {
    const name = String(rawName).toLowerCase();
    if (!ALLOWED_HTML_TAGS.has(name)) return "";
    const closing = /^<\s*\//.test(tag);
    if (name === "br") return "<br>";
    return closing ? `</${name}>` : `<${name}>`;
  });
}

function proposalDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function generateTestCaseContent(defectInfo, fewShotText, chatConfig, {
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const { buildChatCompletionRequest } = await import("./chatModelConfig.mjs");
  if (!chatConfig?.credential) {
    throw new Error("LLM credentials not configured — set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY");
  }
  const systemPrompt = [
    "You are a test case generator for BMW ALM Octane (workspace 1002/2001).",
    "Generate a structured manual test case (test_manual) from a defect's reproduction information.",
    "Output one JSON object with exactly testName, descriptionHtml, and stepsText.",
    "Keep procedure only in stepsText. Prefix preconditions with '- [PreCon]', actions with '-', and checkpoints with '- ?'.",
    "Checkpoints must use specific observable values or thresholds. Never include scripts, event handlers, remote media, forms, or embedded content in HTML.",
  ].join("\n");
  const userPrompt = [
    `Defect ID: ${defectInfo.defect_id}`,
    `Name: ${defectInfo.name}`,
    `Severity: ${defectInfo.severity}`,
    `Software: ${defectInfo.software_version}`,
    `ECU: ${defectInfo.assigned_ecu}`,
    `Lead model: ${defectInfo.lead_model}`,
    `Project: ${defectInfo.project}`,
    "Defect description:",
    String(defectInfo.description || "(no description)").slice(0, 3000),
    fewShotText ? `Reference test cases:\n${fewShotText}` : "",
    "Return only JSON, without a markdown fence.",
  ].filter(Boolean).join("\n\n");
  const requestConfig = buildChatCompletionRequest({
    selectedModel: chatConfig.model,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    env,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let response;
  try {
    response = await fetchImpl(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      body: JSON.stringify(requestConfig.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) throw new Error(`LLM request failed: ${response?.status || "unknown"} ${response?.statusText || ""}`.trim());
  const content = (await response.json())?.choices?.[0]?.message?.content || "";
  const jsonMatch = String(content).match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("LLM did not return a JSON object");
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    testName: String(parsed.testName || `[${defectInfo.project}] Regression - ${String(defectInfo.name || "").slice(0, 60)} (D${defectInfo.defect_id})`),
    descriptionHtml: sanitizeTestCaseHtml(parsed.descriptionHtml),
    stepsText: String(parsed.stepsText || ""),
  };
}

export async function prepareTestCaseProposal({
  defectId,
  runTestCaseBridge,
  generateContent,
  authorizeDefect,
  prepareScope,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (typeof runTestCaseBridge !== "function") throw new Error("TESTCASE_BRIDGE_UNAVAILABLE");
  if (typeof generateContent !== "function") throw new Error("TESTCASE_GENERATOR_UNAVAILABLE");
  const prepared = await runTestCaseBridge({
    action: "prepare",
    defect_id: String(defectId || ""),
    ...(prepareScope ? { actor_scope: prepareScope } : {}),
  });
  if (!prepared?.success || !prepared?.defect_info) {
    throw new TestCasePreparationError(
      String(prepared?.error || "TESTCASE_PREPARE_FAILED"),
      Number(prepared?.status_code) === 403 ? 403 : 500,
    );
  }
  const defectInfo = prepared.defect_info;
  if (authorizeDefect !== undefined) {
    if (typeof authorizeDefect !== "function") throw new Error("TESTCASE_AUTHORIZER_INVALID");
    await authorizeDefect(defectInfo);
  }
  const generated = await generateContent(defectInfo, prepared.few_shot_text || "");
  const safeGenerated = {
    testName: String(generated?.testName || ""),
    descriptionHtml: sanitizeTestCaseHtml(generated?.descriptionHtml),
    stepsText: String(generated?.stepsText || ""),
  };
  const verified = await runTestCaseBridge({
    action: "verify",
    defect_info: defectInfo,
    description_html: safeGenerated.descriptionHtml,
    steps_text: safeGenerated.stepsText,
  });
  const proposal = {
    defectId: String(defectInfo.defect_id || defectId || ""),
    defectName: String(defectInfo.name || ""),
    defectSeverity: String(defectInfo.severity || ""),
    defectSoftwareVersion: String(defectInfo.software_version || ""),
    defectAssignedEcu: String(defectInfo.assigned_ecu || ""),
    defectLeadModel: String(defectInfo.lead_model || ""),
    name: safeGenerated.testName,
    descriptionHtml: safeGenerated.descriptionHtml,
    stepsText: safeGenerated.stepsText,
    verification: verified?.verification || { passed: false, criteria: [], feedback: "verification unavailable" },
    similarCases: Array.isArray(prepared.similar_cases) ? prepared.similar_cases : [],
    generatedAt,
  };
  return { ...proposal, proposalDigest: proposalDigest(proposal), proposalOnly: true, committed: false };
}
