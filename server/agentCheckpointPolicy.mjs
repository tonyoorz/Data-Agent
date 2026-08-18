export class AgentCheckpointPolicyError extends Error {
  constructor(code, cause) {
    super(code, cause ? { cause } : undefined);
    this.code = code;
  }
}

export function allowInMemoryAgentCheckpointer(env = process.env) {
  const authMode = String(env?.VIZION_AGENT_AUTH_MODE || "oidc").trim().toLowerCase();
  const nodeEnv = String(env?.NODE_ENV || "").trim().toLowerCase();
  return authMode === "internal" && nodeEnv !== "production";
}

export function assertAgentCheckpointFallbackAllowed(env = process.env, cause) {
  if (!allowInMemoryAgentCheckpointer(env)) {
    throw new AgentCheckpointPolicyError("AGENT_DURABLE_CHECKPOINTER_REQUIRED", cause);
  }
}
