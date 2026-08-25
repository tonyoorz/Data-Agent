# Data Agent 进化循环 · 研究计划（2026-08-04）

> 本文档只做**审计与研究规划**，不含任何代码变更。执行授权前不动代码。
> 上游依据：GOAL PROMPT v2（架构共识锚点 §1、路线图 §4）。
> 前序调研：`docs/research/智能问数Agent全网深度调研-2026-08-03.md`、`docs/research/WrenAI混合集成方案-2026-08.md`。

---

## 一、审计报告（实测，非推测）

### 1.1 架构地图与真实运行时

| 目录 | 规模 | 状态 | 判定 |
|---|---|---|---|
| `backend/` | 75 py / 36,009 行（实现 ~18k + 测试 ~18k，27 个测试文件） | 活跃 | **语义执行内核 + 数据平面** |
| `server/` | 41 mjs / 8,914 行 | 活跃 | **主 Agent 运行时 + 工具面 + 语义编译前端** |
| `src/` | 188 ts/tsx | 活跃 | 前端 |
| `ontology/` | 21 json + 1 py（14,370 行） | 活跃 | 本体资产 |
| `agent/` | **51 个文件全是 `.pyc`，git 未跟踪** | **僵尸** | 源码已删，只剩编译残留 |
| `tests/` | **20 个 `.pyc`，git 未跟踪** | **僵尸** | 曾有 20 个 Python 测试，源码已消失 |
| `api/`、`examples/` | 仅 `.pyc` | **僵尸** | 同上 |

> **发现 0（未在原断点清单中）**：仓库根部存在 4 个未被 git 跟踪的僵尸目录，仅存 `__pycache__` 残留。`tests/` 的 20 个 pyc 表明历史上存在一套独立 Python 测试套件，现已灭失（当前 Python 测试全部在 `backend/tests/`）。这是"代码不膨胀"铁律的直接违反项，属零风险纯减法。

在线链路实测形态：

```
用户 → server/index.mjs
     → server/agentRuntime/langGraphChatRuntime.mjs（619 行，LangGraph）
     → server/mainAgentToolRegistry.mjs（正则 intent 路由 → 13 个 intent profile）
     → server/mainAgentToolOrchestrator.mjs → mainAgentTools.mjs（2,137 行，~20 个工具）
     → [语义轨] server/ontology/{semanticFrame,queryPlanner,queryCompiler,validator}.mjs
              → backend/analytics/semantic_query.py（1,201 行）
     → [旧轨]  backend/analytics/read_models.py（2,773 行）等
     → server/mainAgentEvidence.mjs（126 行，信封门禁）
```

---

### 1.2 断点清单逐项状态（如实报告，含反预期项）

#### 断点 A · 工具双轨 —— ❌ **未修复（最严重）**

主 Agent 实际暴露 **约 20 个工具**（`server/mainAgentToolRegistry.mjs:5-104` 的 13 个 intent profile 并集），目标是 7 个分析原语。双轨清单：

| 目标原语（7） | 现状 |
|---|---|
| `semantic_aggregate` | 以 `query_semantic_metrics` 存在 |
| `semantic_records` | 以 `query_semantic_records` 存在 |
| `semantic_compare` | **缺失**（对比能力藏在 metrics 的 `comparison` 参数里） |
| `semantic_trace` | 以 `query_traceability` 存在 |
| `duplicate_search` | 以 `search_duplicates` 存在 |
| `testcase_context` | 以 `get_test_case_context` 存在 |
| `ask_clarification` | ✅ 同名存在 |

**仍在服役的旧轨工具（应退不进）**：`query_analytics`、`query_analytics_fallback`、`diagnose_analytics_empty`、`query_full_picture_module`（§1.2 不做清单点名工具）、`query_dashboard_summary`、`query_defect_records`、`query_defect_high_frequency_analysis`、`query_testing_coverage_project_status`、`query_testing_coverage_aida_status`、`get_data_catalog`、`search_analytics_filter_values`、`resolve_business_terms`、`get_ontology_catalog`、`search_octane_fields`。

