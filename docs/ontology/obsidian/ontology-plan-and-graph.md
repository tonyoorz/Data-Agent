# Data-Agent 企业/团队级 Ontology 建设计划与可视化

> 本文件供 Obsidian 打开查看。所有图表使用 Mermaid，Obsidian 原生支持渲染。
> 来源：基于全网 ontology/semantic layer/enterprise knowledge graph 研究 + Data-Agent 仓库现状分析。

---

## 一、核心结论

Data-Agent 已经具备一套**行业领先的语义控制平面雏形**：

- `ontology/v1`：19 实体、15 关系、22 维度、22 指标、37 条中文词汇
- `scripts/compileOntology.mjs` + JSON Schema + SHA-256 指纹
- Node/Python 双端 resolver、planner、scope policy、证据链
- 策略层：只读、强制 actor scope、脱敏、拒绝 draft/任意 SQL/超限

**下一步不是推倒重来，而是把它升级为「可治理、可演进、可产品化」的团队级本体。**

---

## 二、目标架构：三层 + 一执行内核

```mermaid
flowchart TB
    subgraph L3["L3 治理与策略层"]
        L3_1[policies]
        L3_2[constraints]
        L3_3[vocab]
        L3_4[approval state]
    end

    subgraph L2["L2 语义层"]
        L2_1[metrics]
        L2_2[dimensions]
    end

    subgraph L1["L1 领域本体层"]
        L1_1[entities]
        L1_2[relationships]
        L1_3[sources]
    end

    subgraph L0["L0 执行内核 Semantic Kernel"]
        L0_1[aggregate]
        L0_2[trend]
        L0_3[rank]
        L0_4[compare]
        L0_5[records]
        L0_6[traverse]
    end

    L3 --> L2
    L2 --> L1
    L1 --> L0
```

---

## 三、Ontology V1 实体关系图

> 虚线表示 `draft` 状态的关系；实线表示 `approved`。

```mermaid
flowchart LR
    quality_defect["缺陷\n(quality.defect)"]
    testing_test_case["测试用例\n(testing.test_case)"]
    testing_test_run["测试执行\n(testing.test_run)"]
    requirements_aida_node["AIDA 需求节点\n(requirements.aida_node)"]
    requirements_epic["Epic\n(requirements.epic)"]
    requirements_feature["Feature\n(requirements.feature)"]
    requirements_story["Story\n(requirements.story)"]
    product_project["项目\n(product.project)"]
    product_service_pack["Service Pack\n(product.service_pack)"]
    product_pu["PU\n(product.pu)"]
    product_i_step["I-Step\n(product.i_step)"]
    product_os["操作系统代际\n(product.os)"]
    product_platform["平台\n(product.platform)"]
    product_ecu["ECU/模块\n(product.ecu)"]
    vehicle_model_series["车型系列\n(vehicle.model_series)"]
    organization_team["团队\n(organization.team)"]
    organization_tester["测试人员\n(organization.tester)"]
    quality_qgate["质量门\n(quality.qgate)"]
    evidence_artifact["证据附件\n(evidence.artifact)"]

    testing_test_run -->|"executes"| testing_test_case
    testing_test_case -->|"validates"| requirements_aida_node
    requirements_aida_node -->|"parent_of"| requirements_aida_node
    testing_test_run -->|"traces_to"| requirements_feature
    testing_test_run -->|"traces_to"| requirements_story
    quality_defect -->|"detected_in"| testing_test_run
    quality_defect -->|"affects"| product_ecu
    quality_defect -->|"affects"| requirements_aida_node
    product_pu -->|"belongs_to"| product_service_pack
    product_i_step -->|"implements"| product_pu
    product_platform -->|"runs"| product_os
    vehicle_model_series -->|"uses"| product_platform
    organization_tester -->|"belongs_to"| organization_team
    quality_qgate -.->|"evaluates"| product_pu
    evidence_artifact -->|"supports"| quality_defect
```

---

## 四、现状差距（Gap）

