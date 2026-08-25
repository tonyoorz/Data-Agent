# 统一集成决策日志（Decision Log）

> 任务：将 codex harness、智能问数项目（Data-Agent / Vizion Lab）、pi 方法整合为统一系统。
> 模式：无人值守自主循环。所有歧义按"证据优先 + 最小侵入 + 仓库内自洽"原则自行决策，决策与理由全部记录于本文件。
> 日志时间均为本地时间（Asia/Shanghai）。

---

## D1 · "codex harness" 的解释与集成边界

**决策**：将 "codex harness" 解释为本仓库已有的 **Codex-Style Agent Harness** 架构（`docs/superpowers/plans/2026-07-28-codex-style-agent-harness-refactor.md`），即：
- `server/mainAgentToolRegistry.mjs` —— 工具元数据 / 意图画像 / 策略提示的唯一事实源；
- `server/mainAgentToolOrchestrator.mjs` —— 模型规划的工具执行、allow-policy 校验、证据捕获、空结果诊断、标准 turn 事件（`agent.turn.started` → `agent.tool.planned/started/completed` → `agent.turn.completed`）；
- `server/agentRuntime/langGraphChatRuntime.mjs` —— 唯一生产 runtime（LangGraph StateGraph）。

**理由**：用户表述"将 codex harness 与我的智能问数项目整合"，且仓库中存在 17 个 `codex/*` 分支与该已完成的重构方案文档；方案文档明确将该架构称为 "Codex-inspired harness boundary"。仓库内证据充分，无需引入外部 codex 仓库（也符合"改动严格限定于当前本地仓库"的约束——不 clone、不引用任何外部仓库）。

**集成含义**：统一系统以该 harness 为**执行骨架**（execution backbone），所有智能问数能力通过 registry 注册的工具经 orchestrator 执行，事件流与证据链由 orchestrator 统一产出。

---

## D2 · "pi 方法" 的解释与集成边界

**决策**：将 "pi 方法" 解释为本仓库的 **PI Coding-Agent 本体治理方法**（`docs/superpowers/plans/2026-07-23-ontology-pi-coding-agent-refactor.md` + `docs/ontology/pi-coding-agent-playbook.md`），其核心是：
- 分层导入顺序：版本化本体 bundle + 校验器 → Python 语义查询数据面 → Node agent 工具集成 → 可选 graph runtime；
- fail-closed：本体指纹（SHA-256）校验失败即拒绝启动语义面；
- playbook 驱动：业务概念改动必须先改 `ontology/v1/*`，语义行为改动必须同时更新 Node 与 Python 两侧测试。

**理由**：这是仓库内唯一以 "pi" 命名的方法论文档，且用户说"你之前提到的 pi 方法"——该方案正是在本仓库规划并已部分落地的。

**集成含义**：统一系统以 pi 方法为**语义治理层**（governed semantic kernel）：`server/ontology/*`（Node kernel）+ `backend/analytics/ontology.py / semantic_query.py / semantic_runtime.py`（Python 数据面）+ `ontology/generated/*`（编译产物与能力发布）。智能问数的一切取数必须经过本体语义契约（semantic frame → query plan → /api/semantic/query），不允许 harness 直连 SQL。

---

## D3 · Node 运行时策略（环境差异处理）

**决策**：所有验证命令统一使用 `/opt/homebrew/opt/node@24/bin`（node 24.19.0）前置 PATH 执行，不修改系统默认 node（v22）、不安装新软件。

**理由**：仓库 `scripts/nodeVersion.mjs` 强制 Node major 24（`pretest`/`prestart` 钩子断言）；本机默认 node 为 22，但 Homebrew 已安装 `node@24 24.19.0`。PATH 前置是无侵入、可逆的隔离手段，满足"不影响仓库外环境"。

---

## D4 · Python 运行时与依赖策略（依赖冲突处理）

**决策**：以 `/opt/anaconda3/bin/python3`（3.12.7）创建 `.venv --system-site-packages`，复用 anaconda 已装依赖（fastapi 0.116.1 / pandas 2.2.3 / duckdb 1.2.1 / uvicorn / pytest / httpx / scikit-learn 均已满足 requirements.txt 下限）。不额外安装重依赖（sentence-transformers/torch、rapidocr/onnxruntime、playwright 浏览器）。

**理由**：`scripts/pythonRuntime.mjs` 强制要求仓库根 `.venv/bin/python`（或显式 `VIZION_ANALYTICS_PYTHON` 绝对路径）且必须能 import `duckdb,fastapi,pandas,uvicorn`；语义链路（本集成的验证对象）不依赖向量检索与 OCR/ASR 重依赖。全量安装需数 GB 网络下载，无人值守模式下风险高、收益为零。重依赖缺失的影响记入遗留问题清单。

