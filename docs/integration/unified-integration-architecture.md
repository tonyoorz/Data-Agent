# 统一集成架构：codex harness × 智能问数 × pi 方法

> 版本：v1.0 · 2026-08-25
> 状态：已实施并通过自动化验证（见 `outputs/integration-verification/latest.json`）
> 关联：`docs/superpowers/plans/2026-07-28-codex-style-agent-harness-refactor.md`（harness）、`docs/superpowers/plans/2026-07-23-ontology-pi-coding-agent-refactor.md` + `docs/ontology/pi-coding-agent-playbook.md`（pi 方法）、`智能问数Agent目标架构设计.md`（智能问数目标）

---

## 1. 三个组件与各自角色

| 组件 | 仓库内载体 | 在统一系统中的角色 |
| --- | --- | --- |
| **codex harness** | `server/mainAgentToolRegistry.mjs`、`server/mainAgentToolOrchestrator.mjs`、`server/agentRuntime/langGraphChatRuntime.mjs` | **执行骨架**：工具元数据唯一事实源、模型规划的工具执行循环、allow-policy 校验、标准 turn 事件（`agent.turn.*` / `agent.tool.*`）、证据捕获、空结果自愈 |
| **pi 方法**（PI coding-agent 本体治理） | `ontology/v1/*`、`scripts/compileOntology.mjs`、`server/ontology/*`、`backend/analytics/ontology.py`、`backend/analytics/semantic_query.py`、`backend/analytics/semantic_runtime.py`、`docs/ontology/pi-coding-agent-playbook.md` | **语义治理层**：版本化本体 + SHA-256 指纹 fail-closed 加载、指标/维度审批与 runtime 发布（runtime-ready vs approved-planned）、语义帧→查询计划→执行契約、playbook 规则约束编码代理行为 |
| **智能问数项目**（Data-Agent / Vizion Lab） | 整个仓库：React 前端、Node 网关 `server/index.mjs`（:3004）、FastAPI 分析服务 `backend/analytics/api.py`（:3003）、SQLite 源/热/冷数据层 | **业务系统与数据面**：中文自然语言问数的产品形态与受治理的取数执行 |

## 2. 调用关系与数据流转

```
用户（中文自然语言问数）
  │
  ▼
┌─────────────────────── L1 codex harness（执行骨架）───────────────────────┐
│ server/index.mjs (:3004) ── SSE ──▶ langGraphChatRuntime (LangGraph)      │
│   initialize → resolve_context → route_tools → plan_tool_calls            │
│   ⇄ execute_tool_calls → finalize                                        │
│ 每步经 mainAgentToolOrchestrator.runMainAgentToolTurn：                    │
│   ① selectMainAgentToolset（registry 意图画像，如 metric_query）           │
│   ② requestToolCompletion（LLM 规划工具调用，≤4 步）                       │
│   ③ validateToolCallAllowed（policy gate，含 OIDC/internal actor 边界）    │
│   ④ executeToolCall → 语义工具执行                                        │
│   ⑤ 标准 turn 事件 + 证据 + 空结果诊断（diagnose_analytics_empty）          │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │ query_semantic_metrics / _records /
                                    │ query_traceability（受治理语义工具）
                                    ▼
┌─────────────────────── L2 pi 语义治理层（唯一语义权威）────────────────────┐
│ Node 侧 kernel：server/ontology/registry（指纹校验 fail-closed）           │
│   → resolver（NL→语义帧 schema linking）→ queryPlanner（查询计划+指纹）     │
│   → queryCompiler（semanticQuerySchema 契约）→ scopePolicy（行级/敏感策略） │
│ 发布物：ontology/generated/{ontology.compiled.json, fingerprint.txt,       │
│        runtime-capabilities.json}（编译器确定性产出，双端共享）             │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │ POST /api/semantic/query
                                    │ （actor capability 签名头，HMAC-SHA256，
                                    │   secret=VIZION_AGENT_ACTOR_CAPABILITY_SECRET）
                                    ▼
┌─────────────────────── L3 智能问数数据面（FastAPI :3003）──────────────────┐
│ backend/analytics/api.py → semantic_query.execute_semantic_query          │
│   _validate_request（schema/指纹/actorScope/policy 过滤器强制）             │
│   → read_models.build_semantic_defect_payload（真实 SQLite 读模型）        │
│   → 证据封装（sourceRevision / quality / metrics / completeness）          │
│ 数据层：database/source（qgate_raw 源）→ refresh_materialized_outcomes      │
│        → database/hot（defect_outcomes 物化）→ cold（DuckDB/Parquet 归档）  │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │ JSON 契约响应（含本体版本/指纹/源修订号）
                                    ▼
                     orchestrator 组装 contextText + evidence
                                    │
                                    ▼
                     finalize → 答案 + 引用链 → 前端（证据卡片）
```