**附带发现 A′ · 隐式 Router 层**：`mainAgentToolRegistry.mjs:107-121` 用一条约 600 字符的巨型正则 + 8 条 `if` 硬编码分支做意图路由，再按 intent 裁剪工具集。这不是 LLM 多 Agent（未违反 §1.2 第 2 条字面），但它是**在"有界 model→tool 循环"之外增设的确定性路由层**：新增一个能力要同时改正则、改 profile、改 golden，是双轨的结构性成因，也是工具面无法收敛的根因。

#### 断点 B · records 真伪 —— ✅ **已修复（优于预期）**

`backend/analytics/semantic_query.py:1111-1200` 的 `execute_semantic_records` 是**真行数据**，且治理相当完整：

- 逐行字段投影（`_record_field_projection`，1066-1108），非分组计数；
- 字段白名单三重 fail-closed：不在 `RECORD_FIELD_MAPS` → 403；不在 `allowedPropertyIds` → 403；源字段缺失 → 422（1085-1090）；
- 敏感字段 pseudonymize（1093-1105）；
- **同快照强校验**：`revisionId` 与 `analysis_ref` 记录不符 → **409 STALE**（1141-1142）。这是追问一致性的硬保证。

**残留偏差（非阻塞）**：① 分页是 offset（`page/pageSize`）而非目标的 cursor；② 先全量物化再内存切片（`ordered_rows[start:start+page_size]`，1147-1149），数据量增长后是 O(N) 隐患。

#### 断点 C · fail-closed —— ⚠️ **部分修复（fail-open 为主）**

- **假分组确凿存在**：`semantic_query.py:566-571` `_dimension_value()` 把空维度值物化为字符串 `"(missing)"`，直接进入分组键。
- 整列全空只发 warning 不中断：`_aggregate_rows` 584-590 追加 `DIMENSION_VALUES_MISSING` 后**继续聚合**。
- fail-closed 只覆盖 1/3 执行路径：仅 `_execute_testcases`（700-702）对不可执行维度抛 `SEMANTIC_DIMENSION_NOT_EXECUTABLE`；`_execute_defects`、`_execute_test_runs` 无此保护。
- 请求校验层（`_validate_request`）确实拦截未知 metric/dimension ID，但拦不住"ID 合法、数据侧无值"这一类。

#### 断点 D · Ontology 兑现度 —— ⚠️ **部分修复（"半接线"）**

数量与提示词完全吻合：**28 实体 / 50 维度 / 30 指标** + 27 关系 / 12 业务规则 / 5 约束 / 3 动作 / 3 策略 / 15 源。

**死字段实测**（在 `server/ backend/ src/ scripts/` 全量 grep，排除 node_modules 与 pyc）：

| 本体字段 | 声明情况 | 运行时引用 | 后果 |
|---|---|---|---|
| `business_rules.json`（12 条） | 完整 | **0 处** — 且 `scripts/compileOntology.mjs:11-19` 的 9 文件打包清单**根本不含它**，连编译产物都进不去 | 12 条业务规则 100% 装饰性 |
| `measure`（如 `count_distinct(defect_id)`） | 21/30 | **0 处** | **30 个指标在执行层全部退化为 `len(distinct_rows)`**（`_aggregate_rows` 601-607，仅 passed/failed run count 两个特例） |
| `missingDataPolicy`（如 `zero_when_empty`） | **30/30** | **0 处** | 直接造成断点 C 的 `(missing)` 假分组 |
| `additivity`（可加性） | **0/30，字段不存在** | — | 无法判断指标能否跨维度求和 |
| `eventTimeSemantics` | 有 | 0 处 | 时间语义未进执行 |
| `sourceRevisionStrategy` | 有 | 0 处 | 快照策略未接线 |
| `enforcement`（constraints 的 fail/warn） | 有 | 0 处 | 违反时行为不确定 |
| `reversible` / `sourceFields`（relationships） | 有 | 0 处 | 关系无法反向遍历 |
| `allowedJoinPaths` / `cardinality` | 有 | **仅** `server/ontology/validator.mjs` | 只做**校验**，无 join 推导 → 27 条关系不具备真实遍历能力 |

已真实接线的：`allowedDimensions`、`requiredFilters`、`governance`、`capabilityState`、`constraints`（部分）。