---

## D5 · 先完成搁置中的 git 合并（前置修复）

**决策**：工作区存在未完成合并（`feature/2026-08-13-guardrails-scorecard-sync` → `feature/2026-08-13-testcase-bridge-ui`，5 个冲突文件）。**先解决冲突并提交合并**，再开始集成开发。逐文件策略：
- `.gitignore`：取双方并集（双方都是新增忽略规则，无语义冲突）；
- `README.md`：保留 HEAD 侧（HEAD 的模型列表与 Speech Transcription 章节为更新、更全内容；incoming 侧为旧模型列表的子集）；
- `docs/ontology/langgraph-agent-runtime.md`：取双方并集（HEAD 的 Semantic Candidate Budget + 内部部署主账号细节，与 incoming 的 OIDC 认证章节互补）；
- `ontology/generated/fingerprint.txt`：不手选，**以 `npm run ontology:check/compile` 对合并后本体源重新生成**（指纹必须由编译器确定性产出，保证 fail-closed 校验自洽）；
- `backend/analytics/semantic_query.py`：工作区已无冲突标记，以 Python 语义测试通过为准后 `git add`。

**理由**：统一集成必须建立在干净、一致的工作树上；合并任一侧都可能丢失另一侧已验证的功能（incoming 侧含 scorecard/eval CI、semantic_runtime 等新能力，HEAD 侧含语音转写与模型更新）。

---

## D6 · 统一集成层的形态：组合式门面（facade），不新造并行 runtime

**决策**：新建 `server/unifiedDataAgentSystem.mjs` 作为**统一系统的程序化入口**（composition root），只做三件事：
1. **装配**：把 codex harness 的 orchestrator、pi 方法的 ontology kernel、智能问数数据面（semantic API executor）注入同一依赖容器；
2. **契约**：暴露 `getUnifiedSystemSnapshot()`（各层版本/指纹/能力计数/工具清单的统一快照）与 `runUnifiedDataAgentTurn()`（依赖注入的端到端入口，默认接 orchestrator）；
3. **fail-closed**：任一层指纹/契约校验失败时返回带错误码的快照，绝不静默降级。

**不做**的事：不新建第二个工具循环、不绕过 registry 直接调工具、不在 Node 侧复刻 Python 数据面。

**理由**：orchestrator 的 `runMainAgentToolTurn` 与 `executeMainAgentToolCall` 本就支持依赖注入（`requestToolCompletion`/`executeToolCall`/`toolDependencies`），组合式门面是零重写的集成方式，也符合两份方案文档"one orchestrator, one runtime"的原则。

---

## D7 · 集成验证方式：三层自动化验证 + 一个总入口脚本

**决策**：验证分三层，全部可离线（不依赖真实公司模型 endpoint）：
1. **单元/契约层**（vitest）：`src/test/server/unifiedDataAgentSystem.test.ts` 验证门面装配、快照契约、fail-closed 行为；
2. **端到端链路层**（vitest，stub LLM + 真实 Python 数据面）：用户问题 → orchestrator turn → `query_semantic_metrics` → 真实 `/api/semantic/query`（FastAPI TestClient / 内存库）→ 证据事件回流；
3. **总验证脚本**：`scripts/verifyIntegration.mjs` 输出逐项核对表（JSON + 控制台），结果落盘 `outputs/integration-verification/`。

**理由**：GOAL 文件要求"验证全绿才提交"；golden evals 已覆盖路由与语义质量，但缺一个把三层装配关系作为被测对象的集成套件。离线 stub LLM 是既有测试（`mainAgentToolOrchestrator.test.ts` 等）的既定模式。

---

## D8 · 文档与产物的落位

**决策**：集成文档统一放 `docs/integration/`：
- `unified-integration-architecture.md` —— 架构说明（调用关系 + 数据流转 + 目录结构）；
- `decision-log.md` —— 本文件；
- `integration-summary-report.md` —— 最终总结报告（含变更清单、验证结果、遗留问题）。
验证产物落 `outputs/integration-verification/`（该目录已在 .gitignore 的 outputs 相关约定之外需显式提交，作为"保留验证结果"的证据）。

**理由**：仓库文档惯例是 `docs/<主题>/`；验证结果必须"保留"，因此入库而非仅日志。

---

## D9 · 冲突解决的权威采纳：使用仓库内"未来调和版"而非手工逐块裁决

