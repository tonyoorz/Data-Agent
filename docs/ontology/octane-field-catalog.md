# Octane Field Catalog

The Octane field catalog is the raw field asset layer for ontology work. It inventories local Octane SQLite tables, regular columns, and sampled `raw_json` keys, then exposes a small top-k search surface for agents. It is not the governed business ontology.

Use this layer when the agent needs to discover which Octane/API/database field may back a business concept, filter, editable field, or future action schema. Use governed ontology and analytics tools to answer factual business questions.

## Generate

```powershell
python -m backend.analytics_cli build-octane-field-catalog --db-path database/source/qgate_raw.db --output-path ontology/generated/octane-field-catalog.local.json --query-text "DTSV 车系" --top-k 8
```

The generated artifact contains summary counts, table/field records, and draft ontology candidates. It should be regenerated after source schema refreshes or after adding new field aliases/bucket rules.

## Runtime Search

Backend API:

```http
POST /api/ontology/fields/search
Content-Type: application/json

{"query":"DTSV 车系","top_k":8,"entity":"defect"}
```

Response shape intentionally returns only `summary`, `results`, and `source`. It does not return the full `fields` catalog, so prompts stay small and the agent works through retrieval instead of context stuffing.

The API uses `VIZION_OCTANE_FIELD_CATALOG_PATH` when set, otherwise it prefers `ontology/generated/octane-field-catalog.local.json` when no source DB override is active. It falls back to scanning the configured local SQLite source DB and caches the loaded/built catalog by file or DB mtime.

## Agent Tool

`search_octane_fields` calls the backend search endpoint and formats candidate fields as schema hints. These candidates can guide follow-up ontology mapping, metric design, filters, and future CRUD/action ontology work, but they are not factual query results by themselves.

Planner rule: do not load the full Octane field catalog into the prompt. Retrieve top-k candidates, then validate facts through governed ontology or analytics tools.

## Action Ontology

Write/update/delete capability is represented in `ontology/v1/actions.json` and compiled into `ontology/generated/ontology.compiled.json`. This keeps action capability states under the same schema validation and fingerprint contract as metrics, dimensions, policies, and constraints.

Current actions are intentionally conservative:

- `octane.defect.add_comment`: `dry_run_only`, draft, requires dry-run, human approval, actor scope, and run/tool/external request audit.
- `octane.defect.update_triage_fields`: `disabled`, draft field-candidate map for future governed updates.
- `octane.defect.delete_work_item`: `blocked`, explicit destructive-action policy boundary.

Agent rule: answer write/update/delete questions from Action Ontology capability states. Field catalog results may identify candidate Octane fields, but disabled or blocked actions must not be executed, and no field candidate is enough to authorize a write path.
