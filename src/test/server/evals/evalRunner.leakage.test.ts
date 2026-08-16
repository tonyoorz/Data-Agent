// @vitest-environment node
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSemanticCache } from "../../../../server/agentRuntime/feedbackAndCache.mjs";
import { createEvalRunner } from "../../../../server/agentRuntime/evalRunner.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";
import { createSemanticResolver } from "../../../../server/ontology/resolver.mjs";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "leakage-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const CASE = { id: "L1", domain: "defect", intent: "metric_query", q: "上个月 BCM 停演缺陷趋势", expect: { metrics: ["defect.showstopper_count"] } };
const ENTRY = {
  planFingerprint: "fp-leak-1",
  queryText: "上个月 BCM 停演缺陷趋势",
  intent: "metric_query",
  result: { answer: "POISONED-ANSWER-FROM-CACHE", citations: [] },
};

describe("eval leakage guard (mode:'eval' on semanticCache)", () => {
  it("live mode: exact + similar lookups DO hit a poisoned entry", async () => {
    const live = createSemanticCache({ cacheDir: dir });
    await live.set(ENTRY);
    const exact = await live.get("fp-leak-1");
    expect(exact?.answer).toBe("POISONED-ANSWER-FROM-CACHE");
    const similar = await live.getSimilar("上个月 BCM 停演缺陷趋势");
    expect(similar).not.toBeNull();
    await live.clear();
  });

  it("eval mode: same query must NOT hit cache (get/getSimilar → null)", async () => {
    // poison with a live cache first
    const poison = createSemanticCache({ cacheDir: dir });
    await poison.set(ENTRY);
    // eval-mode cache over the SAME directory must bypass
    const evalCache = createSemanticCache({ cacheDir: dir, mode: "eval" });
    expect(await evalCache.get("fp-leak-1")).toBeNull();
    expect(await evalCache.getSimilar("上个月 BCM 停演缺陷趋势")).toBeNull();
    await poison.clear();
  });

  it("eval mode: set() is a no-op — nothing persists for live mode to hit", async () => {
    const evalCache = createSemanticCache({ cacheDir: dir, mode: "eval" });
    await evalCache.set({ planFingerprint: "fp-eval-only", queryText: "x", intent: "general", result: { answer: "SHOULD-NOT-PERSIST" } });
    const live = createSemanticCache({ cacheDir: dir });
    expect(await live.get("fp-eval-only")).toBeNull();
  });

  it("eval runner keeps leakageGuard:true and results identical with poisoned cache present", async () => {
    const poison = createSemanticCache({ cacheDir: dir });
    await poison.set(ENTRY);
    const NOW = "2026-08-16T02:00:00.000Z";
    const actor = { actorId: "eval", scopeHash: "eval-scope", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
    const registry = createOntologyRegistry();
    const resolver = createSemanticResolver({ registry, now: () => NOW });
    const runner = createEvalRunner({ registry, resolver, now: () => NOW, actor });
    const report = runner.run([CASE]);
    expect(report.leakageGuard).toBe(true);
    expect(report.results[0].pass).toBe(true); // passes on merit, never via cache
    // and no poisoned answer leaked into any check detail
    const json = JSON.stringify(report);
    expect(json).not.toContain("POISONED-ANSWER");
    await poison.clear();
  });

  it("stats() exposes mode for observability", () => {
    expect(createSemanticCache({ cacheDir: dir, mode: "eval" }).stats().mode).toBe("eval");
    expect(createSemanticCache({ cacheDir: dir }).stats().mode).toBe("live");
  });
});
