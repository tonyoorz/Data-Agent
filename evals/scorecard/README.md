# DTSV main-agent scorecard

A single scorecard that combines a deterministic **offline routing baseline** with
six **runtime metrics** for the DTSV main agent. Designed to be the long-term
quality dial: run locally, in CI, and over historical traffic.

## Why two layers

- The **offline baseline** replays `evals/main-agent/target/agent-golden.jsonl`
  against `selectMainAgentToolset` / `shouldPlanMainAgentTools` (the same pure
  functions the vitest golden suite checks). It protects against regressions in
  intent classification and toolset selection, with no traffic dependency.
- The **runtime metrics** aggregate `logs/agent-runtime/run-summaries.jsonl`,
  which `runtimeAuditStore.appendRunSummary` writes on every run. They describe
  how the agent actually behaves in production-shaped traffic.

The runner reuses the existing golden bank as the canonical routing bank — there
is no parallel题库 to maintain.

## Run

```bash
npm run eval:scorecard                    # default: live logs, fall back to fixture
node ./scripts/runScorecard.mjs --runtime-file path/to/run-summaries.jsonl
node ./scripts/runScorecard.mjs --offline-skip        # runtime metrics only
node ./scripts/runScorecard.mjs --out-dir /tmp/cards
```

Outputs land under `evals/scorecard/output/` (gitignored) as both
`scorecard-<timestamp>.json` and `scorecard-<timestamp>.md`, and the markdown is
also echoed to stdout.

## Data source

If `logs/agent-runtime/run-summaries.jsonl` exists and is non-empty, it is used
and `source = logs`. Otherwise the runner uses
`evals/scorecard/fixtures/sample-run-summaries.jsonl` and reports
`source = fixture`, so CI always produces a non-empty scorecard even before the
agent has served traffic. Point `--runtime-file` at any historical jsonl to score
a specific window.

## The six runtime metrics

Each is derived purely from run-summaries.jsonl fields. All percentages are
rounded to one decimal.

| metric | what it measures | field basis |
| --- | --- | --- |
| `intent_coverage_pct` | share of the golden intent universe actually observed in runs | `intent` vs agent-golden `expected.intent` |
| `outcome_distribution` | share of completed / blocked / denied / needs_clarification / error | `outcome` |
| `citation_pass_rate_pct` | share of runs whose answer citations validated as `pass` | `citationValidation` |
| `business_rule_activation_pct` | share of runs that activated at least one approved business rule | `businessRuleCodes` |
| `recovery_success_rate_pct` | among runs that attempted recovery, share that recovered | `recoveryOutcomes` |
| `latency_ms` (p50/p95/max) | run latency distribution in ms | `latencyMs` |

`failure_top_codes` is reported as a diagnostic (not one of the six) to surface
what breaks most often.

## Exit code semantics

The exit code reflects **only** the offline baseline, so the runner is usable as
a regression gate in CI:

- `0` — offline baseline passed (or offline layer unavailable / skipped).
- `1` — offline baseline has at least one failing case (regression).
- `2` — runner error (e.g. no agent-golden bank found).

Missing runtime data is **not** a failure — the agent may simply not have served
traffic yet; the runtime layer reports `hasData: false` and the offline baseline
still runs.

## Adding cases

Routing cases live in `evals/main-agent/target/agent-golden.jsonl` and are owned
by the existing golden suite. Add new intent/toolset expectations there and both
`npm run test:agent-evals` and `npm run eval:scorecard` pick them up
automatically — the intent universe is derived from `expected.intent` in that
file.