> **核心因果链（本次审计最重要结论）**：断点 C 与断点 D 是**同一个根因**——本体已经写好了 `missingDataPolicy`（30/30）和 `measure`（21/30），执行内核却完全不读。因此修 fail-closed、修指标口径，**不需要新增任何概念，只需把已有声明接线**。这是纯减法式修复，天然符合反膨胀铁律。

#### 断点 E · analysis_ref —— ✅ **已修复**

`backend/analytics/semantic_analysis_store.py` + `execute_semantic_records` 已实现一等公民分析引用：`analysisRef` 持有 `actor_scope_hash / ontology_version / schema_fingerprint / query / source_revision / evidence`，支持凭 ref 恢复并做同快照追问（409 STALE 保护见断点 B）。`server/mainAgentEvidence.mjs:117-135` 的 `buildSemanticContinuationContext` 已把 ref 回注给下一轮。

#### 断点 F · 证据门禁 —— ⚠️ **部分修复（有信封门禁，无内容门禁）**

`server/mainAgentEvidence.mjs:36-89` 的 `evaluateSemanticEvidence` 检查 8 类违规，但**全部是元数据字段存在性/一致性**（version 在不在、ref 匹不匹配、revision 一不一致）。

两个实质缺口：

1. **无 post-answer Claim→Evidence 内容校验**。`formatSemanticEvidenceGate`（91-110）产出的是**塞给 LLM 的一段 prompt 文本**（"Do not state numerical claims…"）——软约束，LLM 可无视。回答里出现工具结果中不存在的数字，当前**无任何程序化拦截**。
2. **双轨造成门禁绕过**（与断点 A 耦合）：`CLAIM_BEARING_SEMANTIC_TOOLS`（第 35 行）只含 `query_semantic_metrics` 与 `query_semantic_records` **两个**工具。其余 ~18 个旧轨工具走到门禁一律 `status: "not_required"` **直接放行**。→ **旧轨工具产出的数字完全不受证据约束。**

#### 断点 G · 运行韧性 —— ⚠️ **部分修复**

- **LLM 调用无统一 timeout / retry / 熔断**。全仓 grep 到的 timeout 全部属于 PDF/OCR/duplicateSummary 局部路径（`documentText.mjs:84`、`imageOcr.mjs:110`、`duplicateSummary.mjs:331`）；主链路 LLM 调用无 AbortController、无退避重试、无断路器。`mainAgentTools.mjs:1045` 仅打了个 `retryable` 标记但**无人消费**。
- checkpoint / 审计**已有**：`server/agentRuntime/runtimeAuditStore.mjs`（54 行）落 `writeThreadCheckpoint` / `appendRunEvent` / `appendToolAudit` 到 `logs/agent-runtime/`。但为裸文件 JSONL：无并发保护、无轮转、**无失败 run 的终态 reconcile**（挂掉的 run 停在中间态无人收尾）。

#### 断点 H · 评测层级 —— ❌ **未修复（全部停留在解析/路由层）**

现有 golden 共 **122 条**，零条验证执行结果：

| 文件 | 条数 | expected 字段 | 验证层级 |
|---|---|---|---|
| `evals/main-agent/target/semantic-golden.jsonl` | 113 | `intent`(113) / `metricIds`(113) / `dimensionIds`(113) / `timeFieldId`(92) / `timeStart`(90) / `comparisonGroups`(6) / `filters`(4) / `ambiguityCode`(6) | **NL → SemanticFrame 解析正确性** |
| `evals/main-agent/target/agent-golden.jsonl` | 9 | `shouldPlanTools` / `intent` / `toolNamesInclude` / `toolNamesExclude` | **路由与工具选择正确性** |

缺失全部五类：执行结果数值断言、同快照 compare、真 records 内容、证据一致性、follow-up 连续性。

> **附带风险**：`agent-golden` 的 `toolNamesInclude` 直接把 `query_analytics`、`query_analytics_fallback` 等旧轨工具**写死为期望值**。评测集本身正在**锁死双轨**——收敛工具面会导致 golden 集体失败。这是断点 A 的隐性阻力，必须与 A 同批处理。

#### 本体设计健康度（独立于 A–H）

