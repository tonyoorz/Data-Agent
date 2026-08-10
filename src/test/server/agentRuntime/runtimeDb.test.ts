// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateRuntimeDb, openRuntimeDb } from "../../../../server/agentRuntime/runtimeDb.mjs";

const roots: string[] = [];

const nextRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-"));
  roots.push(root);
  return root;
};

const nextDb = () => path.join(nextRoot(), "runtime.sqlite");
const hashFile = (filePath: string) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("Runtime SQLite", () => {
  it("requires the application and Saver offline migration before normal startup", async () => {
    const dbPath = nextDb();

    expect(() => openRuntimeDb({ dbPath, expectedVersion: 1 })).toThrow(/RUNTIME_SCHEMA_NOT_READY/);
    await migrateRuntimeDb({ dbPath, targetVersion: 1 });
    const runtime = openRuntimeDb({ dbPath, expectedVersion: 1 });

    expect(runtime.db.prepare("SELECT MAX(version) FROM agent_schema_migrations").pluck().get()).toBe(1);
    expect(runtime.db.prepare("SELECT version FROM agent_saver_migrations").pluck().get()).toBe("langgraph-sqlite-1.0.3");
    expect(runtime.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(String(runtime.db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    runtime.close();
  });

  it("keeps application SQL away from Saver-private tables", () => {
    const sql = fs.readFileSync("server/agentRuntime/migrations/001-runtime.sql", "utf8");
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:checkpoints|writes)\b/i);
    const created = [...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi)].map((match) => match[1]);
    expect(created.length).toBeGreaterThan(10);
    expect(created.every((name) => name.startsWith("agent_"))).toBe(true);
  });

  it("fails startup when only the application marker exists", () => {
    const dbPath = nextDb();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE agent_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO agent_schema_migrations VALUES(1,'now'); CREATE TABLE agent_saver_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
    } finally {
      db.close();
    }

    expect(() => openRuntimeDb({ dbPath, expectedVersion: 1 })).toThrow(/RUNTIME_SAVER_NOT_READY/);
  });

  it("claims, renews and releases the SQLite single-instance guard", async () => {
    const dbPath = nextDb();
    await migrateRuntimeDb({ dbPath, targetVersion: 1 });
    const runtime = openRuntimeDb({ dbPath, expectedVersion: 1 });
    try {
      const first = runtime.claimSingleInstance({ ownerId: "owner-a", leaseMs: 60_000 });
      expect(first.ownerId).toBe("owner-a");
      expect(() => runtime.claimSingleInstance({ ownerId: "owner-b", leaseMs: 60_000 })).toThrow(/SQLITE_SINGLE_INSTANCE_REQUIRED/);
      runtime.renewSingleInstance({ ownerId: "owner-a", leaseMs: 60_000 });
      expect(runtime.releaseSingleInstance({ ownerId: "owner-a" })).toBe(true);
      expect(runtime.claimSingleInstance({ ownerId: "owner-b", leaseMs: 60_000 }).ownerId).toBe("owner-b");
    } finally {
      runtime.close();
    }
  });

  it("supports CLI migration and --check without changing the DB", () => {
    const dbPath = nextDb();
    execFileSync(process.execPath, ["scripts/migrateAgentRuntime.mjs", "--db-path", dbPath], { stdio: "pipe" });
    const beforeHash = hashFile(dbPath);
    const beforeMtime = fs.statSync(dbPath).mtimeMs;
    execFileSync(process.execPath, ["scripts/migrateAgentRuntime.mjs", "--check", "--db-path", dbPath], { stdio: "pipe" });
    expect(hashFile(dbPath)).toBe(beforeHash);
    expect(fs.statSync(dbPath).mtimeMs).toBe(beforeMtime);
  });
});