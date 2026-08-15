// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxSqlGuard, isSandboxSqlEnabled } from "../../../../server/ontology/sandboxSql.mjs";

describe("Sandbox SQL guard", () => {
  let tmpDir = "";
  let dbRoot = "";
  const missingRoot = "";

  const defectEntity = {
    id: "quality.defect",
    primaryKey: "id",
    properties: [
      { id: "id", type: "integer", nullable: false, sensitivity: "internal" },
      { id: "severity", type: "string", nullable: true, sensitivity: "internal" },
      { id: "workspace", type: "string", nullable: true, sensitivity: "internal" },
    ],
    source: { sourceId: "analytics.full_picture_defects", system: "analytics", table: "octane_defects" },
  };
  const testRunEntity = {
    id: "testing.test_run",
    primaryKey: "id",
    properties: [
      { id: "id", type: "integer", nullable: false, sensitivity: "internal" },
      { id: "workspace", type: "string", nullable: true, sensitivity: "internal" },
    ],
    source: { sourceId: "analytics.testing_coverage", system: "analytics", table: "octane_manual_runs" },
  };

  function buildRegistry() {
    return {
      getPolicy: (id) => {
        if (id !== "actor.scope.mandatory") throw new Error(`ONTOLOGY_POLICY_NOT_FOUND:${id}`);
        return {
          id,
          governance: { status: "approved", owner: "Agent Security" },
          rules: [
            {
              scopeKey: "workspaceIds",
              entityId: "quality.defect",
              dimensionId: "org.workspace",
              intents: ["explore", "list", "aggregate"],
              normalizer: "identity",
            },
          ],
        };
      },
      getDimension: (id) => {
        if (id !== "org.workspace") throw new Error(`ONTOLOGY_DIMENSION_NOT_FOUND:${id}`);
        return { id, entityId: "quality.defect", propertyId: "workspace", type: "categorical" };
      },
      getEntity: (id) => {
        const entity = [defectEntity, testRunEntity].find((item) => item.id === id);
        if (!entity) throw new Error(`ONTOLOGY_ENTITY_NOT_FOUND:${id}`);
        return entity;
      },
      bundle: {
        sources: [
          { id: "analytics.full_picture_defects", system: "analytics", database: "fixture.db", table: "octane_defects", governance: { status: "approved" } },
          { id: "analytics.testing_coverage", system: "analytics", database: "fixture.db", table: "octane_manual_runs", governance: { status: "approved" } },
          { id: "analytics.draft_source", system: "analytics", database: "fixture.db", table: "draft_table", governance: { status: "draft" } },
          { id: "duplicate.defect_index", system: "duplicate-search", database: "fixture.db", table: "embedding_cache", governance: { status: "approved" } },
        ],
        entities: [defectEntity, testRunEntity],
      },
    };
  }

  const scopedActor = { id: "actor-1", scopes: { workspaceIds: ["ws_cn"] } };
  const unscopedActor = { id: "actor-2", scopes: {} };
  let guard: ReturnType<typeof createSandboxSqlGuard>;
  let missingDbGuard: ReturnType<typeof createSandboxSqlGuard>;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-sql-"));
    const dbPath = path.join(tmpDir, "fixture.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE octane_defects (id INTEGER PRIMARY KEY, severity TEXT, workspace TEXT)");
    db.exec("CREATE TABLE octane_manual_runs (id INTEGER PRIMARY KEY, workspace TEXT)");
    const insertDefect = db.prepare("INSERT INTO octane_defects (severity, workspace) VALUES (?, ?)");
    insertDefect.run("critical", "ws_cn");
    insertDefect.run("major", "ws_cn");
    insertDefect.run("minor", "ws_us");
    db.prepare("INSERT INTO octane_manual_runs (workspace) VALUES (?)").run("ws_cn");
    db.close();
    dbRoot = tmpDir;
    guard = createSandboxSqlGuard({ registry: buildRegistry(), dbRoot });
    missingDbGuard = createSandboxSqlGuard({ registry: buildRegistry(), dbRoot: missingRoot });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts a governed SELECT and extracts joined tables", () => {
    const verdict = guard.validate({
      sql: "SELECT d.id, r.id AS run_id FROM octane_defects d JOIN octane_manual_runs r ON d.workspace = r.workspace WHERE d.severity = 'critical'",
      actor: scopedActor,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.tables).toEqual(["octane_defects", "octane_manual_runs"]);
    expect(verdict.scopeFilters).toHaveLength(1);
    expect(verdict.scopeFilters[0]).toMatchObject({ dimensionId: "org.workspace", operator: "in", values: ["ws_cn"], source: "policy" });
  });

  it("does not flag CTE aliases as physical tables", () => {
    const verdict = guard.validate({
      sql: "WITH recent AS (SELECT * FROM octane_defects) SELECT * FROM recent WHERE severity = 'critical'",
      actor: scopedActor,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.tables).toEqual(["octane_defects"]);
  });

  it("handles multiple and quoted CTE aliases", () => {
    const verdict = guard.validate({
      sql: 'WITH a AS (SELECT id FROM octane_defects), b AS (SELECT workspace FROM octane_defects) SELECT a.id FROM a JOIN b ON 1=1 JOIN octane_manual_runs r ON r.workspace = b.workspace',
      actor: scopedActor,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.tables).toEqual(["octane_defects", "octane_manual_runs"]);
  });

  it("ignores keywords inside string literals (DELETE/;/DROP)", () => {
    const verdict = guard.validate({
      sql: "SELECT * FROM octane_defects WHERE severity = 'delete from x; drop table octane_defects'",
      actor: scopedActor,
    });
    expect(verdict.ok).toBe(true);
  });

  it("ignores keywords inside line and block comments", () => {
    const verdict = guard.validate({
      sql: "SELECT * FROM octane_defects -- DELETE FROM octane_defects\n /* UPDATE x SET y=1 */ WHERE id = 1",
      actor: scopedActor,
    });
    expect(verdict.ok).toBe(true);
  });

  it("accepts quoted table identifiers", () => {
    const verdict = guard.validate({ sql: 'SELECT * FROM "octane_defects" WHERE id = 1', actor: scopedActor });
    expect(verdict.ok).toBe(true);
    expect(verdict.tables).toEqual(["octane_defects"]);
  });

  it("descends into FROM subqueries one level", () => {
    const verdict = guard.validate({
      sql: "SELECT * FROM (SELECT workspace FROM octane_defects) sub WHERE sub.workspace = 'ws_cn'",
      actor: scopedActor,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.tables).toEqual(["octane_defects"]);
  });

  it("rejects table-valued functions like table(...)", () => {
    const verdict = guard.validate({ sql: "SELECT * FROM table(octane_defects)", actor: scopedActor });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("SANDBOX_TABLE_NOT_GOVERNED:table");
  });

  it("rejects json_each style table functions", () => {
    const verdict = guard.validate({ sql: "SELECT * FROM json_each('[1,2]')", actor: scopedActor });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("SANDBOX_TABLE_NOT_GOVERNED:json_each");
  });

  it("rejects sqlite_master and non-governed tables", () => {
    expect(guard.validate({ sql: "SELECT * FROM sqlite_master", actor: scopedActor }).reason)
      .toBe("SANDBOX_TABLE_NOT_GOVERNED:sqlite_master");
    const draft = guard.validate({ sql: "SELECT * FROM draft_table", actor: scopedActor });
    expect(draft.ok).toBe(false);
    expect(draft.reason).toBe("SANDBOX_TABLE_NOT_GOVERNED:draft_table");
    const wrongSystem = guard.validate({ sql: "SELECT * FROM embedding_cache", actor: scopedActor });
    expect(wrongSystem.ok).toBe(false);
    expect(wrongSystem.reason).toBe("SANDBOX_TABLE_NOT_GOVERNED:embedding_cache");
    const unknown = guard.validate({ sql: "SELECT * FROM users", actor: scopedActor });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe("SANDBOX_TABLE_NOT_GOVERNED:users");
  });

  it("rejects multiple statements", () => {
    const verdict = guard.validate({ sql: "SELECT 1 FROM octane_defects; SELECT 2 FROM octane_defects", actor: scopedActor });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("SANDBOX_MULTI_STATEMENT");
    const trailing = guard.validate({ sql: "SELECT id FROM octane_defects;", actor: scopedActor });
    expect(trailing.ok).toBe(true);
  });

  it("rejects PRAGMA and ATTACH in any position", () => {
    expect(guard.validate({ sql: "PRAGMA table_info(octane_defects)", actor: scopedActor }).ok).toBe(false);
    expect(guard.validate({ sql: "ATTACH DATABASE 'x.db' AS x", actor: scopedActor }).ok).toBe(false);
    const smuggled = guard.validate({
      sql: "WITH t AS (SELECT 1) INSERT INTO octane_defects SELECT * FROM t",
      actor: scopedActor,
    });
    expect(smuggled.ok).toBe(false);
    expect(smuggled.reason).toBe("SANDBOX_FORBIDDEN_TOKEN:INSERT");
    const pragmaFn = guard.validate({
      sql: "SELECT * FROM octane_defects WHERE id IN (SELECT id FROM pragma_table_info('octane_defects'))",
      actor: scopedActor,
    });
    expect(pragmaFn.ok).toBe(false);
    expect(pragmaFn.reason).toBe("SANDBOX_TABLE_NOT_GOVERNED:pragma_table_info");
    const internalRef = guard.validate({ sql: "SELECT sqlite_version() AS v", actor: scopedActor });
    expect(internalRef.ok).toBe(false);
    expect(internalRef.reason).toBe("SANDBOX_FORBIDDEN_TOKEN:SQLITE_INTERNAL");
  });

  it("rejects load_extension and file: URIs", () => {
    const extension = guard.validate({ sql: "SELECT load_extension('x') FROM octane_defects", actor: scopedActor });
    expect(extension.ok).toBe(false);
    expect(extension.reason).toBe("SANDBOX_FORBIDDEN_TOKEN:load_extension");
    const fileUri = guard.validate({ sql: "ATTACH 'file:foo.db' AS f", actor: scopedActor });
    expect(fileUri.ok).toBe(false);
  });

  it("rejects non-SELECT/WITH leading tokens", () => {
    expect(guard.validate({ sql: "UPDATE octane_defects SET severity = 'x'", actor: scopedActor }).reason)
      .toBe("SANDBOX_NON_SELECT");
    expect(guard.validate({ sql: "DELETE FROM octane_defects", actor: scopedActor }).reason)
      .toBe("SANDBOX_NON_SELECT");
    expect(guard.validate({ sql: "", actor: scopedActor }).reason).toBe("SANDBOX_NON_SELECT");
  });

  it("rewriteSql wraps the query with mandatory IN filters", () => {
    const verdict = guard.validate({ sql: "SELECT * FROM octane_defects", actor: scopedActor, intent: "list" });
    expect(verdict.ok).toBe(true);
    expect(verdict.scopeFilters.map((filter) => filter.dimensionId)).toEqual(["org.workspace"]);
    const rewritten = guard.rewriteSql("SELECT * FROM octane_defects", verdict.scopeFilters);
    expect(rewritten).toContain("AS sandbox_outer");
    expect(rewritten).toContain(`WHERE "workspace" IN ('ws_cn')`);
  });

  it("rewriteSql leaves SQL untouched when mandatory filters are empty", () => {
    const verdict = guard.validate({ sql: "SELECT * FROM octane_defects", actor: unscopedActor, intent: "explore" });
    expect(verdict.ok).toBe(true);
    expect(verdict.scopeFilters).toEqual([]);
    expect(guard.rewriteSql("SELECT * FROM octane_defects", verdict.scopeFilters)).toBe("SELECT * FROM octane_defects");
  });

  it("dryRun returns an EXPLAIN plan without executing", async () => {
    const result = await guard.dryRun({ sql: "SELECT * FROM octane_defects", actor: scopedActor });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.plan)).toBe(true);
    expect(result.plan.length).toBeGreaterThan(0);
    expect(result.plan[0].detail).toContain("octane_defects");
    expect(result.previewSql).toContain("LIMIT 500");
    expect(result.previewSql).toContain(`"workspace" IN ('ws_cn')`);
    expect(result.tables).toEqual(["octane_defects"]);
    expect(result.scopeFilters).toHaveLength(1);
  });

  it("dryRun keeps an existing LIMIT instead of appending 500", async () => {
    const result = await guard.dryRun({ sql: "SELECT * FROM octane_defects LIMIT 2", actor: scopedActor });
    expect(result.ok).toBe(true);
    expect(result.previewSql).not.toContain("LIMIT 500");
    expect(result.previewSql).toContain(`"workspace" IN ('ws_cn')`);
  });

  it("dryRun reports unavailable sources", async () => {
    const result = await missingDbGuard.dryRun({ sql: "SELECT * FROM octane_defects", actor: scopedActor });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("SANDBOX_SOURCE_UNAVAILABLE");
  });

  it("execute applies the mandatory workspace filter", async () => {
    const result = await guard.execute({ sql: "SELECT id, severity, workspace FROM octane_defects", actor: scopedActor });
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.rows.every((row) => row.workspace === "ws_cn")).toBe(true);
    expect(result.columns).toEqual(["id", "severity", "workspace"]);
    expect(result.truncated).toBe(false);
  });

  it("execute truncates at the row limit", async () => {
    const result = await guard.execute({ sql: "SELECT * FROM octane_defects", actor: unscopedActor, limit: 2 });
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("execute converts runtime errors to ok:false", async () => {
    const result = await guard.execute({ sql: "SELECT missing_column FROM octane_defects", actor: scopedActor });
    expect(result.ok).toBe(false);
    expect(result.reason.startsWith("SANDBOX_EXEC_ERROR:")).toBe(true);
    expect(result.reason).toContain("missing_column");
  });

  it("respects a user LIMIT smaller than the cap", async () => {
    const result = await guard.execute({ sql: "SELECT * FROM octane_defects LIMIT 1", actor: unscopedActor });
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("isEnabled gates on VIZION_SANDBOX_SQL=1", () => {
    expect(isSandboxSqlEnabled({ VIZION_SANDBOX_SQL: "1" })).toBe(true);
    expect(isSandboxSqlEnabled({ VIZION_SANDBOX_SQL: "0" })).toBe(false);
    expect(isSandboxSqlEnabled({ VIZION_SANDBOX_SQL: "true" })).toBe(false);
    expect(isSandboxSqlEnabled({})).toBe(false);
    expect(guard.isEnabled({ VIZION_SANDBOX_SQL: "1" })).toBe(true);
    expect(guard.isEnabled()).toBe(process.env.VIZION_SANDBOX_SQL === "1");
  });
});
