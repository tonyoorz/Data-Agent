/**
 * Graph Pathfinder — topology discovery only.
 *
 * Given ontology relationships and a starting entity, this module finds graph
 * reachability. Reachability is not authorization and is not proof that a join
 * is executable. Runtime planners must continue to use published metric
 * allowedDimensions until a versioned join capability supplies adapters, join
 * keys, grain/cardinality, fanout policy, scope propagation and source-revision
 * compatibility.
 *
 * Architecture: pure functions, no side effects, no I/O.
 */

/**
 * Build an adjacency list from the relationship bundle.
 *
 * Each edge records:
 *  - target entity ID
 *  - relationship object (for sourceFields / predicate lookup)
 *  - direction ("forward" = sourceEntity→targetEntity, "reverse" = targetEntity→sourceEntity)
 *
 * Self-referential relationships (e.g. aida_node.parent_of.aida_node) are included.
 *
 * @param {Array} relationships — bundle.relationships
 * @returns {Map<string, Array<{entityId: string, relationship: object, direction: string}>>}
 */
export function buildAdjacency(relationships) {
  const adj = new Map();

  function addEdge(from, to, rel, direction) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ entityId: to, relationship: rel, direction });
  }

  for (const rel of relationships) {
    const src = rel.sourceEntity;
    const tgt = rel.targetEntity;
    addEdge(src, tgt, rel, "forward");
    if (rel.reversible !== false) {
      addEdge(tgt, src, rel, "reverse");
    }
  }

  return adj;
}

/**
 * BFS shortest-path search from a start entity to all reachable entities.
 *
 * Returns a Map where keys are entity IDs and values are path descriptors:
 *   { entityId, hops, path: [{ relationshipId, fromEntity, toEntity, direction }] }
 *
 * The start entity itself is included with hops=0 and empty path.
 *
 * @param {Map} adjacency — from buildAdjacency()
 * @param {string} startEntityId
 * @param {object} [options]
 * @param {number} [options.maxHops=4] — maximum traversal depth
 * @returns {Map<string, {entityId: string, hops: number, path: Array}>}
 */
export function bfsShortestPaths(adjacency, startEntityId, { maxHops = 4 } = {}) {
  const result = new Map();
  const queue = [{ entityId: startEntityId, hops: 0, path: [] }];
  const visited = new Set([startEntityId]);

  while (queue.length > 0) {
    const current = queue.shift();
    result.set(current.entityId, current);

    if (current.hops >= maxHops) continue;

    const neighbors = adjacency.get(current.entityId) || [];
    for (const edge of neighbors) {
      if (visited.has(edge.entityId)) continue;
      visited.add(edge.entityId);
      queue.push({
        entityId: edge.entityId,
        hops: current.hops + 1,
        path: [
          ...current.path,
          {
            relationshipId: edge.relationship.id,
            predicate: edge.relationship.predicate,
            fromEntity: current.entityId,
            toEntity: edge.entityId,
            direction: edge.direction,
            sourceFields: edge.relationship.sourceFields,
          },
        ],
      });
    }
  }

  return result;
}

/**
 * Find reachable entities and their dimensions from a given start entity.
 *
 * @param {object} registry — ontology registry
 * @param {string} startEntityId — e.g. "quality.defect"
 * @param {object} [options]
 * @param {number} [options.maxHops=3] — max traversal depth for dimension resolution
 * @returns {Map<string, {entityId: string, hops: number, path: Array, dimensionIds: string[]}>}
 */
export function findReachableDimensions(registry, startEntityId, { maxHops = 3 } = {}) {
  const relationships = registry.bundle.relationships;
  const dimensions = registry.bundle.dimensions;

  // Build entity → dimensionIds map
  const dimsByEntity = new Map();
  for (const dim of dimensions) {
    if (!dimsByEntity.has(dim.entityId)) dimsByEntity.set(dim.entityId, []);
    dimsByEntity.get(dim.entityId).push(dim.id);
  }

  const adjacency = buildAdjacency(relationships);
  const paths = bfsShortestPaths(adjacency, startEntityId, { maxHops });

  const result = new Map();
  for (const [entityId, descriptor] of paths) {
    result.set(entityId, {
      ...descriptor,
      dimensionIds: dimsByEntity.get(entityId) || [],
    });
  }

  return result;
}

/**
 * Check whether a dimension is reachable from the metric's entity via the
 * relationship graph, and return the join path if so.
 *
 * @param {object} registry
 * @param {string} metricEntityId — e.g. "quality.defect"
 * @param {string} targetDimensionId — e.g. "product.platform"
 * @param {object} [options]
 * @returns {{ reachable: boolean, hops: number, joinPath: Array|null, viaEntity: string|null }}
 */
export function resolveDimensionReachability(registry, metricEntityId, targetDimensionId, options) {
  // First check: dimension exists?
  let targetDimension;
  try {
    targetDimension = registry.getDimension(targetDimensionId);
  } catch {
    return { reachable: false, hops: Infinity, joinPath: null, viaEntity: null };
  }

  const targetEntityId = targetDimension.entityId;

  // Same entity → trivially reachable, 0 hops
  if (targetEntityId === metricEntityId) {
    return { reachable: true, hops: 0, joinPath: [], viaEntity: metricEntityId };
  }

  // BFS to find shortest path to the target entity
  const reachable = findReachableDimensions(registry, metricEntityId, options);
  const descriptor = reachable.get(targetEntityId);

  if (!descriptor) {
    return { reachable: false, hops: Infinity, joinPath: null, viaEntity: null };
  }

  return {
    reachable: true,
    hops: descriptor.hops,
    joinPath: descriptor.path,
    viaEntity: targetEntityId,
  };
}
