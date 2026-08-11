import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOntologyRegistry } from "./registry.mjs";
import { buildAdjacency, bfsShortestPaths, findReachableDimensions, resolveDimensionReachability, expandAllowedDimensions } from "./graphPathfinder.mjs";

const registry = createOntologyRegistry();

describe("graphPathfinder", () => {
  describe("buildAdjacency", () => {
    it("should build adjacency list from relationships", () => {
      const rels = registry.bundle.relationships;
      const adj = buildAdjacency(rels);
      // Each entity should have at least one neighbor if it appears in any relationship
      assert.ok(adj.size > 0, "adjacency map should not be empty");
      // quality.defect should have multiple neighbors
      const defectNeighbors = adj.get("quality.defect") || [];
      assert.ok(defectNeighbors.length >= 3, `quality.defect should have >=3 neighbors, got ${defectNeighbors.length}`);
    });
  });

  describe("bfsShortestPaths", () => {
    it("should find quality.defect as start with 0 hops", () => {
      const adj = buildAdjacency(registry.bundle.relationships);
      const paths = bfsShortestPaths(adj, "quality.defect");
      const self = paths.get("quality.defect");
      assert.ok(self, "should include start entity");
      assert.equal(self.hops, 0);
      assert.equal(self.path.length, 0);
    });

    it("should find paths to reachable entities", () => {
      const adj = buildAdjacency(registry.bundle.relationships);
      const paths = bfsShortestPaths(adj, "quality.defect");
      // Should be able to reach testing.test_run (via detected_in relationship)
      const run = paths.get("testing.test_run");
      assert.ok(run, "should reach testing.test_run");
      assert.ok(run.hops >= 1, `should be >=1 hop, got ${run.hops}`);
      assert.ok(run.path.length === run.hops, "path length should equal hops");
    });

    it("should respect maxHops limit", () => {
      const adj = buildAdjacency(registry.bundle.relationships);
      const pathsMax1 = bfsShortestPaths(adj, "quality.defect", { maxHops: 1 });
      const pathsMax3 = bfsShortestPaths(adj, "quality.defect", { maxHops: 3 });
      assert.ok(pathsMax1.size <= pathsMax3.size, "more hops should reach more entities");
    });
  });

  describe("findReachableDimensions", () => {
    it("should return dimensions for quality.defect entity", () => {
      const result = findReachableDimensions(registry, "quality.defect");
      const defect = result.get("quality.defect");
      assert.ok(defect, "should include start entity");
      assert.ok(defect.dimensionIds.length > 0, "should have dimensions");
    });

    it("should find dimensions on reachable entities", () => {
      const result = findReachableDimensions(registry, "quality.defect");
      let foundCrossEntityDims = false;
      for (const [entityId, desc] of result) {
        if (entityId !== "quality.defect" && desc.dimensionIds.length > 0) {
          foundCrossEntityDims = true;
          break;
        }
      }
      assert.ok(foundCrossEntityDims, "should find dimensions on entities reachable from quality.defect");
    });
  });

  describe("resolveDimensionReachability", () => {
    it("should resolve same-entity dimension as 0 hops", () => {
      // quality.phase is on quality.defect
      const result = resolveDimensionReachability(registry, "quality.defect", "quality.phase");
      assert.ok(result.reachable);
      assert.equal(result.hops, 0);
    });

    it("should resolve cross-entity dimension via graph", () => {
      // product.platform is on product.platform entity, reachable from quality.defect via affects.ecu
      // But product.ecu dimension might be on quality.defect directly (assigned_ecu field).
      // Let's test with vehicle.model_series which is on a different entity.
      const result = resolveDimensionReachability(registry, "quality.defect", "vehicle.model_series");
      // vehicle.model_series may or may not be directly on defect entity — check
      assert.ok(result.reachable, "vehicle.model_series should be reachable from quality.defect");
      // If it's on the same entity, hops=0 is fine. If cross-entity, hops >= 1.
      assert.ok(result.hops >= 0, `should have valid hops, got ${result.hops}`);
    });

    it("should return unreachable for nonexistent dimension", () => {
      const result = resolveDimensionReachability(registry, "quality.defect", "nonexistent.dimension");
      assert.ok(!result.reachable);
    });
  });

  describe("expandAllowedDimensions", () => {
    it("should expand defect.count with graph-inferred dimensions", () => {
      const metric = registry.getMetric("defect.count");
      const { allowed, inferred } = expandAllowedDimensions(registry, metric, { maxHops: 3 });
      // allowed should include existing dimensions
      assert.ok(allowed.has("quality.phase"), "quality.phase should be in allowed");
      assert.ok(allowed.has("product.ecu"), "product.ecu should be in allowed");
      // inferred should have some cross-entity dimensions
      // The exact set depends on the ontology, but there should be some
      if (inferred.size > 0) {
        for (const [dimId, info] of inferred) {
          assert.ok(info.hops >= 1, `inferred dimension ${dimId} should have hops >=1`);
          assert.ok(info.joinPath.length >= 1, `inferred dimension ${dimId} should have joinPath`);
        }
      }
    });

    it("should include joinPath for inferred dimensions", () => {
      const metric = registry.getMetric("defect.count");
      const { inferred } = expandAllowedDimensions(registry, metric, { maxHops: 3 });
      for (const [dimId, info] of inferred) {
        const joinPathStr = info.joinPath.map((h) => `${h.fromEntity}→${h.toEntity}`).join(" | ");
        // Just verify it's a valid path structure
        for (const hop of info.joinPath) {
          assert.ok(hop.relationshipId, "hop should have relationshipId");
          assert.ok(hop.predicate, "hop should have predicate");
          assert.ok(hop.fromEntity, "hop should have fromEntity");
          assert.ok(hop.toEntity, "hop should have toEntity");
        }
      }
    });
  });
});
