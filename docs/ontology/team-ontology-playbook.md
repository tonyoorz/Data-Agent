# 企业 / 团队级 Ontology 建设方案（面向 Data-Agent）

> 目标读者：Data-Agent 团队及业务干系人
> 版本：v2（2026-07-21，基于全网检索调研重写）
> 依据：本体工程学术方法论 + 企业知识图谱行业实践 + 2025–2026 Agent 语义层最新研究 + 本仓库 `ontology/v1` 与 v2 semantic-kernel 计划现状分析

---

## 一、结论先行

你的 Data-Agent 已经具备一套**教科书级的「语义控制平面」雏形**（`ontology/v1` + 编译器 + 加载器强校验 + 确定性 planner），方向与 2026 年行业共识（semantic-layer-grounded agents）完全一致。要把它做成「企业内团队内有效的 ontology」，关键不是再建一套新本体，而是：

1. **把现有文件升级为真正的「领域本体 + 语义层 + 治理策略」三层结构**（v2 semantic-kernel 计划正在做执行层）；
2. **补齐「本体工程方法论」**：以胜任问题（Competency Questions, CQ）驱动、SME 参与、迭代式演进；
3. **建立轻量但强制的治理闭环**：Owner 到人、审批态（draft→approved→deprecated）、指纹化变更、回归评测、防止语义漂移；
4. **让本体成为 LLM Agent 的「接地（grounding）层」**：resolver 只认本体、拒绝任意 SQL、证据可溯源——这点你已经做到，继续保持并产品化。

---

## 二、全网知识综述：四个知识域的共识

### 2.1 本体工程方法论（学术 25 年沉淀）

主流方法论高度趋同，生命周期都是 **specification → conceptualization → implementation → evaluation**：

| 方法论 | 要点 | 适用 |
|--------|------|------|
| **Ontology 101**（Noy & McGuinness, Stanford） | 七步：定领域范围 → 复用现有本体 → 枚举术语 → 定义类与层级 → 定义属性 → 定义约束 → 建实例。首次提出用**胜任问题（CQ）**界定范围 | 快速上手、团队首次建模 |
| **METHONTOLOGY** | 最成熟，基于 IEEE 1074 软件开发生命周期，覆盖规格→维护全流程 | 需要完整生命周期管理 |
| **NeOn** | 9 种场景，强调**复用与重构**已有本体/非本体资源，协作式 | 有存量词表/数据模型可复用 |
| **XD（eXtreme Design）** | 敏捷式，用本体设计模式（ODP）增量迭代 | 快速演进中的 Agent 项目 |
| **UPON Lite** | 业务专家主导：词典→术语表→分类层级→属性→整体部分关系→形式化；用在线表格协作，本体工程师只在最后介入 | **SME 驱动，最适合你的团队场景** |

**CQ（胜任问题）是各方法论的最大公约数**。一项 2023 年针对本体工程师的调查（63 人）显示：92.1% 通过与领域专家访谈定义 CQ，63.5% 迭代式地定义并在开发中持续修正，71.4% 先用用户语言写 CQ 再逐步靠近本体概念 [来源: Use of Competency Questions in Ontology Engineering 综述]。

**对你的启示**：不要从「我们有哪些表」出发，而要从「Agent 必须能回答哪些问题」出发；CQ 用业务语言写、迭代维护。

### 2.2 本体设计学派（Semantic Arts 分类）

| 学派 | 特点 | 最佳实践 |
|------|------|---------|
| Standards 学派 | 复用 W3C/行业标凈本体（DCAT、Prov-O、Dublin Core、FHIR） | 标准本体要模块化、小而完整；企业本体尽量 import 而非重定义 |
| Linked Open Data 学派 | 百万级实例、共享 IRI、owl:sameAs 实体解析 | 只在自己控制的命名空间下断言 |
| **Data-Centric 学派**（推荐） | 「没有被实例数据填充的本体不是本体」；装载+查询的反馈环验证模型 | 企业本体**类数通常 <500**；慎用 inverse/transitive 属性；分类归属用 Category 实例而非新建类；用 gist 等轻量上位本体 |

**对你的启示**：你的 19 实体 / 15 关系规模完全符合 data-centric 最佳实践（小而可填充）；不要陷入 OWL 推理机的表达力陷阱，你的「编译器 + JSON Schema + 指纹」路线比 RDF/OWL 栈更适合 Agent 运行时。

