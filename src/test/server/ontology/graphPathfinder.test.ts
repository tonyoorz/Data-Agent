import { describe, expect, it } from "vitest";

import {
  bfsShortestPaths,
  buildAdjacency,
  findReachableDimensions,
  resolveDimensionReachability,
} from "../../../../server/ontology/graphPathfinder.mjs";
import { createOntologyRegistry } from "../../../../server/ontology/registry.mjs";

describe("ontology graph topology discovery", () => {
  const registry = createOntologyRegistry();

  it("discovers bounded shortest paths without publishing query capabilities", () => {
    const adjacency = buildAdjacency(registry.bundle.relationships);
    const paths = bfsShortestPaths(adjacency, "quality.defect", { maxHops: 1 });

    expect(paths.get("quality.defect")).toMatchObject({ hops: 0, path: [] });
    expect([...paths.values()].every((item) => item.hops <= 1)).toBe(true);
  });

  it("projects dimensions on reachable entities as discovery metadata", () => {
    const reachable = findReachableDimensions(registry, "quality.defect", { maxHops: 2 });

    expect(reachable.get("quality.defect")?.dimensionIds.length).toBeGreaterThan(0);
    expect([...reachable.values()].some((item) => item.hops > 0 && item.dimensionIds.length > 0)).toBe(true);
  });

  it("returns a path descriptor but does not mutate a metric allowlist", () => {
    const metric = registry.getMetric("testing.failed_run_count");
    const before = [...metric.allowedDimensions];
    const discovered = resolveDimensionReachability(registry, metric.entityId, "product.os", { maxHops: 3 });

    expect(discovered.reachable).toBe(true);
    expect(discovered.joinPath).toEqual(expect.any(Array));
    expect(metric.allowedDimensions).toEqual(before);
    expect(metric.allowedDimensions).not.toContain("product.os");
  });

  it("returns an explicit unreachable result for an unknown dimension", () => {
    expect(resolveDimensionReachability(registry, "quality.defect", "unknown.dimension")).toEqual({
      reachable: false,
      hops: Number.POSITIVE_INFINITY,
      joinPath: null,
      viaEntity: null,
    });
  });
});
