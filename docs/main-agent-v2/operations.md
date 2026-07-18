# Main Agent V2 operations runbook

## Release prerequisites

Before changing traffic mode:

1. Run `npm ci`, `npm run lint`, `npm run ontology:check`, `npm run semantic-golden:check`, and `npm run runtime-target:check`.
2. Run `npm run test:agent-runtime`, `npm test`, `python -m pytest backend/tests -q`, `npm run test:analytics-semantic`, and `npm run build`.
3. Run `npm run eval:agent:baseline -- --strict`, `npm run eval:agent:target -- --strict`, and the protected real-model staging workflow.
4. Run `npm run load:agent-runtime -- --strict --iterations 100 --concurrency 10 --output artifacts/load-qualification.json` and `npm run qualify:agent:rollout -- --output artifacts/rollout-preflight.json`.
5. Run `npm run agent:runtime:check` against the intended SQLite file. Apply migrations through the repository migration command before starting the service.
6. Confirm `/health` returns HTTP 200 with `ready=true`, matching Node/Python Ontology fingerprints, `runtimeDbReady=true`, `saverReady=true`, and `analyticsReady=true`.

Production must use trusted-proxy identity. Configure an explicit scope provider or `MAIN_AGENT_SCOPE_PROVIDER_URL`; startup fails closed without it. Never expose dev identity on a non-loopback host.

## Traffic modes

`MAIN_AGENT_RUNTIME_MODE` is the sole release switch:

- `legacy`: all user-visible chat stays on the legacy endpoint.
- `shadow`: legacy remains user-visible while V2 runs independently in the background. Shadow cannot execute duplicate-search to avoid duplicated external cost.
- `canary`: V2 is selected by a stable actor hash and/or `MAIN_AGENT_CANARY_ACTOR_ALLOWLIST`; configure `MAIN_AGENT_CANARY_PERCENTAGE` from 0 to 100.
- `langgraph`: all eligible user-visible chat uses V2.

The browser reads `/api/agent/config`; local storage cannot enable V2. The server recomputes the actor-specific decision on every Run start, so a forged client request cannot bypass rollout policy.

Recommended progression is `legacy → shadow → canary 1% → 5% → 25% → 50% → 100%/langgraph`. Hold each stage for at least one representative business cycle and the minimum sample required by the SLO review.

Do not promote a build whose target report has planner-model coverage below 100%. `model.completed` exposes only model ID, planning purpose, a normalized finish reason, and token counts. `model.fallback` exposes only a normalized safe code. Neither event may contain prompts, semantic candidates, answer bodies, chain-of-thought, or provider exception text.

## Shadow review

Shadow data is stored as redacted audit actions sharing the V2 `run_id`:

- `runtime.shadow_dispatch`
- `runtime.shadow_legacy_result`
- `runtime.shadow_result`

The records contain correlation IDs, one-way semantic/scope/tool/numeric signatures, answer hashes, character counts, timings, SemanticFrame IDs, tool names, evidence/claim/citation counts, grounding status, and safe error codes. They do not contain prompt text, answer text, filter values, or raw provider errors. Compare paired records by `run_id`; any scope or numeric signature mismatch is a release blocker, and semantic/tool drift must remain within the documented threshold.

Local deterministic qualification proves regression behavior but is not a production shadow sample. Before the first canary, collect representative paired records across real business intents, actors, scopes, and upstream revisions; record the sample window and promotion decision in the release ticket.

Generate the blocking aggregate report with `npm run report:agent:shadow -- --db-path /path/to/runtime.sqlite --output artifacts/production-shadow.json`. The exact gates and redaction guarantees are documented in `rollout-qualification.md`.

## Health and alerts

Page an operator when any invariant in `slo.md` is violated. In particular, immediately stop expansion for actor leakage, unsupported tool execution, Ontology fingerprint mismatch, duplicate terminal events, checkpoint incompatibility, or missing source revision.

Use the health telemetry snapshot for counts and latency summaries. Runtime, recovery, tool, and analytics-query operations also emit OpenTelemetry spans, counters, and histograms through `@opentelemetry/api`. Production must register its approved SDK/exporter in the host bootstrap; the Runtime remains safe when no exporter is configured. Actor, thread, Run, and query identities are hashed before attributes are emitted.

Use audit details for a single run; never add prompt text, credentials, access codes, raw sensitive properties, canonical filter values, answer bodies, or model chain-of-thought to logs.

## Retention and cleanup

`npm run agent:runtime:cleanup` is dry-run by default and emits an inspectable manifest. Apply only after reviewing the manifest:

```bash
npm run agent:runtime:cleanup -- --apply --confirm DELETE_EXPIRED_AGENT_DATA
```

Cleanup preserves live runs, referenced checkpoints, child/fork lineage, and actor isolation. Back up the SQLite database and artifact root before the first production cleanup policy change.

## Incident evidence

For an incident, retain the health response, runtime mode/config, graph version, Ontology fingerprint, source revision set, run ID, safe audit actions, cleanup manifest, and evaluation artifact. Do not export raw artifacts or answer bodies unless the data owner explicitly authorizes it.
