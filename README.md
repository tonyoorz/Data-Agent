# Vizion Lab

当前仓库现在同时包含：

- Vite 前端
- 本地 Node API
- 内嵌 duplicate search Python 检索后端

老师或演示环境不需要再额外启动 `dupsearch-agent` 项目。直接启动当前仓库即可。

## Run

### 1. Python dependencies

建议在仓库根目录准备 Python 3.9+ 虚拟环境，并安装：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

如果不使用仓库内 `.venv`，请设置：

```powershell
$env:DUPSEARCH_AGENT_PYTHON = "C:\path\to\python.exe"
```

或：

```powershell
$env:VIZION_ANALYTICS_PYTHON = "C:\path\to\python.exe"
```

### 2. Duplicate search data source

二选一：

默认情况下，当前仓库会优先自动查找这些路径中的 SQLite：

- `./database/source/qgate_raw.db`
- 当前仓库下的 `qgate/qgate_data.db`
- `../TPMDashbaord/qgate/qgate_data.db`
- `../TPMDashboard/qgate/qgate_data.db`

如果你已经执行过本地 stage：

```powershell
python -m backend.analytics_cli stage-full-picture-source --db-path ..\TPMDashbaord\qgate\qgate_data.db
```

那么 duplicate search 和 AI context 也会默认优先走 `./database/source/qgate_raw.db`。

如果你的环境和上面不同，再手动指定：

```powershell
$env:DUPSEARCH_SQLITE_PATH = "C:\path\to\local_data_rebuilt.db"
```

或：

```powershell
$env:DUPSEARCH_DATA_DIR = "C:\path\to\defect"
```

目录内需要包含：

- `2025_defect.json`
- `2026_defect.json`

### 2.1 Main Dashboard analytics data source

`Main Dashboard` 的本地 analytics API 会优先自动查找这些 SQLite：

- `./database/source/qgate_raw.db`
- `./qgate/qgate_data.db`
- `./backend/database/octane_data.db`
- `../TPMDashbaord/qgate/qgate_data.db`
- `../TPMDashboard/qgate/qgate_data.db`

如果你的环境不同，可以手动指定：

```powershell
$env:VIZION_FULL_PICTURE_SOURCE_DB_PATH = "C:\path\to\qgate_data.db"
$env:VIZION_FULL_PICTURE_DEFECT_DB_PATH = "C:\path\to\qgate_data.db"
$env:VIZION_FULL_PICTURE_HISTORY_DB_PATH = "C:\path\to\qgate_data.db"
```

如果你想先把 sibling TPMDashboard 的 qgate SQLite stage 一份到当前仓库，再让 Full Picture 默认优先走本地 source copy：

```powershell
python -m backend.analytics_cli stage-full-picture-source --db-path ..\TPMDashbaord\qgate\qgate_data.db
python -m backend.analytics_cli refresh-full-picture-outcomes
```

默认本地布局是：

- `./database/source/qgate_raw.db`
- `./database/hot/vizion_serving.db`
- `./database/cold/`

如果你想把本地 source copy 再导出成 cold archive（DuckDB + Parquet），可以执行：

```powershell
python -m backend.analytics_cli archive-full-picture-cold
```

默认输出会写到：

- `./database/cold/qgate_archive.duckdb`
- `./database/cold/parquet/*.parquet`

这一步是离线归档，不会改变当前 runtime API 的读路径。

如果你要使用仓库内的本地 analytics SQLite，也可以先初始化 schema：

```powershell
python -m backend.analytics_cli init-db
```

如果只是为了本地验证 `/api/testing/*` 等 analytics 接口，也可以写入一份最小示例数据：

```powershell
python -m backend.analytics_cli init-db
python -m backend.analytics_cli seed-testing
```

如果你已经有 qgate defect SQLite，并且想按现有 post-download sync 思路回填 `project/tproject`，可以先做 dry-run：

```powershell
python -m backend.analytics_cli backfill-projects --db-path ..\TPMDashbaord\qgate\qgate_data.db
```

确认统计结果后再真正写回数据库：

```powershell
python -m backend.analytics_cli backfill-projects --db-path ..\TPMDashbaord\qgate\qgate_data.db --apply
```

这条命令只会处理当前为 `Unknown` 或空值的 defect `project`。`project/tproject` 是 processor 计算后的业务维度，不是直接读取某一个 Octane 原始字段；前端 `project` 筛选也是基于这个持久化后的结果。

