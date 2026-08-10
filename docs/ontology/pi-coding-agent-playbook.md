# PI Coding Agent Ontology Playbook

## Rule

For Vizion Lab analytics, defect, testing, traceability, and testcase-context code changes, the PI coding agent must treat the ontology bundle and semantic query contracts as the source of truth for business concepts.

## Required Checks Before Editing

1. If changing a metric, dimension, entity, policy, source binding, vocabulary, or semantic tool contract, inspect `ontology/v1/*` first.
2. If adding or renaming a business concept, update ontology source JSON before changing resolver or executor code.
3. If changing semantic query behavior, update both Node tests under `src/test/server/ontology` and Python tests under `backend/tests/test_semantic_query_api.py`.
4. If changing testcase drafting behavior, keep `/api/ontology/context` and `get_test_case_context` tests passing.

## Validation Commands

```powershell
npm run ontology:check
npm test -- src/test/server/ontology src/test/server/mainAgentTools.test.ts src/test/server/mainAgentToolLoop.test.ts
python -m pytest backend/tests/test_ontology_contract.py backend/tests/test_semantic_query_api.py backend/tests/test_analytics_ontology_context.py -q
```