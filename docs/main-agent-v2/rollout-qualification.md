# Rollout qualification

Release qualification separates deterministic code gates from deployment evidence. Local fixtures can prove routing, rollback, lifecycle, grounding, and regression behavior; only staging/production samples can prove real-model and upstream parity.

## Deterministic preflight

Run before every deployment:

```bash
npm run qualify:agent:rollout -- --output artifacts/rollout-preflight.json
```

The preflight uses 10,000 stable actor IDs to verify deterministic canary distribution, allowlist behavior, server decision coherence, and both rollback switches (`legacy` and canary 0%). The report is written atomically with owner-only permissions.

## Real-model staging gate

The protected `Main Agent controlled real-model qualification` workflow runs five sanitized business cases against the HTTPS staging URL configured in the protected `MAIN_AGENT_QUALIFICATION_BASE_URL` environment variable and an explicitly selected certified model ID. It fails closed when the URL is absent, invalid, non-HTTPS, or the model is `fake-certified`; redirects are rejected. Authentication headers are read directly from the protected `MAIN_AGENT_QUALIFICATION_HEADERS_JSON` environment secret, are not passed in process arguments, and are never written to reports.

The resulting report contains hashes, safe IDs, counts, tool names, timing, grounding, and citation coverage. It excludes answer bodies, Evidence payloads, raw Run/thread IDs, semantic filter values, canonical tool arguments, and limitation text.

## Production shadow gate

After collecting at least 100 representative dispatches, run:

```bash
npm run report:agent:shadow -- \
  --db-path /path/to/runtime.sqlite \
  --min-samples 100 \
  --max-latency-regression-pct 20 \
  --output artifacts/production-shadow.json
```

Promotion requires intact audit pairing, at least 99% pair coverage, Runtime failure rate at most 1%, completion regression at most one percentage point, 100% grounded-or-insufficient policy, 100% citation coverage for Claim-bearing answers, and at least 95% latency-pair coverage with p95 regression no greater than the configured threshold. It additionally requires at least 95% comparable coverage for governed semantic, scope, planned-tool, and numeric signatures; scope and numeric matches must be 100%, while semantic and tool matches must be at least 95%. The signatures are one-way hashes derived from the governed structures and answer-number tokens. The report contains only aggregate metrics and a source digest—not signatures, filters, raw correlation IDs, or message bodies.

Canary promotion remains a human deployment decision. Recommended stages are 1%, 5%, 25%, 50%, and 100%, with SLO review at each stage. Any safety-invariant breach triggers `rollback.md` immediately.
