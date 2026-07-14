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
  return SqliteSaver.fromConnString(dbPath);
}

export const checkpointConfig = ({ threadId, checkpointId }) => ({
  configurable: {
    thread_id: threadId,
    checkpoint_ns: "",
    ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
  },
});