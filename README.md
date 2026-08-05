# Vizion Lab

[![Node](https://img.shields.io/badge/Node-24.x-339933?logo=node.js&logoColor=white)](#quick-start)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](#technology-stack)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](#technology-stack)
[![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?logo=python&logoColor=white)](#quick-start)
[![FastAPI](https://img.shields.io/badge/FastAPI-local%20analytics-009688?logo=fastapi&logoColor=white)](#technology-stack)

Vizion Lab is a self-contained local analytics workspace for QGate / Octane defect intelligence, Main Dashboard reporting, duplicate issue search, AI-assisted defect context, and static KPI report generation.

It is designed for demo, review, and local daily operation: clone the repository, install dependencies, provide local data or Octane access, and run the complete dashboard without checking out any sibling project.

## Highlights

- Self-contained runtime: no sibling `TPMDashboard` checkout and no Lovable Playwright helper package required.
- Main Dashboard: local analytics API backed by repository-local SQLite source and hot databases.
- Duplicate Search: Python search backend embedded in this repository, with feedback and cache support.
- AI Chat: local Node API injects QGate defect context before calling configured company model endpoints.
- Native KPI Reports: QGate dashboard and compare reports generated directly from this repository.
- Operator-friendly refresh: one-command source refresh and optional Windows scheduled task wrapper.

## Demo Flow

A reviewer can evaluate the project in this order:

1. Start the local stack with `npm run dev`.
2. Open `http://127.0.0.1:8080`.
3. Review Main Dashboard and Top Issue / Coverage analysis pages.
4. Try AI Chat or Duplicate Search after configuring model credentials and local source data.
5. Generate static QGate reports with `npm run report:qgate-kpi`.

## Screens And Features

| Area | What it shows | Local backend |
| --- | --- | --- |
| Main Dashboard | defect outcomes, team expansion, ticket drilldowns, dashboard freshness | FastAPI analytics API on port `3003` |
| AI Chat | model responses enriched with related defect context | Node API on port `3004` plus local duplicate search |
| Duplicate Search | similar defect candidates and feedback loop | embedded Python bridge and SQLite source |
| Coverage Analysis | test coverage views derived from local analytics data | FastAPI analytics API |
| QGate Reports | standalone HTML dashboard and compare reports | native Python report generator |

## Architecture

```mermaid
flowchart LR
  Browser[React Dashboard<br/>Vite :8080] --> NodeAPI[Local Node API<br/>:3004]
  Browser --> AnalyticsAPI[FastAPI Analytics<br/>:3003]
  NodeAPI --> DuplicateSearch[Python Duplicate Search]
  NodeAPI --> ModelAPI[Configured Company Model API]
  DuplicateSearch --> SourceDB[(database/source/qgate_raw.db)]
  AnalyticsAPI --> SourceDB
  AnalyticsAPI --> HotDB[(database/hot/vizion_serving.db)]
  Reports[QGate KPI Reports] --> SourceDB
```

## Technology Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18, Vite 5, TypeScript, Tailwind CSS, shadcn/Radix UI |
| Local API | Node.js 24, native HTTP server, SSE streaming |
| Analytics API | Python, FastAPI, Uvicorn |
| Data | SQLite source DB, SQLite hot DB, optional DuckDB/Parquet cold archive |
| Search | pandas, scikit-learn, sentence-transformers |
| Testing | Vitest, Testing Library, Pytest, Playwright |

## Quick Start

Run commands from the repository root in Windows PowerShell.

### 1. Use Node 24

```powershell
nvm use 24.14.0
```

### 2. Install JavaScript Dependencies

```powershell
npm install
```

### 3. Create Python Environment

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

If you need browser-based Octane cookie refresh, install Chromium once:

```powershell
.\.venv\Scripts\python.exe -m playwright install chromium
```

### 4. Start Everything

```powershell
npm run dev
```

The dev command starts three local services:

| Service | URL | Purpose |
| --- | --- | --- |
| Frontend | `http://127.0.0.1:8080` | dashboard UI |
| Local Node API | `http://127.0.0.1:3004` | AI chat, duplicate search, transcription |
| Analytics API | `http://127.0.0.1:3003` | full-picture and analytics endpoints |

### 5. Verify Services

```powershell
$frontend = Invoke-WebRequest -Uri 'http://127.0.0.1:8080' -UseBasicParsing -TimeoutSec 5
$localApi = Invoke-WebRequest -Uri 'http://127.0.0.1:3004/health' -UseBasicParsing -TimeoutSec 5
$analytics = Invoke-WebRequest -Uri 'http://127.0.0.1:3003/health' -UseBasicParsing -TimeoutSec 5
"FRONTEND $($frontend.StatusCode)"
"LOCALAPI $($localApi.StatusCode) $($localApi.Content)"
"ANALYTICS $($analytics.StatusCode) $($analytics.Content)"
```

## Data Setup

The app can start without private data, but real dashboard content requires a compatible local SQLite source database.

Default paths:

| Purpose | Path |
| --- | --- |
| Source DB | `database/source/qgate_raw.db` |
| Hot dashboard DB | `database/hot/vizion_serving.db` |
| Cold archive | `database/cold/` |

### Use An Existing SQLite Source

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli stage-full-picture-source --db-path C:\path\to\qgate_raw.db
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-full-picture-outcomes
```

### Pull Data From Octane

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-octane-cookie --headless
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-all-sources --teams "DTSV_China" --years 2026 --manual-years 2026 --team-name DTSV_China
```

For multiple teams or years:

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-all-sources --teams "DTSV_China,[AT]CoC_EI_IuK" --years 2025,2026 --manual-years 2026 --team-name DTSV_China
```

### Optional Data Overrides

Use explicit overrides only when you intentionally want paths outside the default repository layout:

```powershell
$env:VIZION_DATABASE_ROOT = "C:\path\to\database-root"
$env:VIZION_FULL_PICTURE_SOURCE_DB_PATH = "C:\path\to\qgate_raw.db"
$env:VIZION_FULL_PICTURE_HOT_DB_PATH = "C:\path\to\vizion_serving.db"
$env:DUPSEARCH_SQLITE_PATH = "C:\path\to\qgate_raw.db"
```

## Credentials

Secrets are local runtime inputs. Do not commit them.

### Octane

Default Octane values:

| Setting | Default |
| --- | --- |
| Base URL | `https://octane-prod.bmwgroup.net` |
| Shared space ID | `1002` |
| Workspace ID | `2001` |
| Cookie file | `cookie.txt` |

Optional overrides:

```powershell
$env:VIZION_OCTANE_BASE_URL = "https://octane-prod.bmwgroup.net"
$env:VIZION_OCTANE_SHARED_SPACE_ID = "1002"
$env:VIZION_OCTANE_WORKSPACE_ID = "2001"
$env:VIZION_OCTANE_COOKIE_FILE = "C:\path\to\cookie.txt"
```

### AI Model Access

Company model endpoint access:

```powershell
$env:DUPSEARCH_CHAT_ACCESS_CODE = "<company-access-code>"
```

OpenAI-compatible fallback style:

```powershell
$env:DUPSEARCH_CHAT_API_KEY = "<api-key>"
$env:DUPSEARCH_CHAT_API_BASE = "https://api.deepseek.com/v1"
```

Default model order:

- `deepseek-v4-pro`
- `qwen3.5-397b-a17b`
- `glm-5`

## Governed Agent Deployment

The dashboard can run locally with its trusted internal principal. A shared or production deployment must use OIDC and keep the analytics service private.

### Authentication Modes

| Mode | Intended use | Behavior |
| --- | --- | --- |
| `internal` | local development or a trusted single-user machine | server-owned internal principal from `VIZION_INTERNAL_*` settings |
| `oidc` | shared, LAN, or production deployment | default; fails closed unless a valid bearer token and server-owned scope policy resolve an actor |

Set the mode explicitly in local deployment configuration:

```powershell
$env:VIZION_AGENT_AUTH_MODE = "oidc"
$env:VIZION_OIDC_ISSUER = "https://issuer.example.com"
$env:VIZION_OIDC_AUDIENCE = "vizion-lab"
$env:VIZION_OIDC_JWKS_URI = "https://issuer.example.com/.well-known/jwks.json"
```

`VIZION_OIDC_ISSUER` and `VIZION_OIDC_JWKS_URI` must use HTTPS. The browser sends its current Supabase/OIDC session token only in the `Authorization: Bearer` header for AI Chat; identity and scopes in the JSON request body are ignored.

Map verified subjects/groups to complete server-owned grants with `VIZION_AGENT_OIDC_SCOPE_POLICY_JSON`. A grant must include non-empty `allowedObjectTypes`; a user matching multiple different grants is denied rather than receiving a field-wise union.

```json
{
  "groups": {
    "dtsv-readers": {
      "allowedObjectTypes": ["quality.defect"],
      "teamIds": ["DTSV_China"],
      "projectIds": ["IDCEVO"]
    },
    "agent-operators": {
      "allowedObjectTypes": ["quality.defect"],
      "teamIds": ["DTSV_China"],
      "projectIds": ["IDCEVO"],
      "rowPolicyIds": ["agent.operations.read"]
    }
  }
}
```

### Actor Capability and Network Boundary

The Node agent signs short-lived actor capabilities for agent-only analytics routes with `VIZION_AGENT_ACTOR_CAPABILITY_SECRET`. This secret is server-to-server only: do not expose it through Vite variables, browser storage, audit logs, or model prompts.

Rotate the capability secret with a coordinated maintenance window:

1. Stop new AI Chat traffic at the reverse proxy.
2. Replace the secret in both Node and FastAPI service environments.
3. Restart both services together.
4. Restore traffic and run the qualification commands below.

The current verifier accepts one secret at a time, so rolling one service before the other intentionally causes agent-only queries to fail closed. Keep FastAPI port `3003` bound to loopback or a private network; do not expose it directly to browsers. Place the Node API behind the authenticated reverse-proxy boundary for shared deployments.

Duplicate search and the legacy allowlisted fallback query do not yet have row-scope enforcement. They are available only in `internal` mode; scoped OIDC actors receive a safe denial from the associated tools and `/api/ai/context` or `/api/duplicate-search*` routes. Do not re-enable them for OIDC users until their backend retrieval path enforces the same actor scope contract.

### Runtime Ontology Governance

Compiled business rules in `ontology/v1/business_rules.json` are executable in both the Node planner and the Python semantic API:

- `deny` returns a safe policy rejection and never creates tool steps.
- `require` turns an unmet governed semantic into a clarification/rejection before a data provider runs.
- `derive` can add only an approved static policy filter; it narrows results and never broadens actor scope.
- `plan_warning` remains informational only.

The approved created-defect rule requires `time.defect_creation_date` whenever a created-defect query references event time. Matching rule codes are retained in the QueryPlan, governed context, semantic API response, and sanitized runtime summary. Semantic trace results also include an approved AIDA-to-TestCase-to-TestRun-to-Defect relationship path with cardinality/join policy, source revision, and row-index evidence; the Traceability dashboard exposes approved relationship IDs on graph edges.

After changing ontology source, regenerate and validate the bundle before starting services:

```powershell
npm run ontology:compile
npm run ontology:check
npm run test:ontology
```

### Bounded Recovery and Quality Gates

Agent recovery never generates SQL, code, or a broader scope. A failed read is retried only once in either of these cases:

- The scoped empty-result diagnosis verifies a `FILTER_VALUE_ALIAS` and changes only the same `detected_by` filter value.
- A semantic schema or draft-metric failure has exactly one valid, same-scope canonical step in the governed QueryPlan.

Each recovery audit stores the original and revised query fingerprints, source tool call, applicable source plan, reason, and outcome. Filter relaxation, ambiguous catalog matches, policy denials, sensitivity denials, and multiple matching plan steps are never retried automatically.

Semantic quality checks reject unsupported trace joins and unbounded many-to-many paths before source reads. Source freshness warnings, including `SOURCE_STALE`, appear in semantic tool context. The answer stream is instructed not to turn observational analytics into causality; cited unsupported causal claims emit `ANSWER_CAUSAL_CLAIM_UNSUPPORTED` in the answer-validation event.

### Qualification Baseline

The following non-production qualification was recorded on 2026-08-04 after two consecutive clean runs:

| Check | Run 1 | Run 2 |
| --- | ---: | ---: |
| Agent scorecard | 6 files / 13 tests passed | 6 files / 13 tests passed |
| Golden fixture cases | 134 defined cases | 134 defined cases |
| P0 integrated Node suite | 18 files / 200 tests passed | 18 files / 200 tests passed |
| Python capability/scope suite | 99 passed | 99 passed |
| Production build | passed | passed |

The 134 fixture cases comprise 12 routing, 113 semantic, 3 execution, and 6 policy scenarios. The synthetic non-production operations snapshot used for the qualification reported 2 completed runs, 1 correctly denied run, P50 `200 ms`, P95 `300 ms`, 2 citation passes, 1 citation block, and 1 bounded recovery. Those latency values validate aggregation only; they are not a production latency SLO.

Repeat the full qualification twice after any OIDC policy, actor-capability, agent route, tool recovery, Ontology, or model-streaming change.

### Operations Audit and Retention

LangGraph writes append-only runtime artifacts below `logs/agent-runtime/` by default:

- `run-summaries.jsonl`: normalized summary records
- `run-events.jsonl`: lifecycle and stream-completion events
- `tool-calls.jsonl`: tool audit records
- `threads/`: checkpoints

The Agent Operations page requires the server-resolved `agent.operations.read` row policy. Its API returns opaque run references and sanitized timeline fields only. Raw audit files still require filesystem access control because they are operational logs. Configure external retention and backup jobs; a recommended starting policy is 30 days for raw events/tool audits, 90 days for summaries, and no backup of thread checkpoints unless an approved incident process requires it.

### Emergency Rollback

To preserve dashboard read-only access during an agent incident, block `/api/ai/chat`, `/api/chat`, and `/api/agent-operations/*` at the reverse proxy or stop the Node API on port `3004`. The React dashboard's analytics routes continue to use the FastAPI service on port `3003`. Restore agent traffic only after the failed qualification check has been corrected.

## Commands

### Development

```powershell
npm run dev
npm run dev:client
npm run dev:server
npm run dev:analytics
```

### Tests

```powershell
npm test
.\.venv\Scripts\python.exe -m pytest backend\tests -q
```

Agent qualification scorecard:

```powershell
npm run test:agent-evals
```

Focused runtime-isolation checks:

```powershell
npm test -- src/test/server/projectIsolation.test.ts src/test/server/companyChat.test.ts
.\.venv\Scripts\python.exe -m pytest backend\tests\test_octane_auth.py backend\tests\test_analytics_outcomes.py backend\tests\test_asset_loader.py backend\tests\test_analytics_cli_smoke.py -q
```

### QGate KPI Reports

```powershell
npm run report:qgate-kpi
```

Equivalent Python command:

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli generate-qgate-kpi-reports
```

Custom output or compare years:

```powershell
npm run report:qgate-kpi -- --output-root docs/qgate-reports/custom_runs
npm run report:qgate-kpi -- --years 2024,2025
```

Default output:

- `docs/qgate-reports/generated_runs/<timestamp>/`

### Source Refresh

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-all-sources --teams "DTSV_China" --years 2026 --manual-years 2026 --team-name DTSV_China
```

Useful smaller refresh commands:

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-octane-source --teams "DTSV_China" --years 2026
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-manual-runs-source --team-name DTSV_China --years 2026
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-full-picture-outcomes
```

### Duplicate Search Evaluation

Export confirmed duplicate-search feedback into an eval-case file:

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli export-duplicate-search-eval-cases --feedback-db-path .\backend\database\duplicate_feedback.db --output-path .\docs\duplicate-search-eval-cases.generated.json
```

Run the offline duplicate-search evaluation:

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli evaluate-duplicate-search --eval-cases .\docs\duplicate-search-eval-cases.generated.json --top-k 10
```

### Nightly Refresh On Windows

Manual run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nightly-source-refresh.ps1
```

Nightly refresh includes Octane comments by default. Comment loading is incremental: unchanged defects reuse cached comments, and only changed or missing comment snapshots are refreshed. Use `-CommentMode skip` only when you intentionally need a faster defect/history-only refresh.

Register scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-nightly-source-refresh-task.ps1
```

The registered task also passes `-PrepareDuplicateIndex 1`, so duplicate search can use the prepared index manifest after the nightly data refresh.

Logs are written under:

- `database/hot/logs/`

## Repository Layout

```text
backend/                 Python analytics, ingest, reports, duplicate search
backend/analytics/       FastAPI service, SQLite processing, report builders
server/                  Local Node API for AI chat and duplicate bridge runtime
scripts/                 Dev startup and Windows refresh helpers
src/                     React dashboard application and tests
database/                Local source/hot/cold data area
docs/qgate-reports/      Generated static KPI reports
supabase/                Supabase config and edge-function placeholders
```

## Runtime Isolation

Default runtime does not require:

- A sibling `TPMDashboard` or `TPMDashbaord` repository
- `lovable-agent-playwright-config`
- Hard-coded user Desktop paths
- A separate `dupsearch-agent` project

External data and credentials can still be provided through explicit environment variables, but the app does not silently search a sibling local repository.

## Before Pushing To GitHub

Check the worktree:

```powershell
git status --short
```

Avoid committing local or private artifacts:

- `.venv/`
- `node_modules/`
- `__pycache__/`
- `.pytest_cache/`
- `cookie.txt`
- `login_info.txt`
- `.env` with real secrets
- `database/**/*.db`
- `database/**/*.db-wal`
- `database/**/*.db-shm`
- generated reports unless intentionally shared

## Troubleshooting

### Node Version Error

```powershell
nvm use 24.14.0
```

### Python Install Fails Behind Proxy

Use the same terminal/proxy setup normally used for Python package installation, then rerun:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### Dashboard Opens But Has No Data

Stage or refresh `database/source/qgate_raw.db`, then run:

```powershell
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-full-picture-outcomes
```

### AI Chat Has No Model Response

Set `DUPSEARCH_CHAT_ACCESS_CODE`, or set `DUPSEARCH_CHAT_API_KEY` and `DUPSEARCH_CHAT_API_BASE`, before starting `npm run dev`.

### Cookie Refresh Fails

```powershell
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe -m backend.analytics_cli refresh-octane-cookie --headless
```