### 2.3 企业知识图谱落地实践（行业共识）

跨来源高度一致的结论：

1. **从窄域开始**：初始本体限 5–8 个实体类型、10–15 个关系类型、3–5 个数据源、1–2 个高价值问题，90 天内出 demo [来源: Improvado EKG 指南；d.AP 平台方法论]。
2. **失败模式首位是「语义漂移」（semantic drift）**：业务定义变了而本体没更新，图谱沦为历史文物。对策：季度本体评审、人类可读术语表、语义版本化 + changelog、查询分布突变自动告警 [来源: Improvado]。
3. **组织设计**：命名 ontology product owner（按「指标争议减少量」考核，而非按术语数量）、域 steward（SME 验证语义）、薄平台团队 [来源: d.AP]。
4. **渐进扩张路径**：base ontology → domain extensions → use-case ontologies，避免「big ontology upfront」陷阱。
5. **价值衡量**：答题周期缩短、BI 工单减少、自助率、准确率——而不是节点数。

**Palantir 模式专门值得对照**：Foundry 的 Ontology 不是学术本体，而是「企业决策层」——Object Types（业务对象）+ Link Types（关系）+ **Action Types（可执行的写回动作，带规则与权限）**，AIP Agent 在 Ontology 之上获得确定性上下文而非自由生成 [来源: Palantir Foundry 官方文档及社区解析]。你的 `entities/relationships + policies/constraints + allowedOperations` 已经是这个结构的简化版；**Action 层（写回/操作）是你目前刻意不做、但长期值得规划的差异点**。

### 2.4 Agent 时代的语义层研究（2025–2026 最新，与本项目最相关）

这是对你最重要的知识域，核心结论：

1. **裸 text-to-SQL 在生产环境准确率仅 20–40%**（BIRD/Spider 2.0 基准），而语义层接地后可提升至 65–88% 甚至接近确定性 [来源: dataworkers.io 汇总表；dbt Labs 2026 基准；bayani.ai]。
2. **Google 的研究显示用语义层接地 LLM 查询准确率提升 66%**；Atlan AI Labs 在 174 条查询上测得治理元数据上下文带来 38% 准确率提升（p < 0.0001）；知识图谱增强的 RAG 幻觉率降低约 40% [来源: Atlan, dataworkers.io]。
3. **语义层赢在三个性质**：确定性编译（同一指标同一 SQL）、受限表面（LLM 从有限指标/维度集合中选择，幻觉不存在表成为不可能）、治理内建（定义在版本控制中、PR 评审）[来源: humaineeti.ai, Cube]。
4. **交付模式趋同**：metrics as code → 行级策略编译进查询 → 通过 **MCP（Model Context Protocol）** 暴露给 Agent → 预聚合缓存。dbt/Cube/AtScale 均已提供 MCP server；**Open Semantic Interchange (OSI) v1.0**（Snowflake/Databricks/AtScale/Salesforce 发起，2026-01）定义了跨工具指标定义交换格式 [来源: checkthat.ai 2026 调研]。
5. **前沿——神经符号本体接地**：FAOS 架构（arXiv 2604.00555）展示了完整蓝图：三层本体注入（Role + Domain + Interaction）、基于领域层级的本体约束工具发现、输出侧本体合规校验（术语保真度/指标区间/法规引用/角色一致性四个量化指标）、以及**本体从 Agent 经验中演进**的闭环（发现→提议→专家审批→带溯源合入）[来源: arXiv 2604.00555]。
6. **LLM 协同本体设计**：2025 年 Frontiers 研究显示 LLM 可显著加速协作本体工程，但 SME 评审仍不可省略。

**一句话总结全网共识**：*2026 年，本体/语义层已从「数据治理文档」变成「AI Agent 的运行时控制平面」——这正是你的架构。*

---

## 三、你的现状：已经领先，但有明确短板

### 3.1 现状盘点（`ontology/v1`，实测数据）

