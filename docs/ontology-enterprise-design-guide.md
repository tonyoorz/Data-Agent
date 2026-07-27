# Data-Agent 企业级 Ontology 体系设计方案

> 版本：v1.0 · 2026-07-27
> 输入：全网调研（Palantir Foundry、Atlan、Spire、dbt Semantic Layer、data.world、Neo4j 语义层、NeOn/Ontology 101 方法论、学术 EKG 管线）+ 本项目 `ontology/` 现状审计
> 读者：Data-Agent 核心团队、SME（领域专家）、数据工程

---

## 0. 执行摘要

**全网调研的一致结论**：企业 Ontology 项目失败的主要原因不是建模技术，而是**范围失控**（"boiling the ocean"——试图一次性建模整个企业）和**缺乏治理**（无版本、无评审、无人负责）。成功的路径高度一致：

1. **从胜任问题（Competency Questions, CQ）出发**，而不是从名词清单出发；
2. **从窄到宽**：首个领域 15–25 个核心实体即可产生价值，逐领域扩展；
3. **确定性优先**：LLM 直接写 SQL 在真实企业 schema 上准确率仅 16.7%–40%（data.world / BEAVER / Spider 2.0 基准），走语义层后提升到 54%–98%+（dbt 2026 基准最高 100%）；
4. **语义层是 AI Agent 的地基**：没有本体，Agent 会在"Customer 到底是线索还是付费客户"这类歧义上臆造关系；
5. **治理是操作系统而非文档**：本体必须像代码一样有 branch / diff / review / merge / release。

**对本项目的评估**：Data-Agent 的 `ontology/` 目录已经走得比大多数企业项目更远——已有 JSON Schema 校验的模块化本体（28 实体 / 30 指标 / 27 关系 / 50 维度）、编译产物 `ontology.compiled.json`、以及一份结构良好的 CQ 清单（`cq-list.md`）。**当前的核心缺口不在"有没有本体"，而在四个方面：治理工作流未落地（CQ 中大量 draft/gap 项悬而未决）、本体未深度接入 Agent 运行时（尚未形成确定性查询编译路径）、缺少团队协作的角色分工与版本机制、缺少持续度量和扩展规则。**

本方案给出补齐这四个缺口的具体设计。

---

## 1. Ontology 核心概念、分类框架与关键构建要素

### 1.1 核心概念：从哲学到工程

Ontology（本体）源自哲学，在计算科学中采用 Gruber 的定义：**"对概念化的显式规范"（an explicit specification of a conceptualization）**。工程语境下，它回答三个问题：

- 企业里**存在哪些事物**（类与实例）？
- 它们之间**有什么关系**（谓词与约束）？
- 关于它们，**什么陈述为真**（公理与规则）？

与相邻概念的区分（这在企业沟通中最常被混淆）：

| 概念 | 回答的问题 | 例子 |
|---|---|---|
| Taxonomy（分类法） | "X 是一种 Y 吗？" | 缺陷 → 严重缺陷 → 致命缺陷 |
| Glossary（术语表） | "X 是什么意思？" | "open defect" = 未到达终态的缺陷 |
| Schema（模式） | "数据怎么存？" | 表、列、类型、外键 |
| Semantic Layer / Metrics Layer | "指标怎么算？" | defect.resolve_rate 的公式与粒度 |
| Knowledge Graph（知识图谱） | "具体事实是什么？" | 缺陷 D-123 属于 PU Alpha |
| **Ontology（本体）** | **以上全部的形式化骨架** | 类 + 关系 + 约束 + 规则，定义"意义"本身 |

学术上区分 **T-Box**（本体/模式层：类、属性、层级、约束）与 **A-Box**（实例层：具体事实）。对企业团队的实用翻译：**ontology/ 目录维护的是 T-Box；数据仓库/读模型里的事实是 A-Box。本体项目只管 T-Box，但要以 A-Box 能实例化它为验收标准。**

### 1.2 分层分类框架（五层模型）

综合 Atlan "Active Ontology" 五层模型与学术 EKG 实践，企业本体应按层组织，保证每个新领域与已有领域兼容：