```mermaid
quadrantChart
    title 差距优先级矩阵
    x-axis 影响小 --> 影响大
    y-axis 容易修复 --> 难以修复
    quadrant-1 优先攻克
    quadrant-2 重点规划
    quadrant-3 快速处理
    quadrant-4 延后观察
    "大量 draft 指标": [0.85, 0.75]
    "缺 CQ 清单": [0.80, 0.80]
    "实体只覆盖研发质量域": [0.60, 0.40]
    "时序/快照语义弱": [0.55, 0.30]
    "无本体可视化目录": [0.45, 0.85]
    "无语义漂移监控": [0.65, 0.35]
    "缺影响分析": [0.40, 0.50]
    "缺本体演进闭环": [0.50, 0.20]
```

---

## 五、8 周落地路线图

```mermaid
gantt
    title Data-Agent Ontology 建设 8 周路线
    dateFormat  YYYY-MM-DD
    section 基础
    W1 CQ 工作坊           :a1, 2026-07-21, 7d
    W2 draft 清理          :a2, after a1, 7d
    W3 本体可视化          :a3, after a2, 7d
    section 内核
    W4 v2 内核对齐         :a4, after a3, 7d
    W5 跨域扩展 POC        :a5, after a4, 7d
    section 治理
    W6 治理自动化          :a6, after a5, 7d
    W7 评测对齐            :a7, after a6, 7d
    W8 复盘与推广          :a8, after a7, 7d
```

| 周 | 里程碑 | 产出 |
|---|---|---|
| W1 | CQ 工作坊 | `ontology/cq-list.md` 定稿 |
| W2 | draft 清理 | 核心 10 指标 approved，其余挂决策单 |
| W3 | 本体可视化 | 编译器输出 Mermaid/目录页 |
| W4 | v2 内核对齐 | 六原语契约测试先行 |
| W5 | 跨域 POC | 选 1 新域建 3 实体 + 5 CQ |
| W6 | 治理自动化 | PR 模板 + draft 超期提醒 + 指纹影响报告 |
| W7 | 评测对齐 | 每 approved CQ ≥1 golden case |
| W8 | 复盘与推广 | 价值指标看板 |

---

## 六、关键反模式

```mermaid
mindmap
  root((企业 Ontology<br/>反模式))
    煮沸海洋
      第一天建模整个企业
    委员会式设计
      两年不出价值
    只建类不填数据
      没有实例填充的本体不是本体
    语义漂移
      业务定义变了本体没更新
    无消费者
      建了图没有应用依赖
    LLM 自由生成 SQL
      生产准确率 20-40%
    表达力陷阱
      过度 OWL 推理
```

---

## 七、相关文件

- `ontology/cq-list.md` — 35 条胜任问题（12 approved / 9 draft / 14 gap）
- `docs/ontology/team-ontology-playbook.md` — 完整 playbook
- `docs/main-agent-v2/ontology-v1.md` — V1 治理说明
- `docs/main-agent-v2/metric-decisions.md` — 指标决策清单
- `docs/superpowers/plans/2026-07-20-testing-quality-ontology-v2-semantic-kernel.md` — v2 执行计划

---

## 八、参考来源（已验证）

- [Frontiers in Big Data, 2025 — LLM-supported collaborative ontology design](https://www.frontiersin.org/journals/big-data/articles/10.3389/fdata.2025.1676477/full)
- [Improvado — Enterprise Knowledge Graph Guide 2026](https://improvado.io/blog/enterprise-knowledge-graph)
- [Atlan — Ontology vs Semantic Layer](https://atlan.com/know/ontology-vs-semantic-layer/)
- [Cube — Semantic Layer for AI Agents 2026](https://cube.dev/articles/semantic-layer-for-ai-agents-2026)
- [SurrealDB — Context layers, semantic layers, and knowledge graphs](https://surrealdb.com/blog/context-layers-semantic-layers-and-knowledge-graphs-the-modern-data-architecture-for-ai)
- [arXiv 2604.00555 — Ontology-Constrained Neural Reasoning in Enterprise Agentic Systems](https://arxiv.org/abs/2604.00555)
- [Palantir Foundry — Ontology Overview](https://www.palantir.com/docs/foundry/ontology/overview/)
- [PMC — Knowledge-graph best development practices for industry](https://pmc.ncbi.nlm.nih.gov/articles/PMC10038788/)