| 文件 | 实测内容 | 评价 |
|------|------|------|
| `entities.json` | 19 个实体，带 i18n labels、别名、source 映射、主键、敏感度、allowedOperations、governance | ✅ 规范，符合 data-centric 小规模原则 |
| `relationships.json` | 15 条谓词关系，带方向、基数、可逆性、join 路径 | ✅ 支持多跳推理 |
| `metrics.json` | 22 个指标，带口径、grain、默认时间维、允许维度、missingDataPolicy、能力位、审批态 | ✅ 语义层核心 |
| `dimensions.json` | 22 个维度，带事件时间语义、时区 | ✅ |
| `vocab.zh-CN.json` | 37 条中文术语→本体元素的确定性解析 | ✅ 接地关键 |
| `sources.json` | 6 个来源，带 readModel、revisionStrategy、freshnessSloMinutes | ✅ 溯源与新鲜度已建模 |
| `policies.json` / `constraints.json` | 强制 actor scope、只读、脱敏；查询上限 200、只用已审批指标、禁任意 SQL、Claim/Evidence 覆盖 | ✅ 治理已代码化——多数企业做不到这一点 |
| `schema/*.schema.json` + `scripts/compileOntology.mjs` | 每源文件有 JSON Schema；编译器做交叉引用校验，输出编译产物 + SHA-256 指纹 | ✅ 工程化到位 |
| `server/ontology/`（9 个模块） | registry/resolver/semanticFrame/queryPlanner/queryCompiler/validator/scopePolicy/fingerprint | ✅ Palantir 式运行时控制平面 |
| `docs/superpowers/plans/2026-07-20-...ontology-v2-semantic-kernel.md` | 12 任务 v2 计划：aggregate/trend/rank/compare/records/traversal 六原语 + 单快照传播 + 证据链 | ✅ 执行层方向正确 |

**架构判断**：LLM 输出只是候选，编译后的本体 + actor 策略 + 确定性 planner 决定什么能执行——这正是 FAOS 论文和 Palantir AIP 描述的企业级形态。

### 3.2 当前短板（Gap）

| 短板 | 风险 | 优先级 |
|------|------|--------|
| **① 缺「胜任问题」清单** | 本体范围没有显式业务契约，容易膨胀或漏关键问题 | 🔴 高 |
| **② 大量指标/实体仍是 `draft`** | Agent 实际可用语义很少（planner 拒绝 draft） | 🔴 高 |
| **③ 实体只覆盖研发质量域（Octane/QGate）** | 无「客户/项目/交付」等，无法支撑跨业务问答 | 🟡 中 |
| **④ 时序/快照语义弱** | 只有 creation/resolution 事件时间，缺 as-of 点查、慢变维 | 🟡 中（v2 快照机制部分缓解） |
| **⑤ 无本体可视化/目录** | SME 无法直观浏览，参与门槛高 | 🟡 中 |
| **⑥ 无语义漂移监控** | 行业失败模式首位：查询分布突变无人察觉 | 🟡 中 |
| **⑦ 缺影响分析** | 改指标口径，不知道影响哪些看板/Agent/评测 | 🟢 低 |
| **⑧ 本体不会从使用中学习** | 用户问的新概念没有「发现→提议→审批→合入」通道 | 🟢 低（FAOS 式闭环，长期） |

---

## 四、目标架构：团队本体的三层 + 一个执行内核

```
┌─────────────────────────────────────────────────────────────┐
│  L3 治理与策略层 (Governance & Policy)                       │
│  policies / constraints / vocab / approval state            │
│  → 谁能看什么、能算什么、Agent 能执行什么                     │
├─────────────────────────────────────────────────────────────┤
│  L2 语义层 (Semantic / Metric Layer)                         │
│  metrics / dimensions                                       │
│  → 指标口径、粒度、时间语义、允许维度 = 可计算的业务语言      │
├─────────────────────────────────────────────────────────────┤
│  L1 领域本体层 (Domain Ontology)                             │
│  entities / relationships / sources                         │
│  → 业务对象、属性、关系、物理来源映射                         │
├─────────────────────────────────────────────────────────────┤
│  L0 执行内核 (Semantic Kernel, v2 计划中)                    │
│  六原语 aggregate/trend/rank/compare/records/traverse       │
│  + 单快照传播 + 证据链 = 本体从「文档」变成「运行时」         │
└─────────────────────────────────────────────────────────────┘
```

- L1 对齐 Palantir Object/Link 与 data-centric 学派；每个实体必须有 CQ 作为存在理由。
- L2 对齐 dbt/Cube 语义层与 OSI 可交换格式（保留未来导出 OSI YAML 的可能）。
- L3 是你最强的一层，产品化它。
- L0 对应 v2 semantic-kernel 计划，是全行业 2026 年的标准答案（确定性原语而非自由 SQL）。

---

