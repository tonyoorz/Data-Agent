import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { setupSqliteSaverForMigration } from "./checkpoint.mjs";

const migrationPath = new URL("./migrations/001-runtime.sql", import.meta.url);
// Keep this marker synchronized with the pinned @langchain/langgraph-checkpoint-sqlite package version.
const SAVER_VERSION = "langgraph-sqlite-1.0.3";

function configure(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function nowIso() {
  return new Date().toISOString();
}

function guardExpiry(leaseMs) {
  return new Date(Date.now() + leaseMs).toISOString();
}

function createRuntimeHandle(db) {
  const claimTx = db.transaction(({ ownerId, leaseMs }) => {
    const now = nowIso();
    const row = db.prepare("SELECT owner_id, lease_expires_at FROM agent_instance_guard WHERE guard_key='sqlite-single-instance'").get();
    if (row && row.owner_id !== ownerId && row.lease_expires_at > now) {
      throw new Error("SQLITE_SINGLE_INSTANCE_REQUIRED");
    }
    const leaseExpiresAt = guardExpiry(leaseMs);
    db.prepare("INSERT OR REPLACE INTO agent_instance_guard(guard_key, owner_id, lease_expires_at) VALUES('sqlite-single-instance', ?, ?)").run(ownerId, leaseExpiresAt);
    return { ownerId, leaseExpiresAt };
  });

  const renewTx = db.transaction(({ ownerId, leaseMs }) => {
    const leaseExpiresAt = guardExpiry(leaseMs);
    const result = db.prepare("UPDATE agent_instance_guard SET lease_expires_at=? WHERE guard_key='sqlite-single-instance' AND owner_id=?").run(leaseExpiresAt, ownerId);
    if (result.changes !== 1) throw new Error("SQLITE_SINGLE_INSTANCE_NOT_OWNER");
    return { ownerId, leaseExpiresAt };
  });

  const releaseTx = db.transaction(({ ownerId }) => db.prepare("DELETE FROM agent_instance_guard WHERE guard_key='sqlite-single-instance' AND owner_id=?").run(ownerId).changes === 1);

  return {
    db,
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
    claimSingleInstance: (input) => claimTx(input),
    renewSingleInstance: (input) => renewTx(input),
    releaseSingleInstance: (input) => releaseTx(input),
  };
}

export async function migrateRuntimeDb({ dbPath, targetVersion }) {
  if (targetVersion !== 1) throw new Error(`UNSUPPORTED_RUNTIME_SCHEMA_VERSION:${targetVersion}`);
  if (!fs.existsSync(migrationPath)) throw new Error("RUNTIME_MIGRATION_FILE_NOT_FOUND:001-runtime.sql");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    configure(db);
    db.exec(fs.readFileSync(migrationPath, "utf8"));
  } finally {
    db.close();
  }
  await setupSqliteSaverForMigration({ dbPath });
  const markerDb = new Database(dbPath);
  try {
    configure(markerDb);
    markerDb.prepare("INSERT OR REPLACE INTO agent_saver_migrations(version,applied_at) VALUES(?,?)").run(SAVER_VERSION, nowIso());
  } finally {
    markerDb.close();
  }
}

export function openRuntimeDb({ dbPath, expectedVersion }) {
  if (!fs.existsSync(dbPath)) throw new Error("RUNTIME_SCHEMA_NOT_READY:database_missing");
  const db = new Database(dbPath);
  configure(db);
  let version;
  try {
    version = db.prepare("SELECT MAX(version) FROM agent_schema_migrations").pluck().get();
  } catch {
    db.close();
    throw new Error("RUNTIME_SCHEMA_NOT_READY:migration_table_missing");
  }
  if (version !== expectedVersion) {
    db.close();
    throw new Error(`RUNTIME_SCHEMA_NOT_READY:expected=${expectedVersion}:actual=${version}`);
  }
  const saverReady = db.prepare("SELECT 1 FROM agent_saver_migrations WHERE version=?").pluck().get(SAVER_VERSION);
  if (!saverReady) {
    db.close();
    throw new Error("RUNTIME_SAVER_NOT_READY");
  }
  return createRuntimeHandle(db);
}

export function checkRuntimeDbReady({ dbPath, expectedVersion }) {
  if (!fs.existsSync(dbPath)) throw new Error("RUNTIME_SCHEMA_NOT_READY:database_missing");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = db.prepare("SELECT MAX(version) FROM agent_schema_migrations").pluck().get();
    if (version !== expectedVersion) throw new Error(`RUNTIME_SCHEMA_NOT_READY:expected=${expectedVersion}:actual=${version}`);
    const saverReady = db.prepare("SELECT 1 FROM agent_saver_migrations WHERE version=?").pluck().get(SAVER_VERSION);
    if (!saverReady) throw new Error("RUNTIME_SAVER_NOT_READY");
    return true;
  } finally {
    db.close();
  }
}