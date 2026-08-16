/**
 * Offline eval runner — measures golden dataset accuracy WITHOUT LLM calls.
 * Two evaluated layers (mirrors real architecture):
 *   1. Route layer: routeMainAgentIntent (16 routing intents) vs case.intent
 *   2. Semantic layer: resolver.resolve() frame vs expect.{metrics,dims,filters,time}
 * Subset semantics: expected ids must be ⊆ frame ids (extra resolutions are allowed).
 * Families: reject (must refuse), clarify (must ask), longtail (governed path unreachable),
 *           answer/entity (route-level only), data (full checks).
 * leakageGuard: runner never consults semanticCache/verified stores; flag reserved for A3 wiring.
 */
import { routeMainAgentIntent } from "../mainAgentIntentRouter.mjs";

const REFUSAL_INTENTS = new Set(["out_of_scope", "chitchat"]);
const LONGTAIL_OK_INTENTS = new Set(["general", "dashboard_fallback"]);

function isRefusalFamily(c) {
  return Boolean(c.expect?.reject);
}
function isClarifyFamily(c) {
  return Boolean(c.expect?.clarify);
}
function isLongtailFamily(c) {
  return Boolean(c.expect?.longtail);
}

function routePasses(c, routedIntent) {
  if (isRefusalFamily(c)) return REFUSAL_INTENTS.has(routedIntent);
  if (isClarifyFamily(c)) return routedIntent === "clarification";
  if (isLongtailFamily(c)) return LONGTAIL_OK_INTENTS.has(routedIntent);
  return routedIntent === c.intent;
}

function subset(expected, actual) {
  const a = new Set(actual);
  return expected.every((id) => a.has(id));
}