当前 `project` 的保守回填优先级是：

1. 保留已有的非 `Unknown` `project`
2. 用 `top_aida` / `product_areas` / `solution_cluster` 做少量精确映射：
   - `Use Rear Seat Entertainment [01.04.01.09.02]` -> `RSU`
   - `Provide Navigation 2.0 [01.04.03.01.03.06]` -> `IDCEVO`
   - `Use Speech operation [01.04.02.01.01.05]` -> `IDCEVO`
   - `Navigation Asia` -> `MGU`
3. 用 `assigned_ecu` 做明确设备信号映射：
   - `IPN-15`、`IDCEVO`、`CDE-01`、`ICON-25`、`BMTH-01`、`IPN-10`、`IPN-10_DE`、`SD-AMAP` -> `IDCEVO`
   - `HU-MGU_02_A`、`IDC23` -> `IDC`
   - `UCAP-10`、`HU-MGU_02_L`、`HU-MGU_01`、`SP_NAVINFO`、`BMT` -> `MGU`
   - `RSE` / `RSU` -> `RSU`
   - `APP` / `MOBILE` / `MY BMW` / `ANDROID` / `IOS` / `HARMONYOS` -> `App`
4. 用 `software_version` 做显式 token 映射，只接受保守 token：
   - `IDCEVO` 或 `CDE` -> `IDCEVO`
   - `IDC23` -> `IDC`
   - `MGU22` -> `MGU`
   - `RSE26` -> `RSU`
   - `MOBILE` / `ANDROID` / `IOS` / `HARMONYOS` -> `App`
5. 用少量组件/责任人组合做保守兜底：
   - `G78` + `ecu_to_modul in {CC, KH}` -> `MGU`
   - `G70` + `ecu_to_modul == FH` -> `IDCEVO`
   - `G68` + `ecu_to_modul in {CC, FH}` -> `MGU`
   - `G70` + `function_responsible in {RAINER FUNKE, MARIJKE BRINKMANN}` -> `IDCEVO`
6. 最后才用少量 `lead_model` 做保守映射：
   - `U11` / `U12` -> `IDC`
   - `G50` / `G58` / `NA5` / `NA6` / `NA8` -> `IDCEVO`
   - `G18` / `G28` -> `MGU`
7. 仍然无法稳定判断的记录保持 `Unknown`

补充说明：`function2modul` 和 `model_series` 现在已经会被下载并落库，但当前不会直接拿来映射 `project`，因为它们在真实库里的分布仍然跨多个项目，更适合作为分析维度，而不是直接作为筛选归类规则。

### 3. Company model credentials

至少配置其一：

```powershell
$env:DUPSEARCH_CHAT_ACCESS_CODE = "<company-access-code>"
```

或：

```powershell
$env:DUPSEARCH_CHAT_API_KEY = "<api-key>"
$env:DUPSEARCH_CHAT_API_BASE = "https://api.deepseek.com/v1"
```

默认前端模型顺序：

- `deepseek-v4-pro`
- `qwen3.5-397b-a17b`
- `glm-5`

### 4. Start

```powershell
npm run dev
```

这个命令会同时启动：

- Vite 前端：`http://127.0.0.1:8080`
- 当前仓库自己的本地 analytics API：`http://127.0.0.1:3003`，负责 `/api/full-picture/*`
- 当前仓库自己的本地 API：`http://127.0.0.1:3004`，负责 `/api/ai/*`、`/api/chat`、`/api/duplicate-*`

## AI Chat integration

`AI Chat` 页面现在支持两种模式：

- `AI Chat`：走当前仓库本地 `/api/ai/chat`，并在后端自动从 qgate defect 数据中检索相关上下文后再调用公司模型
- `Duplicate Search`：走当前仓库本地 `/api/duplicate-search`，并可提交 `/api/duplicate-feedback`

新增的本地 AI 接口：

- `/api/ai/context`：根据最近一条用户问题，从 qgate defect 数据库返回相关缺陷上下文
- `/api/ai/chat`：在附加 qgate defect 上下文后调用公司模型，返回 SSE 流式响应

## Notes

- duplicate search Python 后端来自当前仓库内嵌实现，不再依赖单独的前端项目
- Main Dashboard 现有 `/api/full-picture` 代理保持不变，但现在默认优先走当前仓库内的 `3003` analytics 服务
