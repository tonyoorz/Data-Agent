// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSchemaLinker } from "../../../../server/ontology/schemaLinker.mjs";
import { loadGoldenDataset } from "../evals/loader.mjs";

const { ontology } = loadGoldenDataset();

describe("schemaLinker (TF-IDF default backend)", () => {
  it("links a defect-alias + ECU query to dim and entity", () => {
    const linker = createSchemaLinker({ ontology });
    const r = linker.linkQueryTokens("问题单按 ECU 分布");
    expect(r.matchedDims.map((d) => d.id)).toContain("product.ecu");
    expect(r.matchedEntities.map((e) => e.id)).toContain("quality.defect");
  });

  it("links metric phrasing to the governed metric", () => {
    const linker = createSchemaLinker({ ontology });
    const r = linker.linkQueryTokens("用例通过率怎么样");
    expect(r.matchedMetrics.map((m) => m.id)).toContain("testing.pass_rate");
  });

  it("returns empty arrays for out-of-domain text (no forced matches)", () => {
    const linker = createSchemaLinker({ ontology });
    const r = linker.linkQueryTokens("今天午饭吃什么好呢");
    expect(r.matchedDims).toEqual([]);
    expect(r.matchedMetrics).toEqual([]);
    expect(r.matchedEntities).toEqual([]);
  });

  it("every match carries a score and matches are sorted desc", () => {
    const linker = createSchemaLinker({ ontology });
    const r = linker.linkQueryTokens("停演缺陷按模块看趋势");
    for (const group of [r.matchedDims, r.matchedMetrics, r.matchedEntities]) {
      const scores = group.map((x) => x.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      scores.forEach((s) => expect(s).toBeGreaterThan(0));
    }
  });

  it("pluggable embedder backend is used when provided", () => {
    const calls = [];
    const embedder = {
      async embed(text) {
        calls.push(text);
        // deterministic toy embedding: dim "product.ecu" lights up when text mentions ecu
        return { ecu: /ecu/i.test(text) ? 1 : 0, defect: /缺陷|问题单/.test(text) ? 1 : 0 };
      },
      dims: ["ecu", "defect"],
    };
    const linker = createSchemaLinker({ ontology, embedder });
    expect(linker.backend).toBe("embedder");
  });

  it("TF-IDF backend is the default and reported", () => {
    const linker = createSchemaLinker({ ontology });
    expect(linker.backend).toBe("tfidf");
  });
});
