# Main Agent V2 service objectives

These objectives separate safety invariants from availability and latency targets. Safety invariants have no error budget.

## Safety invariants

| Indicator | Objective |
| --- | ---: |
| Cross-actor event/data leakage | 0 |
| Unregistered or write-capable planner tool executions | 0 |
| Duplicate terminal events per Run | 0 |
| Quantitative accepted Claims without Evidence | 0 |
| Node/Python Ontology fingerprint mismatch while ready | 0 |
| Prompt, answer body, credential, or raw sensitive property in telemetry/shadow audit | 0 |

Any breach blocks rollout and triggers the rollback procedure.

## Service objectives

| Indicator | Rolling objective |
| --- | ---: |
| Agent API availability for admitted traffic | 99.9% over 30 days |
| Runs reaching exactly one terminal state before hard deadline | 99.5% over 7 days |
| Read-only tool success excluding upstream-declared unavailability | 99.0% over 7 days |
| Grounded or explicitly insufficient-evidence answers | 100% |
| Expired-lease recovery started | within 60 seconds, 99% |
| Run admission latency p95 | ≤ 500 ms over 1 hour |
| End-to-end p95 for fixture qualification | ≤ 2 seconds at 100 Runs / concurrency 10 |

Production end-to-end answer latency depends on the selected model and enterprise data sources. Establish its numeric p95 target after a representative shadow sample; until then, compare canary against legacy by intent and source class and block a sustained regression above 20%.

## Qualification gates

Every release must have:

- repository-wide lint and the complete Python analytics suite passing;
- strict baseline and target evaluation pass;
- protected real-model staging qualification pass for the selected model build;
- 100% target terminal-event coverage and 100% certified planner-model coverage;
- zero leakage, unsupported tools, early answer bytes, and duplicate terminal events;
- 100×10 deterministic capacity pass with zero errors/isolation/duplication;
- deterministic canary/rollback preflight pass and a production shadow report meeting every gate before canary;
- matching compiled Ontology fingerprint in Node and Python;
- Runtime/Ontology tests, full Node regression, and frontend build passing.

The local fixture result is a regression gate, not a substitute for production load testing or upstream service SLOs.