**数据流转关键约束**（不可绕过，由代码强制）：
1. harness 不直连 SQL——一切取数必须经语义工具 → `/api/semantic/query`；
2. 语义帧必须携带 `ontologyVersion + schemaFingerprint`，Python 端 fail-closed 校验；
3. actor scope（团队/项目/对象类型）在三层间以签名 capability 传递，Python 端独立验签；
4. 每个数据结论回流的 `sourceRevision + quality + metrics` 构成可程序化校验的引用链。

## 3. 统一系统入口（本次集成新增）

`server/unifiedDataAgentSystem.mjs` —— 组合根（composition root）：

| API | 用途 |
| --- | --- |
| `createUnifiedDataAgentSystem({root, registry?, analyticsApiBase?, analyticsFetch?, actor?, actorCapability*})` | 装配三层；registry 可注入、analyticsFetch 可替换（测试/影子模式） |
| `snapshot()` | 统一健康快照：三层状态 + 6 项跨层契约检查结果（`ok` 字段总判） |
| `validateIntegrationContracts()` | 单独取跨层契约（见下） |
| `runDataAgentTurn({messages, requestToolCompletion?, executeToolCall?})` | 端到端智能问数 turn：默认绑定语义工具执行器（真实 HTTP + capability 签名），LLM 与执行器均可注入 |

**跨层契约检查（fail-closed，任一失败则 snapshot.ok=false）**：

| 契约 ID | 校验内容 |
| --- | --- |
| `HARNESS_TOOL_SOURCE_OF_TRUTH` | 三个语义工具均注册于 `MAIN_AGENT_TOOLS`（registry 唯一事实源） |
| `HARNESS_INTENT_WIRING` | 至少一个意图画像（metric_query/record_query/traceability/business_risk_assessment）挂载语义工具 |
| `SEMANTIC_KERNEL_FAIL_CLOSED` | 本体 bundle 加载 + 指纹 SHA-256 校验通过（pi fail-closed 门） |
| `RUNTIME_PUBLICATION_CONSISTENT` | `runtime-capabilities.json` 发布指纹 === kernel 指纹，且 ready 指标非空 |
| `READY_METRICS_GOVERNED` | 全部 runtime-ready 指标均为 governance-approved |
| `ORCHESTRATOR_INJECTABLE_BOUNDARY` | orchestrator 保持依赖注入边界（`requestToolCompletion`/`executeToolCall`） |

## 4. 目录结构与模块隔离

