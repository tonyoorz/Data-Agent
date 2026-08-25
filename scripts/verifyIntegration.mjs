// Unified Data-Agent integration verification.
//
// Runs the integration checklist end to end and persists a machine-readable
// report under outputs/integration-verification/. Every item maps to one
// requirement of the unified integration (see docs/integration/):
//
//   V1 unified system snapshot + cross-layer contracts
//   V2 ontology compile/fingerprint check (pi fail-closed gate)
//   V3 integration unit tests (facade wiring, offline turn)
//   V4 Python semantic contract tests (data plane)
//   V5 agent behavior golden evals (harness routing/policy/execution)
//   V6 full Node regression suite
//   V7 full Python backend suite
//   V8 LIVE end-to-end 智能问数 turn: harness orchestrator → signed semantic
//      tool call → real FastAPI data plane → SQLite hot DB → evidence events
//
// Usage: node scripts/verifyIntegration.mjs [--quick]
// --quick skips V6/V7 full suites (already run in CI) and keeps the rest.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createUnifiedDataAgentSystem } from "../server/unifiedDataAgentSystem.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");
const nodeBin = process.execPath;
const npxCli = path.join(path.dirname(nodeBin), "npx");

function run(command, args, { env = process.env, timeoutMs = 600_000 } = {}) {  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: Number(code), stdout, stderr });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error?.message || error}` });
    });
  });
}

const checks = [];
async function record(id, description, fn) {
  const startedAt = Date.now();
  try {
    const evidence = await fn();
    checks.push({ id, description, ok: true, durationMs: Date.now() - startedAt, evidence });
    console.log(`✅ ${id} ${description} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    checks.push({
      id,
      description,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error?.message || String(error),
    });
    console.log(`❌ ${id} ${description} — ${error?.message || error}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function vitest(files) {
  return run(npxCli, ["vitest", "run", ...files]);
}

async function main() {
  console.log(`Unified Data-Agent integration verification — ${new Date().toISOString()}`);
  console.log(`repo: ${repoRoot}`);
  console.log(quick ? "mode: quick (full suites skipped)" : "mode: full\n");

  await record("V1", "统一系统快照与跨层契约全部通过", async () => {
    const system = await createUnifiedDataAgentSystem({});
    const snapshot = system.snapshot();
    expect(snapshot.ok, `snapshot not ok: ${JSON.stringify(snapshot.contracts)}`);
    return {
      fingerprint: snapshot.layers.semanticKernel.fingerprint,
      runtimeReadyMetrics: snapshot.layers.semanticKernel.runtimeReadyMetricCount,
      adapters: snapshot.layers.semanticKernel.adapterIds,
      contracts: snapshot.contracts.map((item) => item.id),
    };
  });

  await record("V2", "本体编译与指纹校验（pi fail-closed 门）", async () => {
    const result = await run(nodeBin, ["scripts/compileOntology.mjs", "--check"]);
    expect(result.code === 0, `ontology:check failed: ${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    return { fingerprint: payload.fingerprint, counts: payload.counts };
  });

  await record("V3", "集成单元测试（统一门面 + 离线智能问数 turn）", async () => {
    const result = await vitest(["src/test/server/unifiedDataAgentSystem.test.ts"]);
    expect(result.code === 0, `vitest failed: ${result.stdout.slice(-800)}${result.stderr.slice(-400)}`);
    const match = result.stdout.match(/Tests\s+(\d+) passed/);
    return { testsPassed: match ? Number(match[1]) : "unknown" };
  });

  await record("V4", "Python 语义契约测试（数据面）", async () => {
    const python = path.join(repoRoot, ".venv", "bin", "python");
    const result = await run(python, [
      "-m", "pytest",
      "backend/tests/test_semantic_query_api.py",
      "backend/tests/test_ontology_contract.py",
      "backend/tests/test_semantic_execution_goldens.py",
      "-q",
    ]);
    expect(result.code === 0, `pytest failed: ${result.stdout.slice(-800)}${result.stderr.slice(-400)}`);
    const match = result.stdout.match(/(\d+) passed/);
    return { testsPassed: match ? Number(match[1]) : "unknown" };
  });

  await record("V5", "Agent 行为 golden 评测（路由/策略/执行）", async () => {
    const result = await vitest([
      "src/test/server/mainAgentGolden.test.ts",
      "src/test/server/mainAgentPolicyGolden.test.ts",
      "src/test/server/mainAgentExecutionGolden.test.ts",
      "src/test/server/ontology/semanticGolden.test.ts",
    ]);
    expect(result.code === 0, `golden evals failed: ${result.stdout.slice(-800)}${result.stderr.slice(-400)}`);
    const match = result.stdout.match(/Tests\s+(\d+) passed/);
    return { testsPassed: match ? Number(match[1]) : "unknown" };
  });

  if (!quick) {
    await record("V6", "Node 全量回归（vitest 全套）", async () => {
      const result = await vitest([]);
      expect(result.code === 0, `vitest failed: ${result.stdout.slice(-600)}`);
      const match = result.stdout.match(/Tests\s+(\d+) passed/);
      return { testsPassed: match ? Number(match[1]) : "unknown" };
    });

    await record("V7", "Python 后端全量回归（pytest 全套）", async () => {
      const python = path.join(repoRoot, ".venv", "bin", "python");
      const result = await run(python, ["-m", "pytest", "backend/tests", "-q"], { timeoutMs: 600_000 });
      expect(result.code === 0, `pytest failed: ${result.stdout.slice(-600)}`);
      const match = result.stdout.match(/(\d+) passed/);
      return { testsPassed: match ? Number(match[1]) : "unknown" };
    });
  }

  await record("V8", "实时端到端：harness→签名语义调用→FastAPI 数据面→热库", async () => {
    const python = path.join(repoRoot, ".venv", "bin", "python");
    const port = 3313;
    const capabilitySecret = "integration-verify-capability-secret";

    const fixture = await run(python, [path.join(repoRoot, "scripts", "integration_fixture.py")]);
    expect(fixture.code === 0, `fixture build failed: ${fixture.stderr.slice(-400)}`);
    const fixturePaths = JSON.parse(fixture.stdout.slice(fixture.stdout.indexOf("{")));

    const childEnv = {
      ...process.env,
      VIZION_AGENT_ACTOR_CAPABILITY_SECRET: capabilitySecret,
      VIZION_ANALYTICS_PORT: String(port),
      VIZION_FULL_PICTURE_DEFECT_DB_PATH: fixturePaths.sourceDbPath,
      VIZION_FULL_PICTURE_HOT_DB_PATH: fixturePaths.hotDbPath,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
    const server = spawn(python, [
      "-m", "uvicorn", "backend.analytics.api:app",
      "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning",
    ], { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "";
    server.stdout.on("data", (c) => { serverLog += c; });
    server.stderr.on("data", (c) => { serverLog += c; });

    try {
      let healthy = false;
      let healthBody = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) {
            healthBody = await response.json();
            healthy = true;
            break;
          }
        } catch {
          // server not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(healthy, `analytics API did not become healthy. log: ${serverLog.slice(-500)}`);

      const system = await createUnifiedDataAgentSystem({
        analyticsApiBase: `http://127.0.0.1:${port}`,
        actor: {
          actorId: "integration-verifier",
          scopeHash: "scope-integration-verify",
          scopes: {
            allowedObjectTypes: ["quality.defect"],
            teamIds: ["DTSV_China"],
            projectIds: ["IDCEVO"],
          },
        },
        actorCapabilitySecret: capabilitySecret,
        actorCapabilityNow: Math.floor(Date.now() / 1000),
        actorCapabilityNonce: `integration-verify-${Date.now()}`,
      });
      const snapshot = system.snapshot();
      const fingerprint = snapshot.layers.semanticKernel.fingerprint;

      const semanticQuery = {
        schemaVersion: "1.0",
        ontologyVersion: "v1",
        schemaFingerprint: fingerprint,
        intent: "aggregate",
        entityIds: ["quality.defect"],
        metricIds: ["defect.count"],
        dimensionIds: [],
        filters: [{
          dimensionId: "org.problem_finder_team",
          operator: "in",
          values: ["DTSV_China"],
          source: "policy",
        }, {
          dimensionId: "product.project",
          operator: "in",
          values: ["IDCEVO"],
          source: "policy",
        }],
        timeScopes: [],
        comparison: null,
        sort: [],
        limit: 20,
      };

      let plannerCall = 0;
      const turn = await system.runDataAgentTurn({
        messages: [{ role: "user", content: "DTSV_China 现在有多少缺陷？" }],
        requestToolCompletion: async () => {
          plannerCall += 1;
          if (plannerCall === 1) {
            return {
              content: "",
              toolCalls: [{
                id: "verify-semantic-1",
                type: "function",
                function: {
                  name: "query_semantic_metrics",
                  arguments: JSON.stringify({ query: semanticQuery }),
                },
              }],
            };
          }
          return { content: "已完成查询。", toolCalls: [] };
        },
        runId: "integration-verify-run",
        threadId: "integration-verify-thread",
      });

      const eventTypes = turn.events.map((event) => event.type);
      expect(eventTypes.includes("agent.turn.started"), "missing agent.turn.started");
      expect(eventTypes.includes("agent.tool.started"), "missing agent.tool.started");
      expect(eventTypes.includes("agent.tool.completed"), "missing agent.tool.completed");
      expect(eventTypes.includes("agent.turn.completed"), "missing agent.turn.completed");
      expect(!eventTypes.includes("agent.tool.blocked"), `tool blocked: ${JSON.stringify(turn.events)}`);
      expect(
        turn.contextText.includes("Tool: query_semantic_metrics"),
        `semantic result missing from context: ${turn.contextText?.slice(0, 400)}`,
      );
      const evidence = JSON.stringify(turn.evidence || []);
      expect(evidence.includes("defect.count") || turn.contextText.includes("defect.count"),
        "no defect.count evidence in turn");

      return {
        health: { ok: healthBody?.ok, service: healthBody?.service },
        ontologyFingerprint: fingerprint,
        fixture: { snapshotVersion: fixturePaths.snapshotVersion, defectCount: fixturePaths.defectCount },
        turnEvents: eventTypes,
        summaryLine: (turn.contextText.match(/defect\.count[^\n]*/) || ["n/a"])[0],
        serverLogTail: serverLog.slice(-200),
      };
    } finally {
      server.kill("SIGTERM");
    }
  });

  const ok = checks.every((check) => check.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: quick ? "quick" : "full",
    ok,
    passed: checks.filter((check) => check.ok).length,
    failed: checks.filter((check) => !check.ok).length,
    checks,
  };
  const outputDir = path.join(repoRoot, "outputs", "integration-verification");
  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(path.join(outputDir, `report-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${ok ? "✅ ALL INTEGRATION CHECKS PASSED" : "❌ INTEGRATION CHECKS FAILED"} `
    + `(${report.passed}/${checks.length})`);
  console.log(`report: outputs/integration-verification/report-${stamp}.json`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error("verification crashed:", error);
  process.exitCode = 1;
});