**决策**：解决搁置合并时发现，除 5 个带标记冲突文件外另有 19 个 UU 文件，且语义契约存在深层矛盾（HEAD 的宽维度白名单 vs incoming 的 runtime 发布校验 `ONTOLOGY_RUNTIME_DIMENSION_NOT_SUPPORTED`）。调查发现仓库本地分支 `codex/2026-08-18-agent-unified-release` **同时包含本次合并的两个父提交**，其合并提交 `2a1c5148`（2026-08-18 17:42）就是本次合并的已完成版本，其后继提交 `683eaeeb`（2026-08-18 21:40 "reconcile semantic and breaker contracts"）进一步调和了语义/熔断契约。裁决规则：
- 19 个 runtime 层 UU 文件 → 采纳 `2a1c5148` 版本；
- 语义契约四件套（`semantic_query.py`、`test_semantic_query_api.py`、`circuit_breaker.py`、`ingest/client.py`、`test_circuit_breaker.py`、semantic-execution golden）→ 采纳 `683eaeeb` 调和版（比 2a1c 更新且已验证）；
- `.gitignore`/`README`/`langgraph-agent-runtime.md` → 保留我方并集/HEAD 决议（内容为对方超集）；
- `mainAgentToolOrchestrator.mjs` → 采纳 `2a1c5148`（incoming 的并行工具扩展与全分支共享的串行恢复测试矛盾，测试为准）；
- checkpoint 依赖 → 以 MERGE_HEAD 配套为准（`@langchain/langgraph-checkpoint-sqlite3`，包名与 package.json 一致）；
- 未采纳 unified 分支 tip 的其余 3 个提交（testcase proposal、preproduction gates）——超出本次合并范围，不引入。

**理由**：无人值守模式下，手工逐块裁决 24 个冲突文件的语义正确性风险极高；仓库内存在同一合并的已验证完成版（后续提交与测试可佐证）时，采纳它是证据最强的选择。验证结果：810/810 vitest + 422 pytest + ontology:check 全绿。

---

## D10 · 实时端到端验证的数据策略：临时夹具库而非本机数据

**决策**：实时链路验证（V8）不依赖本机业务数据（本机 `backend/database/octane_data.db` 为 local-analytics 形态且 0 行，真实数据在用户 Windows 机器上），也绝不向仓库数据库写入测试数据。改为：`scripts/integration_fixture.py` 在系统临时目录构建 3 条 DTSV_China/IDCEVO 夹具缺陷的源库 → 用**生产物化管线** `refresh_materialized_outcomes` 生成热库 → 激活快照 → 通过 `VIZION_FULL_PICTURE_DEFECT_DB_PATH/_HOT_DB_PATH` 环境变量（仓库既有的数据隔离机制）指向临时库启动 FastAPI。

**理由**：既验证了真实读模型管线（而非 stub），又零污染。验证结果 `defect.count: 3` 从物化热库真实回流。

## D11 · 实时链路中发现并遵守的两道治理门

**决策**：V8 首跑失败两次，均为**治理层正确拒绝**而非缺陷：
1. `ACTOR_CAPABILITY_CONFIGURATION_INVALID` → 语义执行器要求 actor capability 签名依赖（HMAC，双端共享 `VIZION_AGENT_ACTOR_CAPABILITY_SECRET`）→ 统一门面补齐 `actorCapability*` 选项透传；
2. `SEMANTIC_POLICY_FILTER_REQUIRED:product.project` → 本体策略要求缺陷指标必须带项目过滤 → 验证查询补 `product.project in [IDCEVO]` 政策过滤器。

**理由**：这两道门正是"pi 方法"治理价值的实证——统一系统宁可拒绝也不放行未签名/未限定范围的查询。修复方向是补齐合规输入，绝不放宽校验。

## D12 · 验证命令的产品化：npm run verify:integration

**决策**：验证总入口注册为 `npm run verify:integration`（全量）与 `npm run verify:integration:quick`（跳过 V6/V7 全量回归），报告落盘 `outputs/integration-verification/`（含 `latest.json`）。

**理由**：GOAL 文件要求"eval-driven 闭环：每次改动自动回归"；把集成验证提升为一等命令，使后续任何触碰三层的改动都能一键复验集成完整性。

---

## D13 · 环境产物与集成证据的入库边界

**决策**：`.gitignore` 补充 `.venv/`（虚拟环境为机器本地产物）与 `backend/database/*.db-shm`、`*.db-wal`（SQLite 运行时 WAL 文件）；同时 `outputs/integration-verification/` **例外入库**（作为"保留验证结果"要求的证据）。提交范围严格限定为本次集成产物 + 前置合并修复；仓库中既有的其他未跟踪文件（`docs/research/2026-08-19-*`、`evals/scorecard/tasks/`、`scripts/gen_dtsv_scorecard.py` 等）不动不提交，待所有者处置。

**理由**：满足"改动严格限定于当前仓库"与"保留验证结果"的双重要求，同时避免替所有者处置来源不明的工作区文件。

---

*决策日志完（D1–D13）。*



