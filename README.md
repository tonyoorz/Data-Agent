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

### Nightly Refresh On Windows

Manual run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nightly-source-refresh.ps1
```

Register scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-nightly-source-refresh-task.ps1
```

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
