# Main Agent V2 baseline report

Baseline captured on 2026-07-16 before semantic-core changes.

## Source baseline

- Repository: `tonyoorz/Data-Agent`
- Requested branch: `feature/2026-07-15-main-agent-runtime-sync`
- Requested baseline commit: `372e682466999d1ab09471af050497cf2225f0cb`
- Upgrade branch: `upgrade/2026-07-main-agent-v2`
- Dev-server stability branch merged: `feature/2026-07-15-dev-server-stability` at `aa17803f1cf959a8eda18539d7da56a4aaed3931`
- Merge commit: `92f2d27`

## Environment and installation

- Node: `v24.14.0`
- npm: `11.9.0`
- Python: `3.12.13`
- Node install: `npm ci --cache /tmp/npm-cache-data-agent --prefer-offline`
- Python tests use a local `.venv`; only the imports required by the test suite were installed because the unbounded `sentence-transformers>=2.7.0` dependency currently resolves to a CUDA-enabled Torch stack.

## Baseline gates

| Command | Baseline result | Classification |
| --- | ---: | --- |
| `npm run test:agent-runtime` | 31 files, 114 tests passed | green |
| `npm test` | 81 files, 336 tests passed | green |
| `npm run build` | passed | green, with existing large-chunk warnings |
| `npm run lint` | 50 errors, 32 warnings | existing repository debt |
| `python -m pytest backend/tests -q` | 236 passed, 24 failed | existing repository/platform debt |
| merged `devHelpers.test.ts` | 13 passed | green |

The Python failures include five Windows PowerShell-only tests, optional local-embedding behavior, and existing Analytics CLI/API contract drift. Running the suite also modified `backend/database/ticket_embeddings.db`; that test side effect was reverted immediately.

## Runtime behavior before the upgrade

- `/api/ai/chat` owns the mature legacy chat/tool loop.
- `/api/agent` owns durable threads, run idempotency, actor isolation, event outbox, leases, audit records, and strict request/event/answer contracts.
- The new graph did not call a model, used a regex semantic adapter, built one hard-coded tool step, and rendered a hard-coded 2026 defect sentence.
- Graph node events were generated in memory but not committed to the production event stream.
- The evaluator returned an empty `failedCaseIds` without executing a Run.
- The load runner defaulted to zero iterations and returned fixed success metrics.

## Phase 1 qualification after replacing placeholders

- Executable baseline: 5/5 cases pass in strict mode.
- Executable target gap: 15/60 cases pass and 45/60 fail.
- Target hard gates: terminal coverage 100%, cross-actor leakage 0, unsupported tools 0, early-answer bytes 0, duplicate terminal events 0.
- Local load smoke: 5/5 terminal runs, zero errors, zero duplicate events, zero isolation violations, zero duplicate tool executions.

The target suite remains intentionally strict. Its 45 failures are the measured backlog for Ontology, planning, lifecycle scenario orchestration, recovery, and isolation qualifications.

## Upgrade-branch debt closure

The baseline above remains the historical pre-upgrade record. On the completed upgrade branch:

- repository-wide lint moved from 50 errors/32 warnings to a clean pass;
- the full Python suite moved from 236 passed/24 failed to 282 passed/5 expected platform skips on Linux;
- Analytics CLI/API drift, hot-snapshot test setup, grouped detail mappings, and optional duplicate-search dependencies were repaired without weakening production read-path rules;
- PowerShell integration tests now skip only on non-Windows hosts and run in a dedicated Windows CI job;
- the full Node/UI suite passes 434 tests without the prior React `act(...)` warnings.

The final deterministic qualification is recorded in `qualification-report.md`.