| 审查要点 | 状态 | 证据 |
|---|---|---|
| 1 指标口径质量 | ⚠️ 部分 | `grain` 30/30 ✅、`missingDataPolicy` 30/30 ✅、`measure` 21/30 ⚠️、**`additivity` 0/30 ❌**（字段未定义） |
| 2 实体/维度归并 | ❓ 未评估 | 需专项：僵尸对象、重复建模、粒度合理性（本轮未做，列入研究计划） |
| 3 关系/规则可执行性 | ❌ | 12 条 business rules 零消费且不进编译；`enforcement` 零消费；关系只校验不遍历 |
| 4 provenance 完备 | ⚠️ 部分 | 有 `governance` / `version` / `definitionVersion` / `sourceReadModel`；缺 `owner` / `verified_at` / `quality`（需对齐 OpenMetadata） |
| 5 数据绑定与 availability | ⚠️ 部分 | 有 `sourceReadModel` / `capabilityState`；未做未绑定对象的投影屏蔽 |
| 6 版本化与变更审查 | ⚠️ 部分 | 有 `ontologyVersion` + `fingerprint.txt` + `ontology:check`；**无 proposal → review → publish → rollback 流程** |

### 1.3 断点状态总览

| 断点 | 状态 | 一句话 |
|---|---|---|
| A 工具双轨 | ❌ 未修复 | ~20 工具 vs 目标 7；旧轨仍在；额外有正则 Router 层 |
| B records 真伪 | ✅ 已修复 | 真行数据 + 白名单 + 脱敏 + 409 同快照校验；仅分页形态待优化 |
| C fail-closed | ⚠️ 部分 | `(missing)` 假分组存在；fail-closed 仅覆盖 1/3 执行路径 |
| D Ontology 兑现 | ⚠️ 部分 | 建模优秀但"半接线"；measure/missingDataPolicy/business_rules 零消费 |
| E analysis_ref | ✅ 已修复 | Analysis Store + 追问回注 + 陈旧快照 409 |
| F 证据门禁 | ⚠️ 部分 | 有信封门禁；无内容门禁；旧轨工具整体绕过 |
| G 运行韧性 | ⚠️ 部分 | 有 checkpoint/审计；LLM 调用无 timeout/retry/熔断；无失败终态收尾 |
| H 评测层级 | ❌ 未修复 | 122 条全是解析/路由层；且 golden 正在锁死双轨 |

**净判断**：P0 闭环的「后半段」（records / analysis_ref / 快照一致性）已扎实落地，质量高于提示词预期；**未闭合的是「前半段」（工具面收敛、本体接线）与「验收段」（内容级证据门禁、执行结果评测）**。当前形态是"一个治理良好的语义内核，被一层未收敛的旧工具面和一套只测解析的评测包着"。

---

## 二、Phase 2 研究计划（本次交付主体）

### 2.0 原则

- 只采信一手来源，标注 **A/B/C/D 证据级**与访问日期；
- 与 §1 架构共识冲突时，**默认共识正确**，除非拿到 A/B 级新证据；
- 每个研究问题必须**能落到本仓库某个具体文件的决策**上，否则不做；
- 前序 4 份调研报告已覆盖的内容不重复调研，只做**增量与时效核验**。

### 2.1 研究问题清单（RQ）