```
Data-Agent/（单仓库，三层同域、依赖单向）
├── server/                        # L1 harness + L2 Node kernel + 统一入口
│   ├── unifiedDataAgentSystem.mjs # ★ 统一系统组合根（本次新增）
│   ├── mainAgentTool{Registry,Orchestrator,Planning,Loop,sets}.mjs   # harness
│   ├── agentRuntime/              # LangGraph runtime / 审计存储 / 流审计
│   ├── ontology/                  # pi Node kernel（registry/resolver/planner/…）
│   └── index.mjs                  # 网关（:3004，SSE）
├── backend/
│   ├── analytics/                 # L3 数据面（FastAPI :3003）
│   │   ├── api.py                 #   /api/semantic/query、/api/ontology/*
│   │   ├── semantic_query.py      #   语义执行器（契约校验+读模型）
│   │   ├── semantic_runtime.py    #   runtime 发布校验（Python 侧）
│   │   └── read_models.py         #   SQLite 读模型
│   └── tests/                     # pytest（语义契约/本体契约/全量）
├── ontology/
│   ├── v1/                        # 治理源（10 个 JSON，唯一可编辑源）
│   ├── schema/                    # JSON Schema（entities/metrics/…）
│   └── generated/                 # 编译产物（compiled/fingerprint/runtime-capabilities，
│                                  #   禁止手改，npm run ontology:compile 产出）
├── evals/                         # golden 评测集（路由/策略/执行/语义质量）
├── src/                           # React 前端（证据卡片、问数对话）
├── scripts/
│   ├── verifyIntegration.mjs      # ★ 统一集成验证总入口（本次新增）
│   └── integration_fixture.py     # ★ 实时端到端夹具构建器（本次新增）
├── docs/integration/              # ★ 集成文档（架构/决策日志/总结报告）
└── outputs/integration-verification/  # ★ 验证报告落盘（JSON，随库保留）
```

**依赖隔离策略**：
- **运行时隔离**：Node 24（`engines` 强制 + `scripts/nodeVersion.mjs` 断言）与 Python 3.12（`scripts/pythonRuntime.mjs` 强制 `.venv/bin/python` + duckdb/fastapi/pandas 可导入探针）双栈并存，Node 通过 `runPython.mjs` 受控调起 Python，环境变量白名单（`scripts/devHelpers.mjs`）显式透传，杜绝隐式环境泄漏；
- **数据隔离**：源/热/冷三层 SQLite 各自路径可由 `VIZION_FULL_PICTURE_*` 环境变量覆盖（集成验证正是利用该机制指向临时夹具库，不触碰仓库数据）；
- **模块隔离**：三层间只经明确契约通信（工具 schema / semantic query schema / HTTP+capability 签名），`server/ontology` 不 import harness、harness 不 import Python；
- **版本锁定**：本体指纹把 Node kernel 与 Python 数据面锁定在同一语义版本；`runtime-capabilities.json` 把"可执行指标集"单独发布，planned 指标不会进入执行路径。

## 5. 集成实施步骤（已执行）

1. **前置修复**：完成搁置中的 git 合并（24 个冲突文件），语义契约采用仓库内权威调和版，基线全绿（vitest 810 + pytest 422 + ontology:check）——详见决策日志 D5/D9。
2. **环境准备**：`.venv`（Python 3.12.7，system-site-packages 复用 anaconda 依赖）+ Node 24 via PATH 前置——D3/D4。
3. **统一入口实现**：`server/unifiedDataAgentSystem.mjs` 组合根 + 6 项跨层契约——D6。
4. **集成测试**：`src/test/server/unifiedDataAgentSystem.test.ts`（快照契约、fail-closed、离线端到端 turn、注入边界）——D7。
5. **验证总入口**：`scripts/verifyIntegration.mjs`（V1–V8 八项核对）+ `scripts/integration_fixture.py`（真实管线夹具），报告落盘 `outputs/integration-verification/`——D7/D8。
6. **文档**：架构说明（本文件）、决策日志、总结报告。

## 6. 验证方式

```bash
# 统一集成验证（快速：跳过全量回归）
node scripts/verifyIntegration.mjs --quick

# 统一集成验证（完整：V1–V8 含全量 vitest/pytest）
node scripts/verifyIntegration.mjs

# 仅集成单元测试
npx vitest run src/test/server/unifiedDataAgentSystem.test.ts
```

八项核对（V1–V8）的判据与最新结果见 `outputs/integration-verification/latest.json` 与总结报告。
