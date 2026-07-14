import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export async function setupSqliteSaverForMigration({ dbPath }) {
  const saver = SqliteSaver.fromConnString(dbPath);
  if (!saver.db || typeof saver.setup !== "function") throw new Error("SQLITE_SAVER_API_UNSUPPORTED");
  try {
    // This protected method is intentionally called only by the offline migration path for the pinned 1.0.3 Saver.
    saver.setup();
    await saver.deleteThread("__migration_probe__");
  } finally {
    saver.db.close();
  }
}

export function createReadySqliteSaver({ dbPath, runtimeDb }) {
  const ready = runtimeDb.db.prepare("SELECT 1 FROM agent_saver_migrations WHERE version=?").pluck().get("langgraph-sqlite-1.0.3");
  if (!ready) throw new Error("RUNTIME_SAVER_NOT_READY");
  // Caller owns the returned Saver and must close saver.db during Runtime shutdown.
  const saver = SqliteSaver.fromConnString(dbPath);
  saver.close = () => saver.db.close();
  return saver;
}

export const checkpointConfig = ({ threadId, checkpointId }) => ({
  configurable: {
    thread_id: threadId,
    checkpoint_ns: "",
    ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
  },
});

function fail(code) {
  throw Object.assign(new Error(code), { code, retryable: false });
}

export function createCheckpointCoordinator({ saver, threadStore, graphDefinitionVersion, projectCommittedTransitions, hashState }) {
  function assertGraphVersion(run) {
    if (run.graphDefinitionVersion !== graphDefinitionVersion) fail("GRAPH_VERSION_MISMATCH");
  }

  function canonicalConfigForRun(run) {
    assertGraphVersion(run);
    if (run.canonicalCheckpointId) return checkpointConfig({ threadId: run.threadId, checkpointId: run.canonicalCheckpointId });
    if (run.stateVersion === 0) return checkpointConfig({ threadId: run.threadId });
    fail("CANONICAL_CHECKPOINT_MISSING");
  }

  async function ensureCheckpointCaughtUp({ graph, run }) {
    const config = canonicalConfigForRun(run);
    if (!run.canonicalCheckpointId && run.stateVersion === 0) return { config, checkpointId: undefined, stateHash: undefined };
    const state = await graph.getState(config);
    const currentValues = state?.values || state?.checkpoint?.channel_values || {};
    const projected = projectCommittedTransitions(currentValues, run);
    const stateHash = hashState(projected);
    if (stateHash === run.canonicalStateHash) return { config, checkpointId: run.canonicalCheckpointId, stateHash };
    const candidateConfig = await graph.updateState(config, projected);
    const checkpointId = candidateConfig?.configurable?.checkpoint_id;
    if (!checkpointId) fail("CANDIDATE_CHECKPOINT_MISSING");
    const promoted = await threadStore.promoteCanonicalCheckpoint({ runId: run.runId, expectedStateVersion: run.stateVersion, leaseEpoch: run.leaseEpoch, checkpointId, stateHash });
    const canonicalCheckpointId = promoted?.canonicalCheckpointId || checkpointId;
    return { config: checkpointConfig({ threadId: run.threadId, checkpointId: canonicalCheckpointId }), checkpointId: canonicalCheckpointId, stateHash };
  }

  return Object.freeze({ saver, canonicalConfigForRun, ensureCheckpointCaughtUp });
}