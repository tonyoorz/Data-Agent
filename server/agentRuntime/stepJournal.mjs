import { createHash } from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function fail(code, statusCode = 409) {
  throw Object.assign(new Error(code), { code, statusCode, retryable: false });
}

function safeErrorCode(error) {
  const raw = String(error?.code || "");
  return /^[A-Z][A-Z0-9_:-]{2,79}$/.test(raw) ? raw : "STEP_FAILED";
}

export function hashStepInput(value) {
  const identity = {
    runId: value.runId,
    nodeId: value.nodeId,
    logicalAttempt: value.logicalAttempt,
    scopeHash: value.scopeHash,
    graphDefinitionVersion: value.graphDefinitionVersion,
    toolName: value.toolName,
    toolVersion: value.toolVersion,
    canonicalArgsHash: value.canonicalArgsHash,
    boundaryKind: value.boundaryKind,
    sourceRevisionSet: value.sourceRevisionSet,
    input: value.input,
  };
  return createHash("sha256").update(JSON.stringify(stable(identity))).digest("hex");
}

export function createStepJournal({ db, threadStore, now }) {
  const startTx = db.transaction((input) => {
    const inputHash = hashStepInput(input);
    const existing = db.prepare("SELECT * FROM agent_step_journal WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=?").get(input.runId, input.nodeId, input.logicalAttempt, inputHash);
    if (existing?.status === "completed") return { status: "completed", result: JSON.parse(existing.result_json) };
    if (existing?.status === "unknown") fail("STEP_REQUIRES_RECONCILIATION");
    if (existing?.status === "started") {
      if (existing.lease_epoch === input.leaseEpoch) fail("STEP_IN_PROGRESS");
      if (input.boundaryKind === "write") {
        db.prepare("UPDATE agent_step_journal SET status='unknown', completed_at=? WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=? AND status='started'").run(now(), input.runId, input.nodeId, input.logicalAttempt, inputHash);
        fail("STEP_REQUIRES_RECONCILIATION");
      }
      db.prepare("UPDATE agent_step_journal SET lease_epoch=?, started_at=?, error_json=NULL WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=? AND status='started'").run(input.leaseEpoch, now(), input.runId, input.nodeId, input.logicalAttempt, inputHash);
      return { status: "started", inputHash };
    }
    if (existing?.status === "failed") fail("STEP_FAILED");
    db.prepare("INSERT INTO agent_step_journal(run_id,node_id,logical_attempt,input_hash,scope_hash,graph_definition_version,lease_epoch,status,started_at) VALUES(?,?,?,?,?,?,?,'started',?)").run(input.runId, input.nodeId, input.logicalAttempt, inputHash, input.scopeHash, input.graphDefinitionVersion, input.leaseEpoch, now());
    return { status: "started", inputHash };
  });

  const completeTx = db.transaction((input, inputHash, result) => {
    threadStore.assertLease({ runId: input.runId, leaseEpoch: input.leaseEpoch });
    const changes = db.prepare("UPDATE agent_step_journal SET status='completed', result_json=?, completed_at=? WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=? AND lease_epoch=? AND status='started'").run(JSON.stringify(result), now(), input.runId, input.nodeId, input.logicalAttempt, inputHash, input.leaseEpoch).changes;
    if (changes !== 1) fail("STALE_RUN_LEASE");
    return result;
  });

  const recordFailureTx = db.transaction((input, inputHash, error) => {
    threadStore.assertLease({ runId: input.runId, leaseEpoch: input.leaseEpoch });
    const status = input.boundaryKind === "write" ? "unknown" : "failed";
    db.prepare("UPDATE agent_step_journal SET status=?, error_json=?, completed_at=? WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=? AND status='started'").run(status, JSON.stringify({ code: safeErrorCode(error), retryable: Boolean(error?.retryable) }), now(), input.runId, input.nodeId, input.logicalAttempt, inputHash);
    return status;
  });

  return {
    async run(input, execute) {
      const started = startTx(input);
      if (started.status === "completed") return started.result;
      try {
        const result = await execute();
        return completeTx(input, started.inputHash, result);
      } catch (error) {
        const status = recordFailureTx(input, started.inputHash, error);
        if (status === "unknown") fail("STEP_REQUIRES_RECONCILIATION");
        throw error;
      }
    },
  };
}
