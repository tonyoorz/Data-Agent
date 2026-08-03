import { createHash } from "node:crypto";

const DEFAULT_ALLOWED_OBJECT_TYPES = Object.freeze([
  "quality.defect",
  "testing.test_case",
  "testing.test_run",
  "requirements.aida_node",
]);

function csv(value, fallback = []) {
  const values = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(values.length ? values : fallback)];
}

function compactScopes(scopes) {
  return Object.fromEntries(Object.entries(scopes).filter(([, values]) => Array.isArray(values) && values.length));
}

export function resolveInternalActorScope(env = process.env) {
  const actorId = String(env?.VIZION_INTERNAL_ACTOR_ID || "vizion-internal").trim() || "vizion-internal";
  const scopes = compactScopes({
    workspaceIds: csv(env?.VIZION_INTERNAL_WORKSPACE_IDS),
    projectIds: csv(env?.VIZION_INTERNAL_PROJECT_IDS),
    teamIds: csv(env?.VIZION_INTERNAL_TEAM_IDS),
    allowedObjectTypes: csv(env?.VIZION_INTERNAL_ALLOWED_OBJECT_TYPES, DEFAULT_ALLOWED_OBJECT_TYPES),
    allowedPropertyIds: csv(env?.VIZION_INTERNAL_ALLOWED_PROPERTY_IDS),
    rowPolicyIds: csv(env?.VIZION_INTERNAL_ROW_POLICY_IDS),
    sensitiveFieldPolicyIds: csv(env?.VIZION_INTERNAL_SENSITIVE_FIELD_POLICY_IDS),
  });
  const scopeHash = `internal-${createHash("sha256")
    .update(JSON.stringify({ actorId, scopes }))
    .digest("hex")
    .slice(0, 16)}`;
  return { actorId, scopeHash, scopes };
}

export function withInternalActorScope(body, env = process.env) {
  return {
    ...(body && typeof body === "object" ? body : {}),
    actor: resolveInternalActorScope(env),
  };
}
