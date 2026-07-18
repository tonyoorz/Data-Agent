import { createHash } from "node:crypto";
import fs from "node:fs";

const TERMINAL = "('completed','failed','cancelled')";

function placeholders(values) {
  return values.length ? values.map(() => "?").join(",") : "NULL";
}

function unique(values) {
  return [...new Set(values)];
}

export function buildCleanupPlan({ db, cutoffs }) {
  const eventRunIds = db.prepare(`SELECT run_id FROM agent_runs WHERE status IN ${TERMINAL} AND terminal_at < ?`).all(cutoffs.eventsBefore).map((row) => row.run_id);
  const checkpointRuns = db.prepare(`SELECT run_id,thread_id FROM agent_runs WHERE status IN ${TERMINAL} AND terminal_at < ?`).all(cutoffs.checkpointsBefore);
  const journalRunIds = db.prepare(`SELECT run_id FROM agent_runs WHERE status IN ${TERMINAL} AND terminal_at < ?`).all(cutoffs.journalBefore).map((row) => row.run_id);
  const artifactRows = db.prepare("SELECT a.artifact_id,a.content_hash,b.storage_path FROM agent_artifacts a JOIN agent_artifact_blobs b ON b.content_hash=a.content_hash WHERE a.expires_at < ?").all(cutoffs.artifactsBefore);
  const threadIds = db.prepare(`SELECT t.thread_id FROM agent_threads t WHERE t.deleted_at IS NOT NULL AND t.deleted_at < ? AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.thread_id=t.thread_id AND r.status NOT IN ${TERMINAL}) AND NOT EXISTS (SELECT 1 FROM agent_threads child WHERE child.parent_thread_id=t.thread_id) AND NOT EXISTS (SELECT 1 FROM agent_runs parent JOIN agent_runs child_run ON child_run.parent_run_id=parent.run_id WHERE parent.thread_id=t.thread_id AND child_run.thread_id<>t.thread_id)`).all(cutoffs.threadsBefore).map((row) => row.thread_id);
  const deletedThreadRuns = threadIds.length ? db.prepare(`SELECT run_id,thread_id FROM agent_runs WHERE thread_id IN (${placeholders(threadIds)})`).all(...threadIds) : [];
  const deletedThreadRunIds = deletedThreadRuns.map((row) => row.run_id);
  const auditIds = db.prepare("SELECT audit_id FROM agent_audit WHERE created_at < ?").all(cutoffs.auditBefore).map((row) => row.audit_id);
  const eventCount = eventRunIds.length ? Number(db.prepare(`SELECT COUNT(*) FROM agent_events WHERE run_id IN (${placeholders(eventRunIds)})`).pluck().get(...eventRunIds)) : 0;
  const checkpointThreadIds = unique([...checkpointRuns, ...deletedThreadRuns].map((row) => `${row.thread_id}:run:${row.run_id}`));
  const checkpointCount = checkpointThreadIds.length ? Number(db.prepare(`SELECT COUNT(*) FROM checkpoints WHERE thread_id IN (${placeholders(checkpointThreadIds)})`).pluck().get(...checkpointThreadIds)) : 0;
  const journalCount = journalRunIds.length ? Number(db.prepare(`SELECT COUNT(*) FROM agent_step_journal WHERE run_id IN (${placeholders(journalRunIds)})`).pluck().get(...journalRunIds)) : 0;
  const plan = {
    schemaVersion: "1.0",
    cutoffs,
    ids: {
      eventRunIds: unique(eventRunIds),
      checkpointThreadIds: unique(checkpointThreadIds),
      journalRunIds: unique(journalRunIds),
      artifactIds: unique(artifactRows.map((row) => row.artifact_id)),
      threadIds: unique(threadIds),
      deletedThreadRunIds: unique(deletedThreadRunIds),
      auditIds: unique(auditIds),
    },
    blobCandidates: artifactRows.map((row) => ({ contentHash: row.content_hash, storagePath: row.storage_path })),
    counts: {
      events: eventCount,
      checkpoints: checkpointCount,
      journal: journalCount,
      artifacts: artifactRows.length,
      threads: threadIds.length,
      audit: auditIds.length,
    },
  };
  return { ...plan, planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

function deleteWhereIn(db, table, column, values) {
  if (!values.length) return 0;
  return db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(values)})`).run(...values).changes;
}

export function applyCleanupPlan({ db, plan }) {
  const removedPaths = [];
  const deleted = db.transaction(() => {
    const ids = plan.ids;
    const allRunIds = unique([...ids.eventRunIds, ...ids.journalRunIds, ...ids.deletedThreadRunIds]);
    const events = deleteWhereIn(db, "agent_events", "run_id", ids.eventRunIds);
    deleteWhereIn(db, "writes", "thread_id", ids.checkpointThreadIds);
    const checkpoints = deleteWhereIn(db, "checkpoints", "thread_id", ids.checkpointThreadIds);
    const journal = deleteWhereIn(db, "agent_step_journal", "run_id", ids.journalRunIds);
    deleteWhereIn(db, "agent_run_artifacts", "artifact_id", ids.artifactIds);
    deleteWhereIn(db, "agent_thread_artifacts", "artifact_id", ids.artifactIds);
    const artifacts = deleteWhereIn(db, "agent_artifacts", "artifact_id", ids.artifactIds);

    if (ids.deletedThreadRunIds.length) {
      deleteWhereIn(db, "agent_events", "run_id", ids.deletedThreadRunIds);
      deleteWhereIn(db, "agent_step_journal", "run_id", ids.deletedThreadRunIds);
      deleteWhereIn(db, "agent_run_artifacts", "run_id", ids.deletedThreadRunIds);
      deleteWhereIn(db, "agent_interactions", "run_id", ids.deletedThreadRunIds);
      deleteWhereIn(db, "agent_model_turns", "run_id", ids.deletedThreadRunIds);
    }
    deleteWhereIn(db, "agent_messages", "thread_id", ids.threadIds);
    deleteWhereIn(db, "agent_summaries", "thread_id", ids.threadIds);
    deleteWhereIn(db, "agent_thread_artifacts", "thread_id", ids.threadIds);
    deleteWhereIn(db, "agent_runs", "run_id", ids.deletedThreadRunIds);
    deleteWhereIn(db, "agent_legacy_imports", "thread_id", ids.threadIds);
    const threads = deleteWhereIn(db, "agent_threads", "thread_id", ids.threadIds);
    const audit = deleteWhereIn(db, "agent_audit", "audit_id", ids.auditIds);

    for (const blob of plan.blobCandidates) {
      if (!db.prepare("SELECT 1 FROM agent_artifacts WHERE content_hash=? LIMIT 1").get(blob.contentHash)) {
        db.prepare("DELETE FROM agent_artifact_blobs WHERE content_hash=?").run(blob.contentHash);
        removedPaths.push(blob.storagePath);
      }
    }
    return { events, checkpoints, journal, artifacts, threads, audit, runsConsidered: allRunIds.length };
  })();
  for (const storagePath of unique(removedPaths)) {
    try { fs.unlinkSync(storagePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return { ...deleted, blobs: unique(removedPaths).length };
}
