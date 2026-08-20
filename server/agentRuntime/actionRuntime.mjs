/**
 * P1-C2: ActionRuntime — transactional writeback execution for governed actions.
 * Single action = single transaction (Palantir alignment):
 *   1. criteria evaluation (submissionCriteria engine comes in P1-C5; userGroup pre-check here)
 *   2. approvalFlow (two-phase, reuses P0 approval flow)
 *   3. transactional write to the action's writeback dataset (BEGIN/COMMIT, rollback on failure)
 *   4. side effects (action_log event; notify hook left to caller)
 * State machine: submitted → pending_approval → executed | rejected | expired | failed(rolled_back)
 */
import { createApprovalFlow } from "./approvalFlow.mjs";
import { createSessionEventLog } from "./sessionEventLog.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createActionRuntime({
  registry,
  eventLog,
  writeStore, // { begin(), insert(dataset, row), commit(tx), rollback(tx) } — injected for testability
  now = () => new Date(),
  userGroupsByActor = () => new Set(["dtsv_team"]),
} = {}) {
  if (!registry) throw new Error("ONTOLOGY_REGISTRY_REQUIRED");
  const log = eventLog || createSessionEventLog({ now });
  const approvalFlow = createApprovalFlow({ eventLog: log, now });
  const submissions = new Map(); // submissionId -> submission record

  function evaluateUserGroups(action, actor) {
    const groups = userGroupsByActor(actor);
    const required = (action.submissionCriteria || []).filter((c) => c.kind === "userGroup");
    const unmet = required.filter((c) => !groups.has(c.userGroup)).map((c) => `userGroup:${c.userGroup}`);
    return { allowed: unmet.length === 0, unmet };
  }

  function approvalCriterion(action) {
    return (action.submissionCriteria || []).find((c) => c.kind === "approval") || null;
  }

  async function writeTransactionally(action, payload, submissionId) {
    const tx = writeStore.begin(submissionId);
    try {
      const row = {
        submission_id: submissionId,
        action_id: action.id,
        action_version: action.version,
        target_entity: action.targetEntityId,
        mutation_fields: action.mutation.fields,
        payload,
        committed_at: now().toISOString(),
      };
      writeStore.insert(tx, action.mutation.writeback.dataset, row);
      writeStore.commit(tx);
      return { status: "committed", row };
    } catch (error) {
      writeStore.rollback(tx);
      throw error;
    }
  }

  return {
    approvalFlow,

    async submitAction({ actionId, payload, actor, sessionId = "anonymous" }) {
      const action = registry.bundle.actions.find((a) => a.id === actionId);
      if (!action) throw new Error(`ACTION_NOT_FOUND:${actionId}`);
      if (action.execution?.mode !== "enabled") throw new Error(`ACTION_NOT_ENABLED:${actionId}`);
      if (!isRecord(payload)) throw new Error("ACTION_PAYLOAD_INVALID");

      const groups = evaluateUserGroups(action, actor);
      if (!groups.allowed) {
        const submission = { submissionId: `sub_rejected_${now().getTime().toString(36)}`, status: "rejected", unmet: groups.unmet, actionId };
        await log.append({ type: "action/rejected", sessionId, payload: submission });
        return submission;
      }

      const criterion = approvalCriterion(action);
      let approval = null;
      if (criterion) {
        approval = await approvalFlow.request({
          sessionId,
          kind: criterion.approvalKind,
          summary: `${action.labels["zh-CN"]}: ${actionId}`,
          toolCall: { name: actionId, arguments: payload },
          handoffState: { actionId, payload },
        });
      }

      const submissionId = `sub_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const submission = {
        submissionId,
        actionId,
        status: criterion ? "pending_approval" : "executed",
        approvalId: approval?.approvalId ?? null,
        payload,
        createdAt: now().toISOString(),
        writeback: null,
      };
      submissions.set(submissionId, submission);
      await log.append({ type: "action/submitted", sessionId, payload: { submissionId, actionId, status: submission.status } });
      if (!criterion) {
        const result = await writeTransactionally(action, payload, submissionId);
        submission.status = "executed";
        submission.writeback = { dataset: action.mutation.writeback.dataset, committedRow: result.row };
      }
      return { ...submission };
    },

    async decide({ submissionId, decision, decidedBy = "user", sessionId = "anonymous" }) {
      const submission = submissions.get(submissionId);
      if (!submission) return { status: "not_found" };
      if (submission.status !== "pending_approval") return { status: submission.status };
      const action = registry.bundle.actions.find((a) => a.id === submission.actionId);

      const resolved = submission.approvalId
        ? await approvalFlow.decide({ approvalId: submission.approvalId, decision, decidedBy })
        : { status: "ok" };

      if (decision !== "approved" || resolved.status === "not_found") {
        submission.status = decision === "rejected" ? "rejected" : "expired";
        await log.append({ type: "action/decided", sessionId, payload: { submissionId, decision, status: submission.status } });
        return { ...submission };
      }

      try {
        const result = await writeTransactionally(action, submission.payload, submissionId);
        submission.status = "executed";
        submission.writeback = { dataset: action.mutation.writeback.dataset, committedRow: result.row };
        await log.append({ type: "action/executed", sessionId, payload: { submissionId, actionId: action.id, dataset: action.mutation.writeback.dataset } });
      } catch (error) {
        submission.status = "failed_rolled_back";
        submission.error = error?.message ?? String(error);
        await log.append({ type: "action/rollback", sessionId, payload: { submissionId, actionId: action.id, error: submission.error } });
      }
      return { ...submission };
    },

    getSubmission(submissionId) {
      const submission = submissions.get(submissionId);
      return submission ? { ...submission } : null;
    },
  };
}

/** In-memory transactional write store for tests and local dry-run usage. */
export function createInMemoryWriteStore({ failOn = () => false } = {}) {
  const committed = [];
  const txLog = [];
  return {
    committed,
    begin(id) {
      const tx = { id, open: true };
      txLog.push(`BEGIN:${id}`);
      return tx;
    },
    insert(tx, dataset, row) {
      if (!tx.open) throw new Error("TX_NOT_OPEN");
      if (failOn(dataset, row)) throw new Error("WRITE_CONFLICT");
      txLog.push(`INSERT:${dataset}`);
      tx.pendingRow = { dataset, row };
    },
    commit(tx) {
      if (!tx.open) throw new Error("TX_NOT_OPEN");
      tx.open = false;
      txLog.push(`COMMIT:${tx.id}`);
      committed.push(tx.pendingRow);
    },
    rollback(tx) {
      tx.open = false;
      txLog.push(`ROLLBACK:${tx.id}`);
    },
    txLog,
  };
}
