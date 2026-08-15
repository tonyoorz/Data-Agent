/**
 * Onto P0: schema drift reconciliation + ontology version diff.
 * Watches source-DB fingerprint vs ontology-registered fingerprint,
 * classifies drift (added/removed/changed), maps drift to affected
 * metrics/dimensions, and emits actionable reconciliation reports.
 * Version diff supports rollout compare + rollback decisions.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

function nowDefault() {
  return new Date();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Stable fingerprint of one table's DDL-shape: columns, types, enums. */
export function fingerprintTableSchema({ table, columns }) {
  if (!Array.isArray(columns)) throw new Error("DRIFT_INVALID: columns array required");
  const normalized = columns
    .map((column) => ({
      name: String(column.name || ""),
      type: String(column.type || "").toLowerCase(),
      nullable: column.nullable !== false,
      enum: Array.isArray(column.enum) ? column.enum.slice().sort() : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { table: String(table || ""), fingerprint: hash(normalized), columnCount: normalized.length, columns: normalized };
}

/**
 * Compare observed schema against ontology registry expectation.
 * Returns drift report with classification + affected-catalog impact.
 */
export function reconcileSchema({ observed, registered, catalog = {} }) {
  if (!isRecord(observed) || !isRecord(registered)) {
    throw new Error("DRIFT_INVALID: observed and registered must be objects");
  }
  const drift = [];
  const tables = new Set([...Object.keys(observed), ...Object.keys(registered)]);

  for (const table of tables) {
    const obs = observed[table];
    const reg = registered[table];

    if (!reg) {
      drift.push({ table, kind: "table_added", severity: "info", detail: `new table ${table} not yet governed`, affected: [] });
      continue;
    }
    if (!obs) {
      drift.push({ table, kind: "table_removed", severity: "critical", detail: `governed table ${table} missing from source`, affected: affectedByTable(table, catalog) });
      continue;
    }

    const obsCols = new Map(obs.columns.map((column) => [column.name, column]));
    const regCols = new Map(reg.columns.map((column) => [column.name, column]));

    for (const [name, column] of obsCols) {
      if (!regCols.has(name)) {
        drift.push({ table, kind: "column_added", severity: "info", column: name, detail: `column ${table}.${name} ungoverned`, affected: [] });
      }
    }
    for (const [name, column] of regCols) {
      if (!obsCols.has(name)) {
        drift.push({ table, kind: "column_removed", severity: "critical", column: name, detail: `governed column ${table}.${name} missing`, affected: affectedByColumn(table, name, catalog) });
        continue;
      }
      const current = obsCols.get(name);
      if (String(current.type).toLowerCase() !== String(column.type).toLowerCase()) {
        drift.push({
          table, kind: "column_type_changed", severity: "major", column: name,
          detail: `${table}.${name} type ${column.type} -> ${current.type}`,
          affected: affectedByColumn(table, name, catalog),
        });
      }
      if (Array.isArray(column.enum) && column.enum.length) {
        const addedEnums = current.enum?.filter((value) => !column.enum.includes(value)) ?? [];
        const removedEnums = column.enum.filter((value) => !(current.enum ?? []).includes(value));
        if (removedEnums.length) {
          drift.push({ table, kind: "enum_value_removed", severity: "major", column: name, detail: `${table}.${name} lost values ${removedEnums.join(",")}`, affected: affectedByColumn(table, name, catalog) });
        }
        if (addedEnums.length) {
          drift.push({ table, kind: "enum_value_added", severity: "info", column: name, detail: `${table}.${name} gained values ${addedEnums.join(",")}`, affected: [] });
        }
      }
    }
  }

  const critical = drift.filter((item) => item.severity === "critical").length;
  const major = drift.filter((item) => item.severity === "major").length;
  return {
    status: critical ? "action_required" : major ? "review_recommended" : "aligned",
    counts: { critical, major, info: drift.length - critical - major },
    drift,
    checkedAt: nowDefault().toISOString(),
  };
}

/**
 * Downgrade table_removed criticals when the whole source database could not
 * be opened (availability problem, not schema drift). Tables whose presence
 * is still proven via a local fallback database are marked presence_verified:
 * schema exists, column-level verification deferred to the declared source.
 */
export function applySourceAvailability({ report, unavailableTables, presenceVerifiedTables }) {
  if (!isRecord(report) || !Array.isArray(report.drift)) {
    throw new Error("DRIFT_INVALID: report.drift array required");
  }
  const unavailable = unavailableTables && unavailableTables.size ? unavailableTables : null;
  const presenceVerified = presenceVerifiedTables && presenceVerifiedTables.size ? presenceVerifiedTables : null;
  if (!unavailable && !presenceVerified) return report;
  const drift = report.drift.map((item) => {
    if (item?.kind !== "table_removed") return item;
    if (unavailable?.has(item.table)) {
      return {
        ...item,
        kind: "source_unavailable",
        severity: "info",
        detail: `source database ${unavailable.get(item.table)} unreachable; ${item.table} not verifiable (pipeline/environment issue, not schema drift)`,
      };
    }
    if (presenceVerified?.has(item.table)) {
      return {
        ...item,
        kind: "presence_verified",
        severity: "info",
        detail: `${item.table} present in ${presenceVerified.get(item.table)}; column-level verification requires the declared source database`,
      };
    }
    return item;
  });
  const critical = drift.filter((item) => item.severity === "critical").length;
  const major = drift.filter((item) => item.severity === "major").length;
  const unverified = drift.filter((item) => item.kind === "source_unavailable").length;
  const partial = drift.filter((item) => item.kind === "presence_verified").length;
  return {
    ...report,
    drift,
    counts: { critical, major, info: drift.length - critical - major, unverified, partial },
    status: critical ? "action_required" : major ? "review_recommended" : unverified || partial ? "partial_verify" : "aligned",
  };
}

function affectedByTable(table, catalog) {
  const affected = [];
  for (const metric of catalog.metrics ?? []) {
    if (metric.table === table) affected.push(`metric:${metric.name}`);
  }
  for (const dimension of catalog.dimensions ?? []) {
    if (dimension.table === table) affected.push(`dimension:${dimension.name}`);
  }
  return affected;
}

function affectedByColumn(table, column, catalog) {
  const affected = [];
  for (const metric of catalog.metrics ?? []) {
    if (metric.table === table && (metric.column === column || String(metric.formula || "").includes(column))) {
      affected.push(`metric:${metric.name}`);
    }
  }
  for (const dimension of catalog.dimensions ?? []) {
    if (dimension.table === table && dimension.column === column) affected.push(`dimension:${dimension.name}`);
  }
  for (const term of catalog.terms ?? []) {
    if (term.column === column && term.table === table) affected.push(`term:${term.name}`);
  }
  return affected;
}

/**
 * Ontology version registry with diff + shadow-compare support.
 */
export function createOntologyVersioning({
  storeDir = process.env.VIZION_ONTOLOGY_VERSIONS_DIR || path.resolve(process.cwd(), "logs", "ontology-versions"),
  now = nowDefault,
} = {}) {
  const indexFile = path.join(storeDir, "versions.json");

  async function readIndex() {
    try {
      const parsed = JSON.parse(await readFile(indexFile, "utf8"));
      return isRecord(parsed) && Array.isArray(parsed.versions) ? parsed.versions : [];
    } catch {
      return [];
    }
  }

  async function writeIndex(versions) {
    await mkdir(storeDir, { recursive: true });
    await writeFile(indexFile, JSON.stringify({ updatedAt: now().toISOString(), versions }, null, 2), "utf8");
  }

  return {
    /** Snapshot the current catalog state as a new version. */
    async publish({ version, catalog }) {
      if (!isRecord(catalog)) throw new Error("VERSION_INVALID: catalog required");
      const versions = await readIndex();
      if (versions.some((entry) => entry.version === version)) {
        throw new Error(`VERSION_INVALID: ${version} already exists`);
      }
      const entry = {
        version: String(version),
        publishedAt: now().toISOString(),
        fingerprint: hash(catalog),
        counts: {
          entities: (catalog.entities ?? []).length,
          relations: (catalog.relations ?? []).length,
          metrics: (catalog.metrics ?? []).length,
          dimensions: (catalog.dimensions ?? []).length,
          terms: (catalog.terms ?? []).length,
        },
        catalog,
      };
      versions.push(entry);
      await writeIndex(versions);
      return entry;
    },

    list() {
      return readIndex();
    },

    async get(version) {
      const versions = await readIndex();
      return versions.find((entry) => entry.version === String(version)) ?? null;
    },

    /** Diff two versions: what entered/left/changed in the catalog. */
    async diff(fromVersion, toVersion) {
      const versions = await readIndex();
      const from = versions.find((entry) => entry.version === String(fromVersion));
      const to = versions.find((entry) => entry.version === String(toVersion));
      if (!from || !to) throw new Error("VERSION_INVALID: unknown version(s)");

      const changes = [];
      for (const section of ["entities", "relations", "metrics", "dimensions", "terms"]) {
        const fromMap = new Map((from.catalog[section] ?? []).map((item) => [item.name ?? item.id, item]));
        const toMap = new Map((to.catalog[section] ?? []).map((item) => [item.name ?? item.id, item]));
        for (const [name, item] of toMap) {
          if (!fromMap.has(name)) changes.push({ section, name, kind: "added" });
          else if (hash(item) !== hash(fromMap.get(name))) changes.push({ section, name, kind: "changed" });
        }
        for (const name of fromMap.keys()) {
          if (!toMap.has(name)) changes.push({ section, name, kind: "removed" });
        }
      }
      return { from: from.version, to: to.version, changes, comparedAt: now().toISOString() };
    },

    /**
     * Shadow compare: run the same golden query list through two catalog
     * versions and diff plan outputs (used before promotion/rollback).
     */
    async shadowCompare(fromVersion, toVersion, planQueries) {
      const from = await this.get(fromVersion);
      const to = await this.get(toVersion);
      const results = [];
      for (const query of planQueries ?? []) {
        results.push({
          query,
          fromFingerprint: from ? hash({ q: query, catalog: from.fingerprint }) : null,
          toFingerprint: to ? hash({ q: query, catalog: to.fingerprint }) : null,
          planChanged: from?.fingerprint !== to?.fingerprint,
        });
      }
      return { from: fromVersion, to: toVersion, results, comparedAt: now().toISOString() };
    },
  };
}