## 五、建设流程：CQ 驱动的六步闭环（融合 UPON Lite + XD）

### Step 1 定义胜任问题（1 周）
召集 SME（质量/测试/需求/产品各 1 人）+ Agent 工程师，用**业务语言**列出 20–30 个 Agent 必须能答的问题，例如：
- 「上周 DTSV 团队新建了多少个严重缺陷？」
- 「某 PU 的测试通过率趋势如何？」
- 「哪些 AIDA 需求没有测试用例覆盖？」

每条 CQ 标注：涉及实体、指标、维度、时间范围、敏感级别、提问角色。CQ 清单进 `ontology/cq-list.md` 版本管理。

### Step 2 本体建模（迭代，每周评审）
- 用 CQ 反推实体与关系，**只建模能回答 CQ 的部分**（data-centric：能被数据填充才建模）；
- 命名沿用 `domain.entity` 规范；类总数保持克制（企业级 <500，团队级 <50）；
- 关系必须显式声明基数与 join 路径（你已在做）；慎用 inverse/transitive；
- 顶层对齐可复用 Dublin Core / schema.org / PROV-O 概念，避免造轮子。

### Step 3 语义层定义
- 每个指标写清 `measure`/`grain`/`defaultTimeDimension`/`allowedDimensions`/`missingDataPolicy`；
- 所有指标从 `draft` 开始，Owner 评审后才 `approved`；
- 口径变更进 `metric-decisions.md`（你已有）。

### Step 4 装载与映射
- `sources.json` 声明 readModel/表映射；快照策略与新鲜度 SLO 显式化；
- 「装载 + 查询的反馈环」验证模型——跑真实数据回答 CQ，而不是评审 PPT。

### Step 5 评估与接地验证
- 每条 CQ ≥1 个 semantic golden 用例（接入 `semantic-golden:check`）；
- 验证 resolver 确定性映射、planner 拒绝 draft/任意 SQL/超限；
- 参考 FAOS 的四指标量化：术语保真度、指标区间合法性、范围合规、证据覆盖率。

### Step 6 发布与演进
- `ontology:compile && ontology:check && test:ontology` 作为合并门禁；
- 指纹变更 = 兼容性边界，自动生成影响报告；
- **每季度本体评审会**（行业反语义漂移标准做法）：新增 CQ、处理 draft 积压、deprecated 下线、检查查询分布异常。

---

## 六、治理机制：轻量但强制

| 机制 | 现状 | 建议强化 |
|------|------|---------|
| **Owner** | 每个元素有 `governance.owner` | 明确到人；ontology product owner 按「指标争议减少量」考核 |
| **审批态** | draft / approved | 增加 deprecated；draft 超 30 天自动提醒 |
| **Schema 校验** | JSON Schema + 编译器交叉引用 | 保持；实例侧用 golden case 代替重型 SHACL |
| **版本与指纹** | SHA-256 指纹 | 加语义化 `CHANGELOG`；指纹变更自动生成影响报告 |
| **溯源** | source/readModel/freshness 已声明 | 每条 Evidence 强制携带 fingerprint + source revision（v2 已规划） |
| **访问控制** | actor.scope.mandatory + 脱敏 | 扩展到指标级权限 |
| **语义漂移监控** | 无 | 查询分布突变告警（如「活跃缺陷数」环比 -40% 触发语义复核） |
| **本体演进闭环** | 无 | resolver 记录 unmapped 高频概念 → 定期提议 → SME 审批 → 合入（FAOS 模式） |

---

## 七、落地路线（8 周）

| 周 | 里程碑 | 产出 |
|----|--------|------|
| W1 | 胜任问题工作坊 | `ontology/cq-list.md`（20–30 条 CQ） |
| W2 | draft 清理 | 核心 10 个指标 approved，其余挂决策单 |
| W3 | 本体可视化 | 编译器输出 Mermaid 实体关系图 + 内部目录页 |
| W4 | v2 内核对齐 | 六原语契约测试先行（按计划 Task 1–2） |
| W5 | 跨域扩展 POC | 选 1 个新域（如「项目交付」）建 3 个实体 + 5 条 CQ |
| W6 | 治理自动化 | PR 模板 + draft 超期提醒 + 指纹影响报告 + 漂移告警 |
| W7 | 评测对齐 | 每 CQ ≥1 golden case 接入 CI |
| W8 | 复盘与推广 | 价值指标看板（答题时长/自助率/准确率/争议次数） |

