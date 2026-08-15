/**
 * Ontology drift reconciliation (Onto P0).
 * Fingerprints the live source SQLite schemas (node:sqlite) against the
 * governed ontology registry expectation and emits an actionable report
 * with affected metrics/dimensions. Exit code is non-zero only for
 * critical drift (governed table/column missing) so CI can gate on it.
 *
 * Usage:
 *   node scripts/ontologyReconcile.mjs                 # full check + report
 *   node scripts/ontologyReconcile.mjs --publish v1.x  # also snapshot a version
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { createOntologyRegistry } from "../server/ontology/registry.mjs";
import {
  fingerprintTableSchema,
  reconcileSchema,
  applySourceAvailability,
  createOntologyVersioning,
} from "../server/ontology/driftReconciler.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

/**
 * Observed schema straight from the source SQLite databases.
 *
 * Resolution order per governed table:
 *   1. the database declared in sources.json (production path);
 *   2. any other readable SQLite database in the repo that actually has the
 *      table (local-dev fallback: e.g. backend/database/octane_data.db carries
 *      the same tables when the nightly qgate_raw.db snapshot is absent).
 * A table found nowhere is recorded as unavailable (environment gap), not drift.
 */
async function discoverLocalDatabases(root, { logger = console } = {}) {
  const { readdir } = await import("node:fs/promises");
  const found = [];
  const scanDirs = ["database", "backend/database", "data"];
  for (const dir of scanDirs) {
    const absDir = path.join(root, dir);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".db")) found.push(path.join(absDir, entry.name));
    }
  }
  return found;
}

function tableNamesOf(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name));
}

async function observedSchemaFromDatabases(registry, { logger = console } = {}) {
  const observed = {};
  const unavailableTables = new Map();
  const byDatabase = new Map();
  for (const source of registry.bundle.sources || []) {
    if (!source?.database || !source?.table) continue;
    const key = String(source.database);
    if (!byDatabase.has(key)) byDatabase.set(key, new Set());
    byDatabase.get(key).add(String(source.table));
  }
  // Also fingerprint tables referenced by entities (entity.source.table) so
  // entity-projected schemas are verified even when sources.json uses a
  // different read-model table name set.
  const entityTables = new Set();
  for (const entity of registry.bundle.entities || []) {
    const source = entity?.source;
    if (!source?.table || source?.system === "artifact") continue;
    entityTables.add(String(source.table));
  }

  // Pass 1: declared databases (production path).
  const openedDeclared = new Set();
  const resolvedTables = new Set();
  for (const [database, tables] of byDatabase) {
    let db;
    try {
      db = new DatabaseSync(path.resolve(defaultRoot, database), { readOnly: true });
      openedDeclared.add(database);
    } catch (error) {
      logger.warn(`[ontology-reconcile] cannot open ${database}: ${error.message}`);
      continue;
    }
    try {
      for (const table of tables) {
        let columns;
        try {
          columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
        } catch {
          columns = [];
        }
        if (!Array.isArray(columns) || !columns.length) continue;
        resolvedTables.add(table);
        observed[table] = fingerprintTableSchema({
          table,
          columns: columns.map((column) => ({
            name: column.name,
            type: column.type || "",
            nullable: !column.notnull,
            enum: undefined,
          })),
        });
      }
    } finally {
      db.close();
    }
  }

  // Pass 2: local fallback databases prove TABLE PRESENCE only.
  // Column-level comparison stays bound to the declared source database:
  // local dev subsets legitimately miss production columns, so comparing
  // columns against them would mass-produce false criticals.
  const missing = [...new Set([...entityTables, ...[...byDatabase.values()].flatMap((tables) => [...tables])])]
    .filter((table) => !resolvedTables.has(table));
  const presenceVerifiedTables = new Map();
  if (missing.length) {
    const localDbs = (await discoverLocalDatabases(defaultRoot)).filter((file) => !openedDeclared.has(file));
    for (const file of localDbs) {
      if (!missing.length) break;
      let db;
      try {
        db = new DatabaseSync(file, { readOnly: true });
      } catch {
        continue;
      }
      try {
        const available = new Set(tableNamesOf(db));
        for (const table of [...missing]) {
          if (!available.has(table)) continue;
          const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
          if (!Array.isArray(columns) || !columns.length) continue;
          missing.splice(missing.indexOf(table), 1);
          presenceVerifiedTables.set(table, path.relative(defaultRoot, file));
          logger.warn(`[ontology-reconcile] ${table} presence verified via local fallback ${path.relative(defaultRoot, file)} (column-level check requires declared source database)`);
        }
      } finally {
        db.close();
      }
    }
  }

  // Anything still unresolved: record its declared database (if known) or "<local>".
  const declaredTableToDatabase = new Map();
  for (const [database, tables] of byDatabase) {
    for (const table of tables) declaredTableToDatabase.set(table, database);
  }
  for (const table of missing) {
    unavailableTables.set(table, declaredTableToDatabase.get(table) || "<no readable local database>");
  }

  return { observed, unavailableTables, presenceVerifiedTables };
}

