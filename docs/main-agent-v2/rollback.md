# Main Agent V2 rollback

## Immediate rollback

1. Set `MAIN_AGENT_RUNTIME_MODE=legacy` in the service configuration.
2. Restart the API instances using the normal deployment mechanism.
3. Verify `/api/agent/config` reports `runtimeMode=legacy` and `agentApiEnabled=false` for representative actors.
4. Run `npm run qualify:agent:rollout -- --mode rollback`; both the legacy and canary-0% gates must pass.
5. Verify `/api/ai/chat` still streams a response and new `/api/agent/runs` requests are rejected with `AGENT_RUNTIME_NOT_ENABLED`.
6. Leave the runtime database, checkpoints, audit records, and artifacts intact for investigation. Do not delete or downgrade them during an incident.

This switch is server authoritative; no frontend deployment is needed. Existing V2 event streams may finish during process drain. After restart, background recovery may inspect unfinished runs, but no new user-visible V2 Run is admitted in legacy mode.

## Automatic rollback triggers

Rollback immediately for any of the following:

- cross-actor data or event leakage above zero;
- an unregistered or write-capable tool execution;
- duplicate terminal events or non-idempotent duplicate writes;
- Node/Python Ontology fingerprint mismatch;
- verified unsupported quantitative claims or sensitive-field disclosure;
- health readiness below target for 10 minutes;
- terminal success or latency breaching the agreed error budget for two consecutive windows.

For lesser regressions, set canary percentage to zero first, then decide whether a full legacy rollback is necessary.

## Recovery after rollback

1. Identify affected run IDs and pair `runtime.shadow_*`/runtime audit records without reading prompt text.
2. Reproduce with the deterministic evaluator or a sanitized regression case.
3. Add a failing unit/integration/evaluation case before applying the fix.
4. Re-run the full release prerequisites in `operations.md`.
5. Return through shadow and staged canary; do not jump directly from rollback to full `langgraph`.

Database schema rollback is intentionally not part of the traffic rollback. Forward-compatible migrations and retention preserve forensic and recovery state.