| RQ | 问题 | 为什么现在需要 | 对标源 | 目标证据级 | 落点 |
|---|---|---|---|---|---|
| **RQ-1** | 语义层如何把 `measure` 表达式编译成执行算子？count_distinct / sum / ratio / 半可加指标分别怎么处理？ | 直击断点 D 最大缺口：30 指标全退化为 count | Cube `measures` 源码、MetricFlow measure→metric 编译 | A | `semantic_query.py:_aggregate_rows` 重写方案 |
| **RQ-2** | `additivity`（可加/半可加/不可加）业界如何声明与强制？半可加指标跨时间聚合如何拦截？ | 本体 0/30 声明，且无强制机制 | MetricFlow、Cube、AtScale 文档 | A/B | `ontology/v1/metrics.json` schema 扩展 |
| **RQ-3** | 空值/缺失维度的 fail-closed 惯例：报错、显式 UNKNOWN 桶、还是 policy 驱动？错误负载怎么给 Agent 自纠信息？ | 直击断点 C `(missing)`；本体已有 `missingDataPolicy` 待接线 | WrenAI structured errors、MetricFlow validation | A | `_dimension_value` / `_aggregate_rows` 改造 |
| **RQ-4** | 从 ~20 工具收敛到少量类型化原语，头部系统的**原语切分边界**是什么？compare 该独立成工具还是作为 aggregate 参数？ | 断点 A 核心决策，直接决定改动面 | Snowflake Cortex Analyst 工具面、Databricks Genie、WrenAI ask/generate 契约 | A/B | `mainAgentToolRegistry.mjs` 重构方案 |
| **RQ-5** | 正则/规则式 intent router 在 2026 年是否仍是主流？头部系统靠什么替代（纯 tool-calling / schema-guided）？ | 决定 A′ 是删除还是保留 | LangGraph 官方 pattern、Cortex Analyst、Genie | A/B | `routeToolIntent` 存废 |
| **RQ-6** | **Claim→Evidence 内容级校验**如何工程化？数字回指、排序回指、因果措辞检测分别怎么做？拦截还是重写？ | 断点 F 最大缺口，当前纯 prompt 软约束 | Cortex Analyst VQR、Genie 反馈机制、近 12 月 grounding/attribution 论文 | A/C | 新建 `claimValidator.mjs` 设计 |
| **RQ-7** | 执行结果级 golden 的**断言形态**：精确值、容差、结构不变量还是快照对比？数据漂移怎么办？ | 断点 H 核心；必须先定断言形态再写 30–50 条 | Cortex Analyst VQR、Datus benchmark runner、Spider2 评测协议 | A/C | `evals/` 新 schema 设计 |
| **RQ-8** | 本体变更流程（proposal → review → publish → rollback）最小可行形态？version 如何与运行时 frame 绑定？ | P1.1 前置；当前仅有 fingerprint 校验 | ktx、OpenMetadata、Wren MDL 版本化 | A/B | `scripts/compileOntology.mjs` 扩展 |
| **RQ-9** | LLM 调用韧性的标准封装：timeout/retry/熔断参数取值与幂等边界？工具调用失败如何进 checkpoint 终态？ | 断点 G；避免各调用点各写各的 | LangGraph durability/checkpointer 文档与源码 | A | `langGraphChatRuntime.mjs` 统一封装 |
| **RQ-10** | 本体对象**归并与瘦身**判据：僵尸对象、重复建模、粒度不当如何量化识别？ | 健康度要点 2 本轮空缺，且是反膨胀铁律在本体侧的落地 | Cube/dbt 语义层治理实践、OpenMetadata usage 信号 | B | 本体瘦身专项脚本设计 |

### 2.2 时效性核验清单（§1 共识每 2–3 月复检）

- WrenAI / Cube / MetricFlow / Datus 近 6 个月是否有语义层契约破坏性变更；
- Cortex Analyst VQR、Genie 是否有新的 verified-analysis 机制；
- 复核 Vanna（2026-03-29 归档）、Dataherald（2024-07 停更）状态未变，确认继续禁止引入；
- 检索是否出现"单 Agent + 确定性语义内核"被反证的 A/B 级证据（若有，触发共识升级至 v3）。

### 2.3 研究方法与产出

1. **源码优先**：RQ-1/2/3/4/9 直接读官方仓库对应模块，记录文件路径与提交日期，标 A 级；
2. **文档次之**：产品契约类（RQ-6/7/8）读官方文档，标 B 级，明确"不代表内部实现"；
3. **论文最后**：RQ-6/7 的算法部分可引论文（C 级），仅作机制参考，**不直接落地**；
4. 每个 RQ 产出一节：**结论 / 证据（含链接+日期+等级）/ 对本仓库的具体落点 / 与 §1 共识是否冲突**；
5. 汇总为 `docs/research/evolution-cycle-2026-08-findings.md`。

**边界**：Phase 2 只产出结论与落点，**不写实现代码、不改本体、不动评测**。

---

## 三、初步提案骨架（待 Phase 2 验证后定稿，不作为执行依据）

> 以下是基于 Phase 1 实测的**假设**，每条都必须由对应 RQ 结论确认或推翻后，才进入 Phase 3 正式提案。

### P0 级（正确性与闭环）