/** Registered expectation: entity properties projected onto their source tables. */
function registeredSchemaFromRegistry(registry) {
  const registered = {};
  const bySource = new Map();
  for (const entity of registry.bundle.entities || []) {
    const source = entity?.source;
    if (!source?.table || source?.system === "artifact") continue;
    const key = String(source.table);
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(entity);
  }
  for (const [table, entities] of bySource) {
    const columns = entities.flatMap((entity) => (entity.properties || []).map((property) => ({
      name: property.id,
      type: String(property.type || ""),
      nullable: property.nullable !== false,
    })));
    registered[table] = fingerprintTableSchema({ table, columns });
  }
  return registered;
}

function catalogFromRegistry(registry) {
  const bundle = registry.bundle || {};
  return {
    metrics: (bundle.metrics || []).map((metric) => ({
      name: metric.id,
      table: registry.bundle.sources?.find((source) => source.readModel && source.id === metric.sourceId)?.table || "",
      column: metric.measure || "",
    })),
    dimensions: (bundle.dimensions || []).map((dimension) => ({
      name: dimension.id,
      table: "",
      column: dimension.propertyId || "",
    })),
    terms: [],
  };
}

const args = parseArgs(process.argv.slice(2));

try {
  const registry = createOntologyRegistry({
    root: args.get("root") ? path.resolve(args.get("root")) : defaultRoot,
  });
  const versioning = createOntologyVersioning({
    storeDir: args.get("versions-dir") ? path.resolve(args.get("versions-dir")) : undefined,
  });

  // Version ops subcommands: list / diff / shadow-compare.
  if (args.get("list-versions")) {
    const versions = await versioning.list();
    process.stdout.write(`${JSON.stringify(versions.map(({ catalog, ...meta }) => meta), null, 2)}\n`);
    process.exit(0);
  }
  if (args.get("diff")) {
    const toVersion = String(args.get("to") || "");
    if (!toVersion) throw new Error("--diff requires --to <version>");
    process.stdout.write(`${JSON.stringify(await versioning.diff(String(args.get("diff")), toVersion), null, 2)}\n`);
    process.exit(0);
  }
  if (args.get("shadow")) {
    const against = String(args.get("against") || "");
    if (!against) throw new Error("--shadow requires --against <version>");
    const queries = String(args.get("queries") || "").split(",").map((item) => item.trim()).filter(Boolean);
    process.stdout.write(`${JSON.stringify(await versioning.shadowCompare(String(args.get("shadow")), against, queries), null, 2)}\n`);
    process.exit(0);
  }

  const { observed, unavailableTables, presenceVerifiedTables } = await observedSchemaFromDatabases(registry);
  const registered = registeredSchemaFromRegistry(registry);
  const baseReport = reconcileSchema({ observed, registered, catalog: catalogFromRegistry(registry) });
  const report = applySourceAvailability({ report: baseReport, unavailableTables, presenceVerifiedTables });

  const reportDir = path.join(defaultRoot, "logs", "ontology-drift");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `reconcile-${report.checkedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (args.get("publish")) {
    const entry = await versioning.publish({
      version: String(args.get("publish")),
      catalog: {
        entities: registry.bundle.entities || [],
        relations: registry.bundle.relationships || [],
        metrics: registry.bundle.metrics || [],
        dimensions: registry.bundle.dimensions || [],
        terms: registry.bundle.terms || [],
      },
    });
    process.stdout.write(`published ontology version ${entry.version} (${entry.fingerprint})\n`);
  }

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    counts: report.counts,
    ...(report.counts.unverified ? { unverified: report.drift.filter((item) => item.kind === "source_unavailable").map((item) => item.table) } : {}),
    reportPath,
    drift: report.drift.filter((item) => item.severity !== "info"),
  }, null, 2)}\n`);

  if (report.counts.critical > 0) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: "ONTOLOGY_RECONCILE_FAILED", message: String(error?.message || error) })}\n`);
  process.exitCode = 1;
}
