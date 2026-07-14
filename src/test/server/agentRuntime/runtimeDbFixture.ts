import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateRuntimeDb, openRuntimeDb } from "../../../../server/agentRuntime/runtimeDb.mjs";

export async function createRuntimeDbFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-fixture-"));
  const dbPath = path.join(root, "runtime.sqlite");
  await migrateRuntimeDb({ dbPath, targetVersion: 1 });
  const runtimeDb = openRuntimeDb({ dbPath, expectedVersion: 1 });
  return {
    root,
    dbPath,
    runtimeDb,
    cleanup() {
      runtimeDb.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}