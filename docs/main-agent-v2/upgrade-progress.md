# Main Agent V2 upgrade progress

Last updated: 2026-07-16. All planned implementation phases and deterministic local gates are complete on `upgrade/2026-07-main-agent-v2`.

| Phase | Status | Gate evidence |
| --- | --- | --- |
| 0. Baseline and stability | complete | Requested commit verified; dev-server stability merged; historical Node, Python, lint, and build baseline recorded. |
| 1. Executable qualification | complete | Evaluator executes real HTTP/SSE Runs; load runner executes concurrent Runs; reports are machine-readable, redacted, and strict. |
| 2. Ontology V1 | complete | Deterministic compiler, JSON Schemas, shared Node/Python loader, catalog validation, 3 policies, 5 constraints, and fingerprint `6a3db74b359004ceaf56ce395bca5f21d6d83927cd2d03c59a832b0155dcd13e`. |
| 3. SemanticFrame and planner | complete | Certified model candidate plus governed entity/metric/dimension/time resolution, ambiguity handling, mandatory scope, deterministic multi-step QueryPlan, and 113 semantic goldens. |
| 4. Unified graph and tools | complete | `main-agent-v2` graph is the single orchestration kernel; legacy calls delegate to Runtime; registered read-only semantic tools replace arbitrary execution. |
| 5. Evidence and claims | complete | Typed Evidence, source revision, authorization/redaction state, Claim validation, citation binding, insufficient-evidence behavior, and transactional `answer.completed`. |
| 6. Durable execution | complete | SQLite Saver, canonical checkpoint lineage, lease heartbeat/recovery, exact terminalization, same-Run interaction resume, and persistent StepJournal. |
| 7. Governance and API | complete | Trusted identity fails closed, actor scope reaches Node/Python, policies and constraints are Ontology-as-Code, artifacts are sandboxed, and thread/event/attachment APIs are versioned. |
| 8. Operations and cutover | complete (code/local gates) | OpenTelemetry, redacted shadow comparison, cleanup, server-controlled rollout, strict 72/72 target, 100×10 capacity, deterministic canary, rollback preflight, and protected real-model workflow. Staging/production evidence remains a deployment gate. |

## Final qualification snapshot

- Repository lint: clean.
- Runtime/Ontology/UI contracts: 209/209; full Node/UI regression: 434/434.
- Full Python analytics regression: 282 passed and 5 expected platform skips on Linux; Windows PowerShell integration has a dedicated blocking CI job.
- Baseline runtime evaluation: 5/5; target runtime evaluation: 72/72.
- Target hard gates: terminal coverage 100%; planner-model coverage 100%; cross-actor leakage 0; unsupported tools 0; early answer bytes 0; duplicate terminal events 0.
- Independent semantic resolver goldens: 113/113, including governed PU comparisons, AIDA trace subjects, failed-Run lineage, and untraced TestCases.
- Capacity fixture: 100 Runs at concurrency 10; zero errors, duplicate events, isolation violations, or duplicate tool executions; p95 1,051 ms.
- Canary/rollback preflight: 10,002 actors including the explicit allowlist actor, 5.09% selected for a 5% target, allowlist 1/1, all 100 rollback decisions correct in each tested mode.
- Production build: pass; only the pre-existing chunk-size advisory remains.

## Release boundary

Implementation completion does not authorize deployment. Before canary, the release owner must run the protected real-model staging workflow and provide a passing production shadow report from at least 100 representative samples. See `qualification-report.md` and `rollout-qualification.md` for the exact gates.
