# Main Agent V2 final qualification report

Qualified locally on 2026-07-16 from branch `upgrade/2026-07-main-agent-v2`, based on `feature/2026-07-15-main-agent-runtime-sync` at `372e682`. The deterministic implementation and local release gates are complete. The compiled Ontology fingerprint is `6a3db74b359004ceaf56ce395bca5f21d6d83927cd2d03c59a832b0155dcd13e`.

## Blocking deterministic gates

| Gate | Command | Result |
| --- | --- | --- |
| Ontology compile consistency | `npm run ontology:check` | Pass; 6 sources, 19 entities, 15 relationships, 22 dimensions, 22 metrics, 37 terms, 3 policies, 5 constraints |
| Semantic goldens | `npm run semantic-golden:check` | Pass; 113/113 generated cases consistent |
| Runtime target generation | `npm run runtime-target:check` | Pass; 72/72 generated cases consistent |
| Repository lint | `npm run lint` | Pass; zero errors and warnings |
| Runtime/Ontology/UI contracts | `npm run test:agent-runtime` | Pass; 45 files, 209 tests |
| Full Node/UI regression | `npm test` | Pass; 95 files, 434 tests; no React `act(...)` warnings |
| Full Python analytics regression | `.venv/bin/python -m pytest backend/tests -q` | Pass; 282 passed, 5 platform-specific skips on Linux; one upstream Starlette deprecation warning |
| Production frontend build | `npm run build` | Pass; existing large-chunk advisory remains non-blocking |
| Baseline runtime evaluation | `npm run eval:agent:baseline -- --strict` | Pass; 5/5 |
| Target runtime evaluation | `npm run eval:agent:target -- --strict` | Pass; 72/72 |
| Deterministic capacity | `npm run load:agent-runtime -- --strict --iterations 100 --concurrency 10` | Pass; 0 errors; p50 517 ms; p95 1,051 ms; p99 1,440 ms; 17.82 Runs/s |
| Canary/rollback preflight | `npm run qualify:agent:rollout -- --sample-size 10001 --canary-percentage 5` | Pass; 509/10,002 selected (5.09%), allowlist 1/1, rollback 100/100 |
| Runtime migration readiness | `npm run agent:runtime:migrate` then `npm run agent:runtime:check` against a fresh DB | Pass; schema version 1 and LangGraph Saver marker ready |
| Retention planning | `npm run agent:runtime:cleanup` in dry-run mode | Pass; deterministic manifest generated, no delete performed |
| Patch integrity | `git diff --check` | Pass |

Target hard gates all passed: terminal-event coverage 100%, certified planner-model coverage 100%, cross-actor leakage 0, unsupported tools 0, early answer bytes 0, and duplicate terminal events 0. The capacity run also reported terminal coverage 100%, zero isolation violations, zero duplicate events, and zero duplicate tool executions.

## Behavior qualified

- `server/agentRuntime/graph.mjs` is the single orchestration kernel. The legacy chat adapter delegates to the same Runtime rather than owning an independent planning policy.
- A certified-model adapter proposes a schema-constrained semantic candidate; Ontology resolution, current actor policy, constraints, budgets, and the deterministic planner remain authoritative.
- Multi-step plans, replanning, typed read-only tools, strict tool journals, cancellation, leases, checkpoints, recovery, and same-Run clarification resume are executable and tested.
- Node and Python validate the same Ontology fingerprint and semantic query contract. Versioned `policies.json` and `constraints.json` enforce approved metrics, dimensions, relationships, tool capabilities, mandatory scope, and plan limits.
- Governed business resolution now covers calendar trends/comparisons, Ontology-declared dynamic PU values, AIDA-subject trace filters, failed-Run lineage, and the explicit `testing.trace_status=Untraced` path for TestCases without Requirement links. Draft pass-rate, coverage, density, and resolution-speed definitions fail closed into focused clarification.
- Every quantitative answer passes Evidence and Claim validation. Observed values must match the exact Evidence dimension group, comparison deltas are recomputed from their input Claims, and `answer.completed` is persisted before the terminal event with grounding, accepted Claim IDs, citations, assumptions, and limitations.
- Thread creation, deterministic semantic-summary ordering, attachment upload/binding, event replay, cancellation, same-Run clarification resume, selectable clarification options, citation rendering, and protocol-failure fallback are covered through the public API/UI contracts.
- OpenTelemetry spans, counters, and histograms use hashed identities and safe attributes. Qualification/load/shadow reports exclude raw prompts, answers, Evidence payloads, filters, tool arguments, credentials, and raw Run/thread IDs.
- Repository-wide Python baseline debt is closed, including Analytics CLI compatibility, hot-snapshot test setup, grouped detail mappings, an optional-dependency-safe duplicate-search fallback, and explicit Windows-only script coverage in CI.

## Deployment-only promotion gates

Two gates cannot be truthfully established from a local deterministic fixture and therefore remain mandatory before production traffic is promoted:

1. Configure the intended HTTPS staging deployment in the protected `MAIN_AGENT_QUALIFICATION_BASE_URL` environment variable, then run the protected `Main Agent controlled real-model qualification` workflow with the certified model ID. It fails closed for missing/invalid targets and stores authentication only in the protected environment secret.
2. Collect at least 100 representative production `shadow` dispatches and run `npm run report:agent:shadow` against the production audit database. Review pairing, grounding, citation, completion, latency, and scope gates before enabling canary traffic.

These are environment evidence requirements, not missing implementation. No staging credential, production audit database, deployment, push, or external side effect was available or used during local qualification.
