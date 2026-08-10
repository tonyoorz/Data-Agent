import { createHash } from "node:crypto";
import { createContractRegistry } from "./contracts.mjs";
import { ANALYTICS_TOOLS, DEFECT_TOOLS } from "./policy.mjs";
import { executeMainAgentToolCall, MAIN_AGENT_TOOLS } from "../mainAgentTools.mjs";

const TOOL_TIMEOUTS = {
  query_semantic_metrics: 15_000,
  query_semantic_records: 20_000,
  query_traceability: 20_000,
  query_dashboard_summary: 12_000,
  query_testing_coverage_project_status: 12_000,
  query_defect_high_frequency_analysis: 12_000,
  query_full_picture_module: 12_000,
  search_duplicates: 120_000,
};

const SEMANTIC_TOOLS = new Set(["query_semantic_metrics", "query_semantic_records", "query_traceability"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function toolError(code, status = code === "TOOL_TIMEOUT" ? "timeout" : "failed", retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function toLegacyToolCall(call, parsedArgs) {
  return {
    id: call.toolCallId,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(parsedArgs) },
  };
}

function returnedFailureCode(result, toolName) {
  if (!result || typeof result !== "object" || typeof result.contextText !== "string" || !result.toolMessage || typeof result.toolMessage.content !== "string") {
    return "TOOL_RESULT_INVALID";
  }
  let payload;
  try {
    payload = JSON.parse(result.toolMessage.content);
  } catch {
    return "TOOL_RESULT_INVALID";
  }
  if (payload?.error || payload?.ok === false) {
    return toolName === "search_duplicates" ? "DUPLICATE_SEARCH_FAILED" : "ANALYTICS_QUERY_FAILED";
  }
  return null;
}

function publicTool(record) {
  return Object.freeze({
    name: record.name,
    version: record.version,
    riskLevel: record.riskLevel,
    inputSchema: record.inputSchema,
    outputSchema: record.outputSchema,
    timeoutMs: record.timeoutMs,
    maxOutputBytes: record.maxOutputBytes,
    idempotent: record.idempotent,
    retryPolicy: record.retryPolicy,
  });
}

function makeSignal(context, timeoutMs) {
  const parentSignal = context.signal || new AbortController().signal;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort("timeout"), timeoutMs);
  let signal;
  if (typeof AbortSignal.any === "function") {
    signal = AbortSignal.any([parentSignal, timeoutController.signal]);
  } else {
    const controller = new AbortController();
    const abort = (source) => { if (!controller.signal.aborted) controller.abort(source.reason || "aborted"); };
    for (const source of [parentSignal, timeoutController.signal]) {
      if (source.aborted) abort(source);
      else source.addEventListener("abort", () => abort(source), { once: true });
    }
    signal = controller.signal;
  }
  return { signal, timeoutController, timeoutId };
}

async function waitBackoff(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(toolError("TOOL_CANCELLED", "cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createToolRegistry({
  policy,
  executeLegacyTool = executeMainAgentToolCall,
  analyticsFetch = globalThis.fetch,
  analyticsApiBase,
  runDuplicateBridge,
  ensureDuplicateWarmup,
  tools = MAIN_AGENT_TOOLS,
  telemetry,
}) {
  const contracts = createContractRegistry();
  const records = new Map();
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (!ANALYTICS_TOOLS.has(name) && !DEFECT_TOOLS.has(name)) continue;
    const inputSchema = tool.function.parameters;
    const validate = contracts.compileToolSchema(inputSchema, `TOOL_SCHEMA:${name}`);
    records.set(name, Object.freeze({
      name,
      version: SEMANTIC_TOOLS.has(name) ? "ontology-semantic-v1" : "legacy-tool-v1",
      riskLevel: "R0",
      inputSchema,
      outputSchema: { type: "object" },
      timeoutMs: TOOL_TIMEOUTS[name] || 12_000,
      maxOutputBytes: 262144,
      idempotent: true,
      retryPolicy: { maxAttempts: ANALYTICS_TOOLS.has(name) ? 2 : 1, backoffMs: 250 },
      validate,
    }));
  }

  return Object.freeze({
    listForPlanner({ request, runtimeMode }) {
      return [...records.values()]
        .filter((record) => {
          try {
            policy.authorizeTool({ actor: null, request, runtimeMode, toolName: record.name, externalStepIndex: 0, callsInStep: 1 });
            return true;
          } catch {
            return false;
          }
        })
        .map(publicTool);
    },
    get(name) {
      const record = records.get(name);
      if (!record) throw toolError("TOOL_NOT_REGISTERED", "denied");
      return publicTool(record);
    },
    async execute({ call, request, runtimeMode, externalStepIndex, callsInStep, context }) {
      const record = records.get(call.name);
      if (!record) throw toolError("TOOL_NOT_REGISTERED", "denied");
      let parsedArgs;
      try {
        parsedArgs = JSON.parse(call.argumentsText || "{}");
      } catch {
        throw toolError("TOOL_ARGUMENTS_INVALID", "failed");
      }
      if (!record.validate(parsedArgs)) throw toolError("TOOL_ARGUMENTS_INVALID", "failed");
      const maxAttempts = Math.max(1, Number(record.retryPolicy.maxAttempts || 1));
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const span = telemetry?.startSpan("agent.tool", { toolName: record.name, toolVersion: record.version, attempt });
        const analyticsSpan = SEMANTIC_TOOLS.has(record.name)
          ? telemetry?.startSpan("agent.analytics.query", { toolName: record.name, toolVersion: record.version, attempt })
          : null;
        let signal = context.signal;
        let timeoutController;
        let timeoutId;
        try {
          const refreshedActor = await context.refreshActor();
          policy.authorizeTool({ actor: refreshedActor, request, runtimeMode, toolName: call.name, externalStepIndex, callsInStep });
          if (context.signal?.aborted || await context.isCancellationRequested()) throw toolError("TOOL_CANCELLED", "cancelled");
          await context.assertCurrentLease();

          ({ signal, timeoutController, timeoutId } = makeSignal(context, record.timeoutMs));
          const analyticsFetchWithSignal = (url, init = {}) => analyticsFetch(url, { ...init, signal });
          const result = await executeLegacyTool(toLegacyToolCall(call, parsedArgs), {
            analyticsFetch: analyticsFetchWithSignal,
            analyticsApiBase,
            runDuplicateBridge,
            ensureDuplicateWarmup,
            actor: refreshedActor,
          });
          const returnedFailure = returnedFailureCode(result, record.name);
          if (returnedFailure) {
            throw toolError(returnedFailure, "failed", ANALYTICS_TOOLS.has(record.name));
          }
          await context.assertCurrentLease();
          if (signal.aborted) {
            const timeout = timeoutController.signal.aborted && !context.signal?.aborted;
            throw toolError(timeout ? "TOOL_TIMEOUT" : "TOOL_CANCELLED", timeout ? "timeout" : "cancelled", timeout);
          }
          const outputBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
          if (outputBytes > record.maxOutputBytes) throw toolError("TOOL_OUTPUT_TOO_LARGE", "failed");
          const response = {
            status: "succeeded",
            toolName: record.name,
            toolVersion: record.version,
            canonicalArgs: stable(parsedArgs),
            preview: result.contextText,
            contentHash: contentHash(result),
            outputBytes,
            attemptCount: attempt,
            truncated: false,
            rawResult: result,
          };
          span?.end({ status: "succeeded" });
          analyticsSpan?.end({ status: "succeeded" });
          return response;
        } catch (error) {
          let normalized = error;
          if (signal?.aborted && error?.code !== "TOOL_CANCELLED" && error?.code !== "TOOL_TIMEOUT") {
            const timeout = timeoutController?.signal.aborted && !context.signal?.aborted;
            normalized = toolError(timeout ? "TOOL_TIMEOUT" : "TOOL_CANCELLED", timeout ? "timeout" : "cancelled", timeout);
          }
          lastError = normalized;
          const canRetry = record.idempotent && attempt < maxAttempts && normalized?.retryable === true && normalized?.status !== "cancelled";
          span?.end({ status: canRetry ? "retrying" : normalized?.status || "failed", code: normalized?.code || "TOOL_EXECUTION_FAILED", retryable: Boolean(normalized?.retryable) });
          analyticsSpan?.end({ status: canRetry ? "retrying" : normalized?.status || "failed", code: normalized?.code || "TOOL_EXECUTION_FAILED", retryable: Boolean(normalized?.retryable) });
          if (!canRetry) throw normalized;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
        await context.assertCurrentLease();
        await waitBackoff(record.retryPolicy.backoffMs * attempt, context.signal);
      }
      throw lastError || toolError("TOOL_EXECUTION_FAILED");
    },
  });
}
