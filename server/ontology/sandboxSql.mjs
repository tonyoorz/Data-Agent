import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mandatoryScopeFilters } from "./scopePolicy.mjs";

// Governed sandbox SQL: long-tail questions get a read-only SQL path behind the
// same scopePolicy used by semantic queries. Results are evidence kind
// "sandbox_result" (non claim-bearing) — wiring decides citation behavior.
//
// Design: conservative static guards only (regex/lexical), no SQL parser dep.
// Prefer rejecting over leaking ("宁拒勿漏"). Default-off via VIZION_SANDBOX_SQL=1.

const FORBIDDEN_TOKENS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "VACUUM", "REPLACE",
  "PRAGMA", "ATTACH", "DETACH", "GRANT", "REVOKE", "TRUNCATE", "EXPLAIN",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "REINDEX", "ANALYZE",
];
// Prefix-matched (allows load_extension_v2-style variants).
const FORBIDDEN_TOKEN_PREFIXES = ["load_extension"];
const FORBIDDEN_IDENTIFIER_PREFIXES = /\b(?:sqlite_|pragma_)[a-z0-9_]*/i;
const FORBIDDEN_LITERAL_PREFIX = /file:/i;
const READ_ONLY_HEAD = /^(select|with)\b/i;
const MAX_SUBQUERY_DEPTH = 6;
const DRY_RUN_LIMIT = 500;
const EXEC_LIMIT_CAP = 5000;

function failure(reason, extra = {}) {
  return { ok: false, reason, tables: [], scopeFilters: [], ...extra };
}

function execReason(error) {
  return `SANDBOX_EXEC_ERROR:${String(error?.message ?? error).slice(0, 120)}`;
}

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function quoteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function isIdentChar(ch) {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/.test(ch);
}

