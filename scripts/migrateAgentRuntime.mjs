#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { checkRuntimeDbReady, migrateRuntimeDb } from "../server/agentRuntime/runtimeDb.mjs";

function parseArgs(argv) {
  const args = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg === "--db-path") args.dbPath = argv[++index];
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!args.dbPath) throw new Error("DB_PATH_REQUIRED");
  return args;
}

function configure(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function assertNoLiveGuardOnConnection(db) {
  try {
    const row = db.prepare("SELECT owner_id, lease_expires_at FROM agent_instance_guard WHERE guard_key='sqlite-single-instance'").get();
    if (row && row.lease_expires_at > new Date().toISOString()) throw new Error("RUNTIME_DB_IN_USE");
  } catch (error) {
    if (String(error?.message || error).includes("no such table")) return;
    throw error;
  }
}

async function backupExisting(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace(/Z$/, "Z");
  const backupPath = `${dbPath}.backup-${stamp}`;
  const db = new Database(dbPath, { fileMustExist: true });
  let transactionOpen = false;
  try {
    configure(db);
    db.prepare("BEGIN IMMEDIATE").run();
    transactionOpen = true;
    assertNoLiveGuardOnConnection(db);
    await db.backup(backupPath);
    db.prepare("COMMIT").run();
    transactionOpen = false;
    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = backupDb.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`BACKUP_INTEGRITY_FAILED:${integrity}`);
    } finally {
      backupDb.close();
    }
    return backupPath;
  } finally {
    if (transactionOpen) {
      try { db.prepare("ROLLBACK").run(); } catch {}
    }
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(args.dbPath);
  if (args.check) {
    checkRuntimeDbReady({ dbPath, expectedVersion: 1 });
    console.log(JSON.stringify({ ok: true, dbPath, check: true }));
    return;
  }
  const backupPath = await backupExisting(dbPath);
  await migrateRuntimeDb({ dbPath, targetVersion: 1 });
  checkRuntimeDbReady({ dbPath, expectedVersion: 1 });
  console.log(JSON.stringify({ ok: true, dbPath, schemaVersion: 1, ...(backupPath ? { backupPath } : {}) }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});