| 编号 | 提案假设 | 归口 | 依赖 | 预期减法 |
|---|---|---|---|---|
| **提案-1** | **本体接线三件套**：`measure` → 执行算子；`missingDataPolicy` → fail-closed；`enforcement` → 约束行为。不新增概念，只消费既有声明 | P0.3 + P0.2 | RQ-1/2/3 | `_aggregate_rows` 中的硬编码 metric 分支可删；`(missing)` 分支删除 |
| **提案-2** | **工具面收敛 + 删除正则 Router**：~20 → 7 原语，旧轨工具下线，`routeToolIntent` 与 13 个 intent profile 一并删除 | P0.1 | RQ-4/5 | 预计净删 `mainAgentToolRegistry.mjs` 大部 + `mainAgentTools.mjs` 相当比例；**须与提案-4 同批**（golden 锁死双轨） |
| **提案-3** | **Claim→Evidence 内容门禁**：新增 post-answer validator，数字/排序/增长率回指工具结果，因果措辞无证据即拦截；同时**把门禁覆盖面从 2 个工具扩到全部产出数字的工具** | P0.4 | RQ-6 | 覆盖面修复是纯配置改动，零新增代码 |
| **提案-4** | **执行结果级 golden**：30–50 条真实问题，断言执行结果 + 同快照 compare + records 内容 + 证据一致性 + follow-up 连续性；同步重写被双轨锁死的 9 条 agent-golden | P0.5 | RQ-7 | 替换而非叠加 |
| **提案-5** | **LLM 调用韧性统一封装** + 失败 run 终态 reconcile | P0.5 | RQ-9 | 消除散落各处的局部 timeout |
| **提案-6** | **删除僵尸目录** `agent/` `tests/` `api/` `examples/`（git 未跟踪，仅 pyc 残留） | 路线图外·纯减法 | 无 | 零风险，直接减少 4 个目录 |

### P1 级（变准飞轮）

- **提案-7**：本体设计演进 —— 补 `additivity`、补 provenance（`owner`/`verified_at`/`quality`）、僵尸对象瘦身、未绑定对象不进 Agent 投影（P1.0，依赖 RQ-2/10）；
- **提案-8**：business_rules 要么接线进 planner/validator，要么**删除**——不允许继续做装饰性定义（P1.0，依赖 RQ-1/8）；
- **提案-9**：Context Build Plane 最小形态（P1.1，依赖 RQ-8）。

### P2 级（暂不启动）

预聚合、图投影、RLS/多租户、沙箱 Python、多候选 ensemble、typed action 写操作。records 分页从 offset 改 cursor 也归此级（当前数据量下非瓶颈）。

### 建议执行顺序（附理由）

```
提案-6（零风险减法，先清场）
  → 提案-1（本体接线：修 C + D，纯减法，且是后续正确性的地基）
  → 提案-4 + 提案-2（必须同批：先建执行结果级 golden 作为安全网，再收敛工具面）
  → 提案-3（门禁覆盖面修复可提前，内容校验器随后）
  → 提案-5（韧性）
  → P1
```

关键排序理由：**提案-2 不能先做**——现有 122 条 golden 只测解析/路由且把旧轨工具写死为期望值，此时收敛工具面等于在没有安全网的情况下拆承重墙。必须先有执行结果级 golden。

---

## 四、实施结果

_（Phase 4 执行后填写）_

## 五、验证结论

_（Phase 5 执行后填写；须含执行准确率、时延、token 成本、代码量 ±行数，并同步 `docs/ADR/` 与 `EVOLUTION_LOG.md`）_

---

## 附录 · 待用户确认事项

1. **授权模式**：`提案后等我确认再实施` / `路线图内 P0 项可直接实施`（提示词【运行参数】留空）。
2. **本轮重点**：全面审计（已完成）后，Phase 2 是否全量跑 10 个 RQ，还是先聚焦某几个断点。
3. **评测入口**：仓库无 golden 执行脚本（`npm test` = vitest；`evals/` 仅数据无 runner）。需确认执行结果级评测是新建 runner 还是接入既有 `test:ontology` 体系。
4. **提案-6（删僵尸目录）** 属零风险纯减法，是否允许先行执行。
