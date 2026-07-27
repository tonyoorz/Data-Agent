## Summary

<!-- What does this change do, and why? Link the CQ / metric-decision / issue it serves. -->

## Change type

- [ ] Ontology (`ontology/**`, `server/ontology/**`, `server/agentRuntime/ontology*`)
- [ ] Agent runtime / planner / resolver
- [ ] Analytics API / data model
- [ ] Frontend
- [ ] Docs only
- [ ] Other

## Ontology-change checklist (required if any `ontology/**` file changed)

A metric / entity / dimension / relationship / source / policy stays the source of truth for what the Agent may compute. Keep it governed.

- [ ] `npm run ontology:compile` passes (regenerates `ontology/generated/*` + `docs/ontology/graph.md`)
- [ ] `npm run ontology:check` passes (fingerprint consistent)
- [ ] `npm run test:ontology` passes (TS + Python contract)
- [ ] `npm run semantic-golden:check` passes (113 golden cases)
- [ ] **Status transitions** are explicit: any `draft → approved` cites an approved decision in `docs/main-agent-v2/metric-decisions.md`; any removal is `deprecated` with a changelog entry (never a silent delete)
- [ ] **Draft → approved only** when grain / numerator-denominator / defaultTimeDimension / missingDataPolicy / source revision are all confirmed (see `docs/ontology/draft-metric-cleanup.md` §三)
- [ ] Committed `ontology/generated/ontology.compiled.json` + `fingerprint.txt` reflect this change (do not commit stale generated output)
- [ ] If a metric's business definition changed, note it under "Semantic changelog" below

## Semantic changelog (if fingerprint changed)

<!-- e.g. "defect.open_count: draft → approved (terminal status set approved per metric-decisions.md)" -->

## Verification

<!-- Commands run + results. Attach eval / golden output if behavior changed. -->
