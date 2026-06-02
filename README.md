# Vizion Lab

当前仓库现在同时包含：

- Vite 前端
- 本地 Node API
- 内嵌 duplicate search Python 检索后端

老师或演示环境不需要再额外启动 `dupsearch-agent` 项目。直接启动当前仓库即可。

## Run

### 0. Node version

仓库当前固定使用 Node 24，推荐版本是 `24.14.0`。

```powershell
nvm use 24.14.0
```

仓库根目录提供了 `.nvmrc`，同时 `npm run dev`、`npm run build`、`npm test` 等入口会在 Node 主版本不是 24 时直接失败，避免再落到 Vite/Vitest 的隐式兼容问题。

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

### 2.2 Manual source update workflow

如果你要在当前仓库手动更新缺陷、history、manual runs，并且保持现在 `database/source/qgate_raw.db` 的表结构不变，推荐直接复制下面的命令执行。

下面的示例按当前 Windows PowerShell 环境写，统一使用 `py -3.11`。

最常用的一键串行刷新：

如果你希望直接运行仓库里的现成脚本，可以执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nightly-source-refresh.ps1
```

这个脚本内部实际调用的就是下面这条总命令；手动排查时也可以直接运行命令行版本：

```powershell
py -3.11 -m backend.analytics_cli refresh-all-sources --teams "DTSV_China,[AT]CoC_EI_IuK,Plant-Tiexi FIT,[AT]FIT_LAENDER_CHINA,Plant-Dadong FIT,[AT]BBA_Basis-FIT,Spotlight_FIT" --years 2025,2026 --team-name DTSV_China --history-max-workers 50
```

如果你想分步骤手动跑，就按下面顺序执行。

先确认 Octane cookie 可用；如果已经过期，先刷新：

```powershell
py -3.11 -m backend.analytics_cli refresh-octane-cookie
```

然后执行 QGate defect + history 手动更新。这个命令默认就是增量模式：

- defect：按 `problem_finder_team + creation year + last_modified` 增量筛 changed/new defects
- comments：只补本次命中的 defects
- history：只补缺失 history，或者 `last_modified` 晚于上次 history 抓取时间的 defects
- 运行时会直接显示 legacy downloader 的进度条
- 每个命中的 defect 仍然按完整 payload upsert，不会只写部分字段

```powershell
py -3.11 -m backend.analytics_cli refresh-legacy-qgate-source --teams "DTSV_China,[AT]CoC_EI_IuK,Plant-Tiexi FIT,[AT]FIT_LAENDER_CHINA,Plant-Dadong FIT,[AT]BBA_Basis-FIT,Spotlight_FIT" --years 2025,2026 --history-max-workers 50
```

如果你明确要重新做 defect + full history，而不是默认增量，可以额外带上：

```powershell
py -3.11 -m backend.analytics_cli refresh-legacy-qgate-source --teams "DTSV_China,[AT]CoC_EI_IuK,Plant-Tiexi FIT,[AT]FIT_LAENDER_CHINA,Plant-Dadong FIT,[AT]BBA_Basis-FIT,Spotlight_FIT" --years 2025,2026 --full-history --history-max-workers 50
```

然后更新 manual runs。当前仓库这条链路先只处理 `DTSV_China`，并且只 upsert `octane_manual_runs`，不会重建 `octane_testcases` / `octane_testcase_relations`：

```powershell
py -3.11 -m backend.analytics_cli refresh-manual-runs-source --team-name DTSV_China --years 2025,2026
```

这条命令默认也是增量模式：

- 只抓指定 release year 下 `last_modified` 晚于本地水位的 manual runs
- 自动回退 3 天 overlap，降低边界漏数风险
- 命令结束后会自动跑一遍 processor，补齐 `project` / `fv` / `fvp` / `test_week` / `tester` 等维度

最后刷新 hot outcomes，让 dashboard / AI 直接看到最新 source 结果：

```powershell
py -3.11 -m backend.analytics_cli refresh-full-picture-outcomes
```

如果你只是想一键顺序跑完 defect/history、manual runs、outcomes，也可以直接用总命令：

```powershell
py -3.11 -m backend.analytics_cli refresh-all-sources --teams "DTSV_China,[AT]CoC_EI_IuK,Plant-Tiexi FIT,[AT]FIT_LAENDER_CHINA,Plant-Dadong FIT,[AT]BBA_Basis-FIT,Spotlight_FIT" --years 2025,2026 --team-name DTSV_China --history-max-workers 50
```

这条总命令会在终端里按步骤打印当前阶段，方便判断现在是在拉 defect/history、manual runs，还是在刷新 hot outcomes。

补充说明：

- `refresh-legacy-qgate-source` 现在的 defect 增量不是“只更新几个字段”，而是“增量筛对象，全量写对象”，所以新 ticket 会被发现，变更 ticket 也会被完整覆盖写回。
- `refresh-manual-runs-source` 当前故意不碰 testcase relation 链路；等测试数据流程稳定后，再把 testcase / relation 更新并回这条手动链路。
- 同一时间不要并发跑两个 source writer，避免 SQLite 写冲突。

### 2.3 Nightly scheduled refresh

如果你想把当前一键增量刷新做成 Windows 每天凌晨 1 点自动执行，仓库里已经提供了注册脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-nightly-source-refresh-task.ps1
```

这条命令默认会注册一个 `VizionLab Nightly Source Refresh` 计划任务，每天 `01:00` 执行 `scripts\run-nightly-source-refresh.ps1`。

如果你想改时间或任务名，可以带参数：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-nightly-source-refresh-task.ps1 -StartTime 01:30 -TaskName "VizionLab Full Picture Refresh"
```

默认运行日志会写到 `database\hot\logs\nightly-source-refresh.log`，方便回看每天的抓取结果。

说明：

- 计划任务脚本调用的仍然是 `refresh-all-sources`，所以 defect/history、manual runs、hot outcomes 会按现有顺序串行执行。
- 页头右上角 `数据已同步` 读取的是 dashboard snapshot 的 `lastSuccessAt`；定时刷新产出新 snapshot 后，页面重新加载就会显示最新时间。
- 现在前端时间戳会自动截断到秒，只显示到 `YYYY-MM-DD HH:MM:SS`，不再显示微秒和时区尾巴。

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