---

## 八、关键反模式（务必避免）

1. **煮沸海洋 / big ontology upfront**：第一天建模整个企业 → 从 CQ 反推最小可用本体。
2. **委员会式设计**：两年建模不出价值 → 模型「刚好够用」，边跑边扩。
3. **只建类不填数据**：没被实例填充的本体不是本体 → 装载+查询反馈环验证。
4. **语义漂移无人管**：业务定义变了本体没变 → 季度评审 + 分布告警 + changelog。
5. **无消费者**：建了图没有应用依赖 → Data-Agent 就是消费者，保持强耦合。
6. **让 LLM 自由生成 SQL**：生产准确率 20–40% → 受限原语 + 确定性编译（你已在做）。
7. **表达力陷阱**：过度使用 OWL 推理/inverse/transitive → 你的 JSON Schema + 编译器路线更务实。

---

## 九、给 Data-Agent 的具体下一步（可立即执行）

1. **本周**：新建 `ontology/cq-list.md`，把 19 实体/22 指标反写成 CQ，找出无 CQ 支撑的（候选下线）和 CQ 无本体支撑的（候选新建）。
2. **本周**：把全部 `draft` 指标拉清单、指定 Owner，两周内评审为 approved/deprecated。
3. **下周**：给 `compileOntology.mjs` 加 `--emit-graph`，输出 Mermaid 实体关系图到 `docs/ontology/graph.md`。
4. **下周**：暴露 `list_approved_metrics()` API，让前端/Agent 动态展示「当前可问什么」。
5. **持续**：resolver 增加 unmapped-concept 日志，每月导出作为本体演进输入。

---

## 十、参考资料（本次检索实际来源）

**本体工程方法论**
- Noy & McGuinness, *Ontology Development 101*（Stanford）；METHONTOLOGY；NeOn；XD；UPON Lite 综述 — Frontiers in Big Data (2025): https://www.frontiersin.org/journals/big-data/articles/10.3389/fdata.2025.1676477/full
- *Use of Competency Questions in Ontology Engineering: A Survey* (2023): https://www.inf.ufes.br/~monalessa/wp-content/papercite-data/pdf/use_of_competency_questions_in_ontology_engineering__a_survey_2023.pdf
- Applied Ontology 开发六实践 — KaDSci: https://kadsci.com/applied-ontology-development/
- 本体设计学派（Standards/LOD/Data-Centric + gist）— Semantic Arts: https://www.semanticarts.com/the-data-centric-revolution-best-practices-and-schools-of-ontology-design/

**企业知识图谱实践**
- Improvado, *Enterprise Knowledge Graph: Architecture & Use Cases 2026*: https://improvado.io/blog/enterprise-knowledge-graph
- d.AP, *Best Enterprise Knowledge Graph Platforms 2026*: https://www.digetiers-dap.com/post/best-enterprise-knowledge-graph-platforms
- PMC, *Knowledge-graph best development practices for industry*: https://pmc.ncbi.nlm.nih.gov/articles/PMC10038788/
- Palantir Foundry 文档（Object/Link/Action Types, AIP）及中文解析: https://www.cnblogs.com/jarryli/p/19983103

**Agent 语义层（2025–2026）**
- Atlan, *Ontology vs Semantic Layer*: https://atlan.com/know/ontology-vs-semantic-layer/
- dataworkers.io, *Semantic Layer vs Context Layer / Text-to-SQL Accuracy*: https://dataworkers.io/resources/context-layer-vs-semantic-layer/
- Cube, *Semantic Layer for AI Agents (2026)*: https://cube.dev/articles/semantic-layer-for-ai-agents-2026
- SurrealDB, *Context layers, semantic layers, and knowledge graphs*: https://surrealdb.com/blog/context-layers-semantic-layers-and-knowledge-graphs-the-modern-data-architecture-for-ai
- FAOS 神经符号企业 Agent 本体接地 — arXiv 2604.00555: https://arxiv.org/pdf/2604.00555
- Headless BI / MCP / Open Semantic Interchange 调研 — checkthat.ai: https://checkthat.ai/answers/what-are-the-best-headless-bi-solutions

**本仓库**
- `ontology/v1/*`、`docs/main-agent-v2/ontology-v1.md`、`docs/main-agent-v2/metric-decisions.md`、`docs/superpowers/plans/2026-07-20-testing-quality-ontology-v2-semantic-kernel.md`