// ---------------------------------------------------------------------------
// Lexical skeleton: same length as the input, with the CONTENTS of string
// literals ('...'), quoted identifiers ("..." / `...` / [...]), line comments
// (-- ...) and block comments (/* ... */) replaced by spaces. Quote delimiters
// are preserved so structure stays scannable; tokens inside literals, comments
// and quoted identifiers therefore never match keyword checks.
// ---------------------------------------------------------------------------
function buildSkeleton(input) {
  const sql = String(input ?? "");
  const chars = sql.split("");
  const n = chars.length;
  const blank = (index) => { chars[index] = " "; };
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { blank(i); blank(i + 1); i += 2; continue; }
          i += 1; break;
        }
        if (quote === "'" && sql[i] === "\n") break; // unterminated literal: stop at newline, fail-safe
        blank(i); i += 1;
      }
      continue;
    }
    if (ch === "[") {
      i += 1;
      while (i < n) {
        if (sql[i] === "]") { i += 1; break; }
        blank(i); i += 1;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") { blank(i); i += 1; }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      blank(i); blank(i + 1); i += 2;
      while (i < n) {
        if (sql[i] === "*" && sql[i + 1] === "/") { blank(i); blank(i + 1); i += 2; break; }
        blank(i); i += 1;
      }
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

function skipWhitespace(text, pos) {
  let index = pos;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function readBareName(original, pos) {
  let end = pos;
  while (end < original.length && isIdentChar(original[end])) end += 1;
  return { name: original.slice(pos, end), next: end };
}

function readQuotedName(original, pos) {
  const quote = original[pos];
  const close = quote === "[" ? "]" : quote;
  let end = pos + 1;
  let name = "";
  while (end < original.length) {
    if (original[end] === close) {
      if (original[end + 1] === close) { name += close; end += 2; continue; }
      return { name, next: end + 1 };
    }
    name += original[end];
    end += 1;
  }
  return { name, next: end };
}

function matchBalancedParen(skeleton, openPos) {
  let depth = 0;
  for (let i = openPos; i < skeleton.length; i += 1) {
    if (skeleton[i] === "(") depth += 1;
    else if (skeleton[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Collect CTE names (`WITH name AS (...)`, `WITH name(cols) AS (...)`,
// `WITH a AS (...), b AS (...)`, MATERIALIZED variants) so FROM/JOIN references
// to them are not treated as physical tables.
function collectCteNames(skeleton, original) {
  const names = new Set();
  const withRe = /\bwith\b/gi;
  let match;
  while ((match = withRe.exec(skeleton))) {
    let pos = skipWhitespace(skeleton, match.index + match[0].length);
    const head = readBareName(original, pos);
    if (/^recursive$/i.test(head.name)) pos = skipWhitespace(skeleton, head.next);
    let cursor = pos;
    while (cursor < skeleton.length) {
      const name = readBareName(original, cursor);
      if (!name.name) break;
      names.add(name.name.toLowerCase());
      let next = skipWhitespace(skeleton, name.next);
      if (skeleton[next] === "(") {
        const close = matchBalancedParen(skeleton, next);
        if (close < 0) break;
        next = skipWhitespace(skeleton, close + 1);
      }
      const asToken = readBareName(original, next);
      if (!/^as$/i.test(asToken.name)) break;
      next = skipWhitespace(skeleton, asToken.next);
      while (next < skeleton.length) {
        const modifier = readBareName(original, next);
        if (/^(not|materialized)$/i.test(modifier.name)) {
          next = skipWhitespace(skeleton, modifier.next);
          continue;
        }
        break;
      }
      if (skeleton[next] !== "(") break;
      const bodyClose = matchBalancedParen(skeleton, next);
      if (bodyClose < 0) break;
      next = skipWhitespace(skeleton, bodyClose + 1);
      if (skeleton[next] === ",") {
        cursor = skipWhitespace(skeleton, next + 1);
        continue;
      }
      break;
    }
  }
  return names;
}

// Extract physical table names from FROM/JOIN clauses plus table-valued
// function calls (identifier immediately followed by `(`). Subqueries after
// FROM/JOIN (`(` directly) are descended into recursively (bounded depth).
function extractTables(sql, skeleton, cteNames, depth, tables, functions) {
  if (depth > MAX_SUBQUERY_DEPTH) return { tables, functions, error: true };
  const fromJoinRe = /\b(?:from|join)\b/gi;
  let match;
  while ((match = fromJoinRe.exec(skeleton))) {
    let pos = skipWhitespace(skeleton, match.index + match[0].length);
    const maybeLateral = readBareName(sql, pos);
    if (/^lateral$/i.test(maybeLateral.name)) pos = skipWhitespace(skeleton, maybeLateral.next);
    if (skeleton[pos] === "(") {
      const close = matchBalancedParen(skeleton, pos);
      if (close < 0) return { tables, functions, error: true };
      const inner = extractTables(
        sql.slice(pos + 1, close),
        skeleton.slice(pos + 1, close),
        cteNames,
        depth + 1,
        tables,
        functions,
      );
      if (inner.error) return inner;
      continue;
    }
    let name = "";
    let after = pos;
    const ch = sql[pos];
    if (ch === '"' || ch === "`" || ch === "[") {
      const quoted = readQuotedName(sql, pos);
      name = quoted.name;
      after = quoted.next;
    } else {
      const bare = readBareName(sql, pos);
      name = bare.name;
      after = bare.next;
    }
    if (!name) continue;
    const afterName = skipWhitespace(skeleton, after);
    if (skeleton[afterName] === "(") {
      functions.push(name); // table-valued function: json_each(...), table(...), pragma_table_info(...)
      continue;
    }
    if (cteNames.has(name.toLowerCase())) continue;
    tables.push(name);
  }
  return { tables, functions, error: false };
}

function governedAnalyticsSources(registry) {
  const map = new Map();
  for (const source of registry?.bundle?.sources ?? []) {
    if (source?.system !== "analytics") continue;
    if (source?.governance?.status !== "approved") continue;
    if (!source?.database || !source?.table) continue;
    const key = String(source.table).toLowerCase();
    if (!map.has(key)) map.set(key, source);
  }
  return map;
}

function entityIdsForSources(registry, sourceIds) {
  const ids = [];
  for (const entity of registry?.bundle?.entities ?? []) {
    if (sourceIds.has(entity?.source?.sourceId)) ids.push(entity.id);
  }
  return ids;
}

function dedupeTables(tables) {
  const seen = new Set();
  const result = [];
  for (const table of tables) {
    const key = String(table).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(table);
  }
  return result;
}

export function isSandboxSqlEnabled(env = process.env) {
  return String(env?.VIZION_SANDBOX_SQL ?? "") === "1";
}

export function createSandboxSqlGuard({ registry, dbRoot = process.cwd() } = {}) {
  if (!registry) throw new Error("SANDBOX_GUARD_REQUIRES_REGISTRY");
  const root = path.resolve(dbRoot);
  const governedSources = governedAnalyticsSources(registry);

  function physicalColumnFor(dimensionId) {
    const dimension = registry.getDimension(dimensionId);
    const entity = registry.getEntity(dimension.entityId);
    const propertyId = dimension.propertyId;
    if (!(entity.properties ?? []).some((property) => property.id === propertyId)) return null;
    return propertyId;
  }

  function validate({ sql, actor, intent = "explore" } = {}) {
    const text = typeof sql === "string" ? sql : "";
    if (!text.trim()) return failure("SANDBOX_NON_SELECT");
    const skeleton = buildSkeleton(text);

    // Single statement only: one optional trailing `;`, nothing after it.
    let body = skeleton.trimEnd();
    if (body.endsWith(";")) body = body.slice(0, -1).trimEnd();
    if (body.includes(";")) return failure("SANDBOX_MULTI_STATEMENT");

    if (!READ_ONLY_HEAD.test(skeleton.trimStart())) return failure("SANDBOX_NON_SELECT");

    for (const token of FORBIDDEN_TOKENS) {
      if (new RegExp(`\\b${token}\\b`, "i").test(skeleton)) {
        return failure(`SANDBOX_FORBIDDEN_TOKEN:${token}`);
      }
    }
    for (const token of FORBIDDEN_TOKEN_PREFIXES) {
      if (new RegExp(`\\b${token}`, "i").test(skeleton)) {
        return failure(`SANDBOX_FORBIDDEN_TOKEN:${token}`);
      }
    }
    if (FORBIDDEN_LITERAL_PREFIX.test(skeleton)) return failure("SANDBOX_FORBIDDEN_TOKEN:FILE_URI");

    const cteNames = collectCteNames(skeleton, text);
    const extracted = extractTables(text, skeleton, cteNames, 0, [], []);
    if (extracted.error) return failure("SANDBOX_PARSE_ERROR");
    if (extracted.functions.length > 0) {
      return failure(`SANDBOX_TABLE_NOT_GOVERNED:${extracted.functions[0]}`);
    }
    const tables = dedupeTables(extracted.tables);
    const sourceIds = new Set();
    for (const table of tables) {
      if (/^sqlite_/i.test(table)) return failure(`SANDBOX_TABLE_NOT_GOVERNED:${table}`);
      const source = governedSources.get(table.toLowerCase());
      if (!source) return failure(`SANDBOX_TABLE_NOT_GOVERNED:${table}`);
      sourceIds.add(source.id);
    }
    // Catch sqlite_*/pragma_* identifiers outside governed FROM/JOIN positions.
    if (FORBIDDEN_IDENTIFIER_PREFIXES.test(skeleton)) return failure("SANDBOX_FORBIDDEN_TOKEN:SQLITE_INTERNAL");

    let scopeFilters;
    try {
      scopeFilters = mandatoryScopeFilters(actor, entityIdsForSources(registry, sourceIds), intent, registry);
    } catch {
      return failure("SANDBOX_SCOPE_POLICY_ERROR");
    }

    return {
      ok: true,
      reason: null,
      tables,
      scopeFilters,
      hasLimit: /\blimit\b/i.test(skeleton),
    };
  }

  // Wrap the query with the mandatory row-level filters. Physical column comes
  // from dimension → entity propertyId. Empty filters → SQL untouched.
  function rewriteSql(sql, scopeFilters) {
    const filters = scopeFilters ?? [];
    if (filters.length === 0) return String(sql);
    const clauses = [];
    for (const filter of filters) {
      const column = physicalColumnFor(filter.dimensionId);
      if (!column) throw new Error(`SANDBOX_SCOPE_MAPPING_ERROR:${filter.dimensionId}`);
      const values = (filter.values ?? []).map(quoteString).join(", ");
      clauses.push(`${quoteIdentifier(column)} IN (${values})`);
    }
    return `SELECT * FROM (${sql}) AS sandbox_outer WHERE ${clauses.join(" AND ")}`;
  }

  function resolveDatabase(tables) {
    const databases = new Set();
    for (const table of tables) {
      const source = governedSources.get(table.toLowerCase());
      if (!source) return { ok: false, reason: `SANDBOX_TABLE_NOT_GOVERNED:${table}` };
      databases.add(String(source.database));
    }
    if (databases.size !== 1) return { ok: false, reason: "SANDBOX_SOURCE_UNAVAILABLE" };
    const dbPath = path.resolve(root, [...databases][0]);
    if (!dbPath.startsWith(root + path.sep)) return { ok: false, reason: "SANDBOX_SOURCE_UNAVAILABLE" };
    if (!fs.existsSync(dbPath)) return { ok: false, reason: "SANDBOX_SOURCE_UNAVAILABLE" };
    return { ok: true, dbPath };
  }

  function preFlight({ sql, actor, intent }) {
    const verdict = validate({ sql, actor, intent });
    if (!verdict.ok) return verdict;
    let scoped;
    try {
      scoped = rewriteSql(sql, verdict.scopeFilters);
    } catch (error) {
      return failure(String(error?.message ?? "SANDBOX_SCOPE_MAPPING_ERROR"), { tables: verdict.tables });
    }
    const database = resolveDatabase(verdict.tables);
    if (!database.ok) return failure(database.reason, { tables: verdict.tables });
    return {
      ok: true,
      reason: null,
      scopedSql: scoped,
      dbPath: database.dbPath,
      tables: verdict.tables,
      scopeFilters: verdict.scopeFilters,
      hasLimit: verdict.hasLimit,
    };
  }

  async function dryRun({ sql, actor, intent = "explore" } = {}) {
    const pre = preFlight({ sql, actor, intent });
    if (!pre.ok) return pre;
    const previewSql = pre.hasLimit
      ? pre.scopedSql
      : `SELECT * FROM (${pre.scopedSql}) LIMIT ${DRY_RUN_LIMIT}`;
    let db;
    try {
      db = new DatabaseSync(pre.dbPath, { readOnly: true });
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${previewSql}`).all();
      return { ok: true, reason: null, plan, previewSql, tables: pre.tables, scopeFilters: pre.scopeFilters };
    } catch (error) {
      return failure(execReason(error), { tables: pre.tables });
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  async function execute({ sql, actor, intent = "explore", limit = 200, timeoutMs = 3000 } = {}) {
    const pre = preFlight({ sql, actor, intent });
    if (!pre.ok) return pre;
    const parsed = Number(limit);
    const safeLimit = Math.max(1, Math.min(Number.isFinite(parsed) ? Math.floor(parsed) : 200, EXEC_LIMIT_CAP));
    const finalSql = `SELECT * FROM (${pre.scopedSql}) AS sandbox_limited LIMIT ${safeLimit + 1}`;
    const timeout = Math.max(1, Number(timeoutMs) || 3000);
    let db;
    let timer = null;
    try {
      db = new DatabaseSync(pre.dbPath, { readOnly: true });
      const statement = db.prepare(finalSql);
      const rows = await Promise.race([
        Promise.resolve().then(() => statement.all()),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { db.close(); } catch { /* already closed */ }
            reject(Object.assign(new Error("sandbox timeout"), { code: "SANDBOX_TIMEOUT" }));
          }, timeout);
        }),
      ]);
      const truncated = rows.length > safeLimit;
      const bounded = truncated ? rows.slice(0, safeLimit) : rows;
      let columns = [];
      try {
        columns = statement.columns().map((column) => column.name);
      } catch {
        columns = bounded.length > 0 ? Object.keys(bounded[0]) : [];
      }
      return { ok: true, reason: null, rows: bounded, rowCount: bounded.length, columns, truncated };
    } catch (error) {
      if (error?.code === "SANDBOX_TIMEOUT") {
        return { ok: false, reason: `SANDBOX_EXEC_TIMEOUT:${timeout}`, rows: [], rowCount: 0, columns: [], truncated: false };
      }
      return failure(execReason(error));
    } finally {
      if (timer) clearTimeout(timer);
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  return Object.freeze({
    validate,
    rewriteSql,
    dryRun,
    execute,
    isEnabled: (env = process.env) => isSandboxSqlEnabled(env),
  });
}
