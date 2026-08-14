import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  reconcileSchema,
  fingerprintTableSchema,
  createOntologyVersioning,
} from "../../../../server/ontology/driftReconciler.mjs";

const NOW = () => new Date("2026-08-15T03:00:00.000Z");

const CATALOG = {
  metrics: [{ name: "defect_count", table: "defects", column: "id", formula: "COUNT(id)" }],
  dimensions: [{ name: "severity", table: "defects", column: "severity" }],
  terms: [{ name: "严重缺陷", table: "defects", column: "severity" }],
};

describe("schema drift reconciler", () => {
  const registered = {
    defects: fingerprintTableSchema({
      table: "defects",
      columns: [
        { name: "id", type: "integer" },
        { name: "severity", type: "text", enum: ["Critical", "High", "Medium"] },
        { name: "assigned_ecu", type: "text" },
      ],
    }),
  };

  it("reports aligned when observed matches registered", () => {
    const report = reconcileSchema({ observed: registered, registered, catalog: CATALOG });
    expect(report.status).toBe("aligned");
    expect(report.counts.critical).toBe(0);
  });

  it("flags removed governed column as critical with affected catalog", () => {
    const observed = {
      defects: fingerprintTableSchema({
        table: "defects",
        columns: [
          { name: "id", type: "integer" },
          { name: "assigned_ecu", type: "text" },
        ],
      }),
    };
    const report = reconcileSchema({ observed, registered, catalog: CATALOG });
    expect(report.status).toBe("action_required");
    const removed = report.drift.find((item) => item.kind === "column_removed");
    expect(removed?.column).toBe("severity");
    expect(removed.affected).toContain("dimension:severity");
    expect(removed.affected).toContain("term:严重缺陷");
  });

  it("flags type change and enum value loss as major", () => {
    const observed = {
      defects: fingerprintTableSchema({
        table: "defects",
        columns: [
          { name: "id", type: "bigint" },
          { name: "severity", type: "text", enum: ["Critical", "High"] },
          { name: "assigned_ecu", type: "text" },
        ],
      }),
    };
    const report = reconcileSchema({ observed, registered, catalog: CATALOG });
    expect(report.counts.major).toBeGreaterThanOrEqual(2);
    expect(report.drift.some((item) => item.kind === "column_type_changed" && item.column === "id")).toBe(true);
    expect(report.drift.some((item) => item.kind === "enum_value_removed" && item.column === "severity")).toBe(true);
  });

  it("treats new tables and enum additions as info", () => {
    const observed = {
      ...registered,
      audits: fingerprintTableSchema({ table: "audits", columns: [{ name: "id", type: "integer" }] }),
      defects: fingerprintTableSchema({
        table: "defects",
        columns: [
          { name: "id", type: "integer" },
          { name: "severity", type: "text", enum: ["Critical", "High", "Medium", "Low"] },
          { name: "assigned_ecu", type: "text" },
        ],
      }),
    };
    const report = reconcileSchema({ observed, registered, catalog: CATALOG });
    expect(report.status).toBe("aligned");
    expect(report.drift.some((item) => item.kind === "table_added" && item.table === "audits")).toBe(true);
    expect(report.drift.some((item) => item.kind === "enum_value_added" && item.column === "severity")).toBe(true);
  });

  it("flags governed table removal as critical", () => {
    const report = reconcileSchema({ observed: {}, registered, catalog: CATALOG });
    expect(report.drift[0].kind).toBe("table_removed");
    expect(report.status).toBe("action_required");
  });
});

describe("ontology versioning", () => {
  const catalogV1 = {
    entities: [{ name: "Defect" }],
    metrics: [{ name: "defect_count" }, { name: "reopen_rate" }],
    dimensions: [{ name: "severity" }],
    terms: [],
    relations: [],
  };

  it("publishes, diffs and rolls back between versions", async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), "onto-versions-"));
    const versioning = createOntologyVersioning({ storeDir, now: NOW });

    await versioning.publish({ version: "v1", catalog: catalogV1 });

    const catalogV2 = {
      ...catalogV1,
      metrics: [{ name: "defect_count" }, { name: "escape_rate" }],
      dimensions: [{ name: "severity" }, { name: "assigned_ecu" }],
    };
    await versioning.publish({ version: "v2", catalog: catalogV2 });

    const diff = await versioning.diff("v1", "v2");
    const added = diff.changes.filter((change) => change.kind === "added").map((change) => change.name);
    const removed = diff.changes.filter((change) => change.kind === "removed").map((change) => change.name);
    expect(added).toContain("escape_rate");
    expect(added).toContain("assigned_ecu");
    expect(removed).toContain("reopen_rate");

    const shadow = await versioning.shadowCompare("v1", "v2", ["上月缺陷趋势"]);
    expect(shadow.results[0].planChanged).toBe(true);
  });

  it("rejects duplicate versions", async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), "onto-versions-"));
    const versioning = createOntologyVersioning({ storeDir, now: NOW });
    await versioning.publish({ version: "v1", catalog: catalogV1 });
    await expect(versioning.publish({ version: "v1", catalog: catalogV1 })).rejects.toThrow("already exists");
  });
});