function timePasses(expectTime, timeScopes) {
  const scopes = Array.isArray(timeScopes) ? timeScopes : [];
  if (!scopes.length) return false;
  const primary = scopes.find((s) => s.role === "primary") ?? scopes[0];
  const ym = /^(\d{4})-(\d{2})$/.exec(expectTime);
  if (ym) {
    const monthStart = `${ym[1]}-${ym[2]}-01`;
    const monthEnd = `${ym[1]}-${ym[2]}-31`;
    return scopes.some((s) => s.start <= monthEnd && (s.end ?? s.start) >= monthStart);
  }
  const y = /^\d{4}$/.exec(expectTime);
  if (y) return scopes.some((s) => s.start.startsWith(y[0]) || (s.end ?? "").startsWith(y[0]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(expectTime)) {
    return scopes.some((s) => s.start <= expectTime && (s.end ?? s.start) >= expectTime);
  }
  // Named windows (last_7_days, previous_week, ...) — v1: presence of any scope counts.
  return true;
}

function semanticChecks(c, frame) {
  const checks = [];
  const e = c.expect ?? {};
  if (Array.isArray(e.metrics) && e.metrics.length) {
    checks.push({
      name: "metrics",
      pass: subset(e.metrics, frame.metricIds ?? []),
      detail: `expected⊆${JSON.stringify(frame.metricIds ?? [])}`,
    });
  }
  if (Array.isArray(e.dims) && e.dims.length) {
    checks.push({
      name: "dims",
      pass: subset(e.dims, frame.dimensionIds ?? []),
      detail: `expected⊆${JSON.stringify(frame.dimensionIds ?? [])}`,
    });
  }
  const expectedFilterDims = Object.keys(e.filters ?? {});
  if (expectedFilterDims.length) {
    const present = new Set((frame.filters ?? []).map((f) => f.dimensionId));
    const missing = expectedFilterDims.filter((d) => !present.has(d));
    checks.push({
      name: "filters",
      pass: missing.length === 0,
      detail: missing.length ? `missing dims: ${missing.join(",")}` : "all expected filter dims present",
    });
  }
  if (Array.isArray(e.entities) && e.entities.length) {
    checks.push({
      name: "entities",
      pass: subset(e.entities, frame.entityIds ?? []),
      detail: `expected⊆${JSON.stringify(frame.entityIds ?? [])}`,
    });
  }
  if (e.entity && !Array.isArray(e.entities)) {
    checks.push({
      name: "entities",
      pass: subset([e.entity], frame.entityIds ?? []),
      detail: `expected⊆${JSON.stringify(frame.entityIds ?? [])}`,
    });
  }
  if (e.time) {
    checks.push({
      name: "time",
      pass: timePasses(e.time, frame.timeScopes),
      detail: `scopes=${JSON.stringify((frame.timeScopes ?? []).map((s) => [s.start, s.end]))}`,
    });
  }
  return checks;
}

export function createEvalRunner({ registry, resolver, now, actor, router = routeMainAgentIntent } = {}) {
  if (!registry) throw new Error("ONTOLOGY_REGISTRY_REQUIRED");
  if (!resolver) throw new Error("SEMANTIC_RESOLVER_REQUIRED");
  if (typeof now !== "function") throw new Error("NOW_FN_REQUIRED");
  if (!actor) throw new Error("ACTOR_REQUIRED");

  function runCase(c) {
    const checks = [];
    const messages = [{ role: "user", content: c.q }];
    const routed = router(messages)?.intent ?? "general";
    checks.push({ name: "route", pass: routePasses(c, routed), detail: `routed=${routed}` });

    const needsFrame = Array.isArray(c.expect?.metrics) || Array.isArray(c.expect?.dims)
      || Array.isArray(c.expect?.entities) || c.expect?.entity
      || Object.keys(c.expect?.filters ?? {}).length || c.expect?.time;
    if (needsFrame) {
      let frame = null;
      let frameError = null;
      try {
        frame = resolver.resolve({ query: c.q, actor, requestAnchorAt: now() });
      } catch (err) {
        frameError = err?.message ?? String(err);
      }
      if (frameError) {
        checks.push({ name: "frame", pass: false, detail: frameError });
      } else {
        checks.push(...semanticChecks(c, frame));
      }
    }

    return { id: c.id, intent: c.intent, routed, pass: checks.every((k) => k.pass), checks };
  }

  function run(cases) {
    const results = cases.map(runCase);
    const byIntent = {};
    for (const r of results) {
      const slot = (byIntent[r.intent] ??= { pass: 0, fail: 0 });
      slot[r.pass ? "pass" : "fail"] += 1;
    }
    const passed = results.filter((r) => r.pass).length;
    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      accuracy: results.length ? passed / results.length : 0,
      byIntent,
      leakageGuard: true,
      results,
      failures: results.filter((r) => !r.pass),
    };
  }

  return Object.freeze({ run, runCase });
}

// ---- CLI: node server/agentRuntime/evalRunner.mjs --dataset <path> ----
async function main() {
  const { readFileSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const args = process.argv.slice(2);
  const datasetIdx = args.indexOf("--dataset");
  const datasetPath = datasetIdx >= 0 ? args[datasetIdx + 1] : "src/test/server/evals/dataset/golden-v1.jsonl";

  const cases = readFileSync(datasetPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const [{ createOntologyRegistry }, { createSemanticResolver }] = await Promise.all([
    import(pathToFileURL("server/ontology/registry.mjs").href),
    import(pathToFileURL("server/ontology/resolver.mjs").href),
  ]);
  const { createEvalRunner: build } = await import(pathToFileURL("server/agentRuntime/evalRunner.mjs").href);

  const NOW = "2026-08-16T02:00:00.000Z"; // fixed anchor for reproducibility
  const actor = { actorId: "eval", scopeHash: "eval-scope", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
  const registry = createOntologyRegistry();
  const resolver = createSemanticResolver({ registry, now: () => NOW });
  const runner = build({ registry, resolver, now: () => NOW, actor });
  const report = runner.run(cases);
  console.log(JSON.stringify({
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    accuracy: Number(report.accuracy.toFixed(4)),
    byIntent: report.byIntent,
    leakageGuard: report.leakageGuard,
    failures: report.failures.map((f) => ({
      id: f.id,
      routed: f.routed,
      failedChecks: f.checks.filter((k) => !k.pass).map((k) => `${k.name}:${k.detail}`),
    })),
  }, null, 2));
}

if (process.argv[1]?.endsWith("evalRunner.mjs") && process.argv.length > 1) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
