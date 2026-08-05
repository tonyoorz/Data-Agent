import { resolveRequestActor, toSafeAgentAuthResponse } from "./agentAuth.mjs";
import { loadAgentOperations } from "./agentRuntime/runSummary.mjs";

export const AGENT_OPERATIONS_READ_POLICY = "agent.operations.read";

function canReadAgentOperations(actor) {
  return Array.isArray(actor?.scopes?.rowPolicyIds)
    && actor.scopes.rowPolicyIds.includes(AGENT_OPERATIONS_READ_POLICY);
}

export async function resolveAgentOperationsResponse({
  request,
  operation,
  runId = "",
  env = process.env,
  rootDir,
  resolveActor = resolveRequestActor,
  readOperations = loadAgentOperations,
} = {}) {
  let actor;
  try {
    actor = await resolveActor(request, { env });
  } catch (error) {
    const safe = toSafeAgentAuthResponse(error);
    if (safe) return safe;
    return { statusCode: 503, payload: { success: false, error: "AGENT_OPERATIONS_UNAVAILABLE" } };
  }
  if (!canReadAgentOperations(actor)) {
    return { statusCode: 403, payload: { success: false, error: "AGENT_OPERATIONS_ACCESS_DENIED" } };
  }
  try {
    const options = { operation: String(operation || "summary"), runId: String(runId || "") };
    if (rootDir) options.rootDir = rootDir;
    const payload = await readOperations(options);
    if (operation === "run" && payload === null) {
      return { statusCode: 404, payload: { success: false, error: "AGENT_OPERATIONS_RUN_NOT_FOUND" } };
    }
    return { statusCode: 200, payload };
  } catch {
    return { statusCode: 503, payload: { success: false, error: "AGENT_OPERATIONS_UNAVAILABLE" } };
  }
}