| 层 | 内容 | 本项目对应物 |
|---|---|---|
| L1 Foundational（基础层） | 时间、组织、人员、地理位置、单位等跨领域概念 | `organization.team`、时间维度、`vocab.zh-CN.json` |
| L2 Domain（领域层） | 缺陷、测试、需求、追溯等业务对象 | `quality.defect`、`testing.test_run`、`requirements.aida_node` |
| L3 Task（任务层） | 面向分析/问答的指标、维度、派生概念 | `metrics.json`（30 个）、`dimensions.json`（50 个） |
| L4 Constraint（约束层） | 业务规则、校验、策略、敏感度 | `business_rules.json`、`constraints.json`、`policies.json` |
| L5 Instance（实例层） | 具体数据绑定与读模型映射 | `sources.json`、`sourceReadModel` 字段、编译产物 |

**关键规则：下层未稳定，不建上层。** glossary/ownership 覆盖率差的领域，直接建模会得到充满歧义的实体定义——这是 Atlan 调研中失败项目的共同前兆。

### 1.3 关键构建要素（Checklist）

一个"有效"的企业本体必须同时具备以下要素，缺一即瘸：

1. **胜任问题（CQ）**：本体的验收测试。每类/指标必须能映射到至少一条已批准的 CQ；每条 CQ 必须能被本体回答。✅ 本项目已有 `cq-list.md`，这是多数企业项目缺失的资产。
2. **实体与身份规则**：每个实体类型需有独立身份（primaryKey）、生命周期、权威数据源。✅ 已有（`primaryKey`、`source`、`governance`）。
3. **关系与基数**：关系是本体相对关系数据库的核心差异化能力——支持多跳推理（缺陷→PU→ECU→负责团队）。✅ 已有（27 条关系含 cardinality、allowedJoinPaths）。
4. **约束与业务规则**：状态机（open/terminal）、阈值（long-runner）、归因窗口等。**⚠️ 本项目大量规则处于"需批准"状态**——CQ 清单中 draft 状态的根源。
5. **时间语义**：eventTimeSemantics、时区、快照 vs 区间。✅ 已有基础（dimensions 含 eventTimeSemantics/timezone）。
6. **策略与敏感度**：行/列级权限、数据敏感度分级。✅ 已有（sensitivity、policies）。
7. **词汇与别名**：多语言标签、别名、同义词——这是 NL 问答的映射表。✅ 已有（labels、aliases、vocab.zh-CN）。
8. **治理元数据**：owner、状态（draft/approved/deprecated）、版本。✅ 结构已有；⚠️ 工作流未运转。
9. **溯源（Provenance）**：每个定义可追溯到批准记录与数据源版本。⚠️ 部分缺失。

---

## 2. 企业级 Ontology 设计原则与数据建模方法

### 2.1 设计原则（全网最佳实践收敛为 8 条）

**P1. 从决策与问题出发，不从名词出发（CQ-driven）。**
Spire 的原则："Start with decisions, not nouns"。第一个工作坊产出 10–20 条 CQ，每条绑定一个业务决策、一个责任人、一个可度量结果。纯报表需求、无行动挂接的问题要剔除。**本体不能回答 CQ 就是不完整；概念不支撑任何 CQ 就不该进 v1。** 本项目的 cq-list.md 正是这个产物，应被制度化：任何实体/指标 PR 必须声明它支撑哪条 CQ。

**P2. 窄启动、证据驱动扩展（Don't boil the ocean）。**
Pfizer、Cohere Health 等案例的共同教训：试图一次建模整个领域必然烂尾。经验值：首个领域 **15–25 个实体类型、5–10 种关系** 即可支撑真实决策（本项目 v1 的 28 实体在合理区间上限）。扩展规则：**只有当一个被验证的用例无法干净表达时，才新增类型/关系/策略**——"没有 CQ + owner + 数据源 + 消费者，就不加概念"。

**P3. 身份、时间、溯源优先于广度。**
20 个治理良好的实体比 200 个定义松散的实体更有价值。每个类型入库前必须回答：身份规则是什么？谁是生命周期 owner？权威源是哪个？随时间如何变化？

**P4. 关系先于属性。**
先把"缺陷属于 PU、用例追溯需求、执行属于团队"这些边建对，再细化属性。本体的核心价值在多跳遍历；属性可以渐进补充。

**P5. 语义确定性，失败要"响亮"。**
语义层的核心价值：LLM 不再即兴发明 join 和公式，而是从受治理的本体中选择已批准的指标/维度组合，由确定性引擎编译为查询。失败模式从"看似合理但错的数字"（silent hallucination）变成"超出模型范围"的显式错误（loud failure）。对企业 Agent，后者远好于前者。

**P6. 复用标准词汇，不重复造轮子。**
组织、人员、时间等基础概念优先复用 FOAF、schema.org、W3C Time Ontology 等成熟词汇的命名与语义；领域概念再自定义。

**P7. 单一意义源（Source of truth for meaning）。**
所有下游（看板、Agent、API、报表）必须读同一个本体版本，禁止"每个应用各自解释指标"。Palantir 的表达：本体是意义的事实源，不只是存储的事实源。

**P8. 治理内建于工作流，而非事后补文档。**
本体变更 = 代码变更：branch → diff（语义级：新增哪些实体、哪个关系改了基数）→ review（SME 批准）→ merge → release tag → 下游绑定版本。

### 2.2 数据建模方法（推荐管线）

综合学术 EKG 七步管线（Meckler 2024，CRISP-DM 改编）与 Ontology 101（Noy & McGuinness），落地为六步迭代循环：

```
① 范围界定      选定一个领域，写 10–20 条 CQ（业务语言），指定 domain owner
② 资产盘点      盘点已有资产：glossary、SQL/BI 逻辑、血缘、读模型——从已有元数据
                引导（bootstrap）第一稿，不开空白白板
③ 建模          枚举核心类 → 定义层级 → 定义属性槽位 → 定义关系与基数 →
                定义约束/规则 → 定义实例绑定（source/readModel）
④ 评审          SME 逐条过 CQ：本体能否回答？措辞是否业务化？draft 项形成决策单
⑤ 验证          用生产数据实例化：CQ 全部跑通、覆盖率/一致性指标达标、失败响亮
⑥ 发布与扩展    打 release tag，下游绑定版本；下一条 CQ 暴露缺口时回到 ①
```

**建模反模式清单**（来自全网案例与本项目 CQ 审计）：

- ❌ 把每张源表都变成一个实体类型（状态码通常是属性，不是实体）；
- ❌ 无 CQ 支撑的"备用"实体/指标（cq-list.md 已标记此类为下线候选）；
- ❌ 在应用代码里硬编码业务规则而不是放进本体约束层（变成不可审计的黑盒）；
- ❌ 用自然语言文档记录口径而不形式化（LLM 无法稳定消费，人也会读漏）；
- ❌ 追求 OWL/DL 完备性而牺牲可用性——**务实路径：JSON Schema + 受控词汇先行，受监管领域再升级 RDF/OWL/SPARQL**。

---

## 3. Data-Agent 中集成 Ontology：知识组织、数据关联与语义推理

### 3.1 目标架构：本体作为 Agent 的"确定性内核"

基准数据（第 2 节 P5 的证据）决定了架构选型：

| 方案 | 真实企业 schema 准确率 | 失败模式 |
|---|---|---|
| LLM 裸写 SQL | 16.7%–40% | 看似合理但错的答案 |
| LLM + 语义层/本体 | 54%–98%+ | 显式"无法回答" |
| LLM + 良好建模的语义层 | 90%–100%（dbt 2026） | 仅限已建模范围 |

结论：**Data-Agent 应采用"本体驱动的受约束生成"架构**——LLM 的职责被缩减为"把自然语言问题分解为已批准的 指标×维度×过滤 组合"，查询生成由确定性编译器完成。这正是 `ontology.compiled.json` 应该承担的角色。

```
用户问题（中文/英文）
   │
   ▼
┌─────────────────────────────────────────────┐
│ 1. 语义解析层 (LLM)                          │
│    - 词汇映射：用 vocab/aliases 把"缺陷""用例"  │
│      对齐到实体 ID                            │
│    - 意图分解：→ {metric, dimensions,        │
│      filters, timeRange, grain}              │
│    - 消歧：歧义时反问，不猜测                  │
└─────────────────────────────────────────────┘
   │ 结构化意图 (JSON)
   ▼
┌─────────────────────────────────────────────┐
│ 2. 本体校验层 (compiled ontology)            │
│    - 指标存在且 approved？                    │
│    - 维度在 allowedDimensions 内？            │
│    - requiredFilters 齐全？                   │
│    - 用户的 sensitivity/policy 允许？          │
│    ✗ 任一不满足 → 响亮失败 + 解释缺什么        │
└─────────────────────────────────────────────┘
   │ 合法查询计划
   ▼
┌─────────────────────────────────────────────┐
│ 3. 确定性编译层                               │
│    - 指标公式 + grain + 时间语义 → SQL        │
│    - join 只走 relationships.allowedJoinPaths │
│    - 自动注入 mandatory filters（如排除测试数据）│
└─────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────┐
│ 4. 执行 + 解释层 (LLM)                       │
│    - 执行只读查询                             │
│    - LLM 只做结果解读与叙事，不构造数字        │
│    - 回答附带血缘：用了哪个指标版本、哪条 CQ   │
└─────────────────────────────────────────────┘
```

### 3.2 三个能力域的具体集成方案

**(a) 知识组织**：本体即团队共享心智模型。
- `vocab.zh-CN.json` + aliases 是中文问答的映射表——持续从真实提问日志中补充未命中词；
- 用 `ontology_graph.html`（已有）做团队 onboarding：新人先逛图再提问；
- 每个实体/指标的 `descriptions` 用业务语言书写，兼作 LLM prompt 上下文与人类文档——一处维护，两处消费。

**(b) 数据关联**：关系层支持多跳问答。
- "某 ECU 的缺陷由哪些团队的测试暴露？" = defect→PU→ECU + defect→finder_team 两跳；
- 关键纪律：Agent **只允许沿 `allowedJoinPaths` 遍历**，禁止即兴 join——这是准确率与可审计性的保障；
- 27 条关系应按 CQ 清单做覆盖审计：哪些 CQ 需要的关系尚不存在（gap 项的结构性原因）。

**(c) 语义推理**：分层推进，不一步登天。
- **近期（规则推理）**：`business_rules.json` + `constraints.json` 已能支持"open 缺陷 = 未达终态"这类确定性推导，用规则引擎/Datalog 式求值即可；
- **中期（派生事实）**：在编译层支持派生指标（如 resolve_rate = resolved/created，含 resolved-forward 规则）的显式声明与版本化；
- **远期（图推理/嵌入）**：若引入 GraphRAG（实体消歧、相似问题召回、链接预测），Neo4j 基准显示可省 20–30% token 并提升复杂多表问题约 10 个百分点准确率——但**前提仍是 T-Box 先治理好**。

### 3.3 运行时上下文注入策略

不要把整个 compiled ontology 塞进 prompt（噪声降准确率、token 成本高）。按问题动态检索子图：
1. 用语义搜索在 vocab/labels/descriptions 上召回候选实体与指标（Top-K）；
2. 沿关系图扩展 1–2 跳，取相关维度与规则；
3. 只把这个"最小充分子图"注入解析层 prompt。
Neo4j 语义层基准证明该模式比"全量 YAML"便宜且更准。

---

## 4. 维护策略、可扩展性与团队协作机制

### 4.1 版本与发布管理（Ontology as Code）

借鉴 Palantir 的语义级 Proposal 机制，落到本项目已有的 Git 工作流：

- **语义版本**：`ontologyVersion` 采用 major.minor——新增实体/指标/关系（向后兼容）= minor；修改已批准定义、改基数、下线概念（破坏性）= major；
- **语义 diff**：CI 生成人类可读变更摘要（"新增指标 defect.reopen_count；defect.resolve_rate 公式 v1.1→v1.2"），不只贴 JSON diff；
- **Release 绑定**：编译产物 `ontology.compiled.json` 打 tag，Agent 运行时与报表**绑定到具体版本**，破坏性升级不自动扩散（Palantir 教训：V13 破坏应用逻辑时应用不自动升级）；
- **fingerprint.txt**（已有）继续做变更检测，扩展为 CI 门禁：schema 校验 + CQ 覆盖审计 + 破坏性变更检查。

### 4.2 变更工作流（团队协作的核心机制）

```
提议者                SME / Domain Owner           本体委员会
   │ 开分支+修改            │                            │
   │ 提交 PR：声明支撑的 CQ ──►│ 评审：业务语义、口径、     │
   │ (实体/指标/规则)        │ CQ 措辞                    │
   │                        │ draft → approved / 退回    │
   │                        └──────────┬─────────────────┘
   │                                   ▼
   │                        合并 + 打 release tag + 更新编译产物
   │                                   ▼
   │                        下游（Agent/报表）按需升级绑定版本
```

**每条 CQ 的 draft/gap 项 = 一张决策单**，指定 owner 与截止日期。当前 cq-list.md 里约 20 条 draft + 15 条 gap，这就是本体团队未来两个迭代的现成 backlog（例：CQ-D-03 需批准 open/terminal 定义、CQ-D-07 需批准 long-runner 阈值、CQ-TR-05 需确认 Feature/Story 数据源）。

### 4.3 角色分工（RACI）

| 角色 | 职责 | 人选 |
|---|---|---|
| Domain Owner（领域负责人） | 对领域内口径有最终决定权；批准 draft→approved | 每个领域 1 名（质量/测试/需求/组织） |
| SME（领域专家） | 参加 CQ 工作坊，确认措辞与业务规则 | 各领域 2–4 名 |
| Ontology Engineer | 维护 schema、编译器、CI 门禁、版本 | Data-Agent 核心开发 |
| Agent Engineer | 消费 compiled ontology，反馈解析失败案例 | Agent 开发 |
| Consumer（业务用户） | 提问，上报"答非所问" | 全员 |

关键组织前提：**每个领域必须有一个有签字权的命名 owner**——没有 owner 的领域不建模。

### 4.4 可扩展性设计

- **模块化文件布局已就绪**（entities/metrics/relationships/dimensions/rules/policies/sources 分文件 + schema 校验），新增领域 = 新实体挂载到 L1 基础概念上，复用组织/时间维度；
- **扩展护栏（Guardrail）**：新概念的入库条件 = 至少 1 条 CQ + 1 名 owner + 权威数据源 + 1 个消费者。四缺一则留在 draft；
- **下线机制同样重要**：无 CQ 支撑、无查询日志命中的实体/指标，标记 deprecated → 一个 major 版本后移除。本体应随使用"进化"而非只增不减（增量式 / 纠错式 / 重构式三种演化分开管理）；
- **度量驱动维护**：
  - 覆盖率：approved CQ / 总 CQ（目标逐季提升，当前约 30%）；
  - 命中率：Agent 回答中引用 approved 定义的比例；
  - 响亮失败率：解析失败中"本体覆盖不足"占比——这就是下一迭代的建模需求池；
  - 新鲜度：每个实体距上次数据验证的天数。

### 4.5 落地路线图（建议）

| 阶段 | 周期 | 关键动作 | 出口标准 |
|---|---|---|---|
| 0 治理奠基 | 2 周 | 指定各 domain owner；把 cq-list.md 的 draft/gap 转成决策单 backlog；建 PR 模板（必须声明 CQ） | 每个领域有 owner；backlog 排期 |
| 1 规则攻坚 | 4 周 | 集中批准 draft 项的口径（open/terminal、resolve-forward、long-runner 阈值、clock-stop 等约 10 条规则） | draft CQ 清零或显式 defer |
| 2 运行时集成 | 4–6 周 | 实现 3.1 架构：意图 JSON schema、本体校验层、确定性 SQL 编译、动态子图注入 | approved CQ 端到端可答；失败响亮 |
| 3 gap 建模 | 持续 | 按 backlog 为 gap CQ 建实体/指标（v2 semantic-kernel） | 覆盖率 ≥ 70% |
| 4 扩展与运营 | 持续 | 度量看板、季度评审、deprecated 清理、（可选）GraphRAG/Neo4j 语义层 | 覆盖率 ≥ 85%，命中率达标 |

---

## 5. 参考资料（调研来源）

1. Palantir Foundry — The Ontology System & Architecture Center（ontology = data+logic+action+security 四重整合；Language/Engine/Toolchain；Proposal 评审流；版本绑定）
2. Palantir 版本管理机制深度解读（53ai，2025-12）— Git-like 语义版本流
3. Atlan — Active Ontology Design for AI: A 2026 Enterprise Framework（五层模型；CQ 驱动五步；勿 boil the ocean）
4. Spire — Designing an Enterprise Ontology Without Boiling the Ocean（15–25 实体起步；决策驱动；证据驱动扩展）
5. Rebase HQ — Building Enterprise Knowledge Graph Architecture（四类信息：实体/关系/时序/策略；窄启动）
6. Emergent Mind — Enterprise Knowledge Graphs（T-Box/A-Box；七步构建管线；LLM 驱动本体构建）
7. dbt Developer Blog — Semantic Layer vs Text-to-SQL: 2026 Benchmark（语义层 98–100% vs 裸 SQL 84–90%，且确定性）
8. dataworkers.io — NL2SQL accuracy depends on semantic layer（无语义层 30–40%，有则 75–90%+）
9. data.world KG Benchmark（via colrows/dev.to）— 裸 SQL 16.7% → 语义图 54.2%
10. Neo4j — Semantic layer for Text-to-SQL agents（动态子图注入，token −20–30%，复杂问题 +10pp）
11. CoreOntology — Ontology Collaboration/Versioning 工具与演化类型（增量/纠错/重构）
12. Noy & McGuinness — Ontology Development 101（类-槽-面-实例的经典流程）
13. 本项目资产审计：`ontology/schema/*`、`ontology/v1/*`、`ontology/cq-list.md`、`ontology/generated/ontology.compiled.json`
