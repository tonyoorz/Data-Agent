# Ontology V1 governance

Ontology V1 is the semantic control plane for Main Agent V2. Natural-language model output is only a candidate; the compiled Ontology, actor policy, constraints, and deterministic planner decide what may execute.

## Canonical sources

The versioned sources under `ontology/v1` are:

- `entities.json`, `relationships.json`, and `dimensions.json` for the business graph and allowed analysis axes;
- `metrics.json` for governed metric definitions, time fields, grain, units, and approval state;
- `vocab.zh-CN.json` for deterministic vocabulary resolution;
- `sources.json` for source mappings and revision semantics;
- `policies.json` for mandatory actor scope, read-only capabilities, and redaction policy;
- `constraints.json` for query limits, approved-metric-only planning, arbitrary-SQL prohibition, Claim/Evidence coverage, and similarity restrictions.

The compiler validates every source against `ontology/schema`, verifies cross-references, emits `ontology/generated/ontology.compiled.json`, and writes the SHA-256 fingerprint to `ontology/generated/fingerprint.txt`. Node and Python loaders reject incompatible or malformed catalogs. The current fingerprint is `6a3db74b359004ceaf56ce395bca5f21d6d83927cd2d03c59a832b0155dcd13e`.

## Enforcement path

1. The certified model proposes a schema-constrained SemanticFrame candidate.
2. The resolver maps only known entities, metrics, dimensions, vocabulary, and time fields.
3. `actor.scope.mandatory` injects current actor scope; scope is recomputed for every Run and is never inherited from conversation memory.
4. Planner constraints reject draft metrics, unknown operations, arbitrary SQL, and limits above `query.max_limit` (currently 200).
5. Registered read-only tools execute canonical arguments and attach source revision and authorization metadata to Evidence.
6. Claim validation requires Evidence coverage and prevents similarity results from becoming population statistics.

Ontology-declared value patterns can materialize business values such as PU identifiers even when the user omits the dimension label. Traceability also has a governed `testing.trace_status` dimension: `Untraced` selects TestCase gaps, while AIDA identifiers become explicit `requirements.aida` filters. Source freshness SLOs are part of the catalog and stale explicit watermarks downgrade completeness with a warning.

Policy denials are terminal and use stable safe codes. Disabling analytics or defect context produces `ANALYTICS_CONTEXT_DISABLED` or `DEFECT_CONTEXT_DISABLED`; the planner does not silently use another source.

## Change procedure

Every Ontology change requires an owner and governance status, a schema-valid source edit, generated artifact updates, and a semantic/evaluation regression case. Run:

```bash
npm run ontology:compile
npm run ontology:check
npm run semantic-golden:check
npm run runtime-target:check
npm run test:ontology
```

Do not edit generated files by hand. A changed fingerprint is a compatibility boundary for checkpoints, semantic summaries, evaluation reports, and deployment health. Metric-definition changes also require an entry in `metric-decisions.md` and approval from the named metric owner.
