function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [/credential|secret|token|cookie|access.?code|authorization|bearer|api.?key/i.test(key) ? [key, "[redacted]"] : [key, redact(item)]]));
  }
  return value;
}

export function createAuditStore({ db, now, randomUUID }) {
  return Object.freeze({
    append({ actor, threadId = null, runId = null, action, details = {} }) {
      const auditId = randomUUID();
      const row = { auditId, actorId: actor.actorId, threadId, runId, action, scopeHash: actor.scopeHash, details: redact(details), createdAt: now() };
      db.prepare("INSERT INTO agent_audit(audit_id,actor_id,thread_id,run_id,action,scope_hash,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run(auditId, row.actorId, threadId, runId, action, row.scopeHash, JSON.stringify(row.details), row.createdAt);
      return row;
    },
    listForAdmin() {
      return db.prepare("SELECT * FROM agent_audit ORDER BY created_at").all();
    },
  });
}