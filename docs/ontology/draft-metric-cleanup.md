# Draft-Metric Cleanup Worklist（Ontology 治理 W2）

> 目标：把当前 14 个 `draft` 指标按依赖关系分波次评审为 `approved` / `deprecated`，解锁被它们卡住的 9 条 draft CQ。
> 输入来源：`ontology/v1/metrics.json`（owner/状态）、`docs/main-agent-v2/metric-decisions.md`（待决策项）、`ontology/cq-list.md`（业务依赖）、`server/ontology/resolver.mjs`（ambiguity 码）。
> 现状：22 指标中 **8 approved / 14 draft**（draft 占 64%）。planner 强制 `approvedOnly`，意味着 Agent 当前**只能用 8/22 指标**——这是本体"有效性"的最大单一瓶颈。

---

## 一、为什么这件事最优先

playbook §3.2 把"大量 draft 指标"列为🔴高优先级缺口。治理原则（data-centric + Palantir 式）：**没有被数据/决策填充的语义不算"已上线语义"**。draft 指标越多，Agent 的"受限表面"越小，越容易退化为自由生成。清理 draft = 直接扩大 Agent 的确定性可答范围。

---

## 二、分波次审批（按依赖排序）

> 规则：先批"口径定义"（count/outcome），再批"派生率"（rate，依赖口径的分母）；需要外部数据的密度指标最后批。

### Wave 1 — 结果口径定义（基础，必须先批）

| 指标 | Owner | 待决策（来自 metric-decisions.md） | ambiguity 码 | 解锁 CQ |
|------|-------|------|------|---------|
| `defect.open_count` | Quality Governance | 终态状态集合 + 快照点语义 | OPEN_STATUS_DEFINITION_UNAPPROVED | CQ-D-03, CQ-P-01 |
| `defect.resolved_count` | Quality Governance | resolved/closed 的精确 outcome/phase/status 映射 | RESOLVED_OUTCOME_DEFINITION_UNAPPROVED | CQ-D-04 |
| `defect.rejected_count` | Quality Governance | 拒绝结果映射 + 重开缺陷处理 | — | CQ-D-05 |
| `defect.age_days` | Quality Governance | clock-stop 规则、时区、未解决计算 | DEFECT_AGE_RULE_UNAPPROVED | CQ-D-08 |

**Wave 1 完成后**：缺陷结果状态机定型，Wave 2 的所有率类分母都有了依据。

### Wave 2 — 派生率（依赖 Wave 1 的口径）

| 指标 | Owner | 待决策 | ambiguity 码 | 解锁 CQ |
|------|-------|------|------|---------|
| `defect.resolve_rate` | Quality Governance | 分母 + cohort/window 语义 | RESOLUTION_RATE_DENOMINATOR_UNAPPROVED | CQ-D-04 |
| `defect.rejection_rate` | Quality Governance | 分母、事件时间、重开处理 | — | （暂无 CQ，可延后或直接 deprecated） |
| `testing.pass_rate` | Testing Governance | 纳入的 run 状态、重跑策略、分母 | TEST_RUN_DENOMINATOR_UNAPPROVED | CQ-T-03 |
| `testing.fail_rate` | Testing Governance | 同 pass_rate | TEST_RUN_DENOMINATOR_UNAPPROVED | CQ-T-04 |

### Wave 3 — 阈值 / 覆盖（需额外业务规则）

| 指标 | Owner | 待决策 | ambiguity 码 | 解锁 CQ |
|------|-------|------|------|---------|
| `defect.long_runner_count` | Quality Governance | age 阈值 + 合格缺陷状态 | LONG_RUNNER_THRESHOLD_UNAPPROVED | CQ-D-07 |
| `defect.repeat_rate` | Quality Governance | 重复关联来源 + 分母 | — | （暂无 CQ） |
| `testing.requirement_coverage_rate` | Requirements Governance | 需求总体、追溯深度、waived 项 | COVERAGE_POPULATION_UNAPPROVED | CQ-TR-01 |
| `testing.traceability_rate` | Requirements Governance | 有效关系类型 + 分母 | — | （gap CQ-TR-03/04 相关） |
| `team.discovery_efficiency` | Quality Governance | 公式 + 归因窗口 | DISCOVERY_EFFICIENCY_FORMULA_UNAPPROVED | CQ-O-03 |

### Wave 4 — 需外部数据源（最难，单独排期）

| 指标 | Owner | 待决策 | ambiguity 码 | 解锁 CQ |
|------|-------|------|------|---------|
| `quality.defect_density` | Quality Governance | 需 approved 的 size/exposure 分母；**绝不臆造** | DEFECT_DENSITY_DENOMINATOR_REQUIRED | CQ-P-03 |

`defect_density` 需要一个独立的"暴露量/规模"数据源（代码行、功能点、车辆数等），决策前**不得**让 planner 退回 `defect.count`。

---

## 三、审批检查清单（每条 draft 批准前必须逐项确认）

对每个即将从 `draft → approved` 的指标，Owner 在 PR 中确认以下 6 项（任一未定则保持 draft）：

- [ ] **grain**：聚合粒度（单缺陷/单 run/单团队·周）已写明
- [ ] **numerator / denominator**：分子分母的字段与口径已明确（率类尤其）
- [ ] **defaultTimeDimension**：默认事件时间字段已指定（创建时间 vs 解决时间 vs 完成时间）
- [ ] **missingDataPolicy**：缺失数据处理（null 计 0 / 跳过 / 报错）已定
- [ ] **source revision**：对应的 `sources.json` readModel 已 approved 且 freshness SLO 合理
- [ ] **ambiguity 清除**：resolver 中对应 `ambiguityForMetric` 的 ambiguity 码可移除（或保留为治理提示）

---

## 四、每条 draft 对应的 CQ 依赖（反查表）

清理 draft 的业务价值用 CQ 衡量，而非指标数量（playbook 治理原则）：

| Draft 指标 | 卡住的 CQ | CQ 业务问题（摘录） |
|-----------|----------|---------------------|
| `defect.open_count` | CQ-D-03, CQ-P-01 | 当前未关闭缺陷按严重程度分 / 某 Project 未关闭缺陷按 ECU |
| `defect.resolve_rate` | CQ-D-04, CQ-P-02 | 某 PU 缺陷解决率趋势 / 某 Release 测试通过率趋势 |
| `defect.rejected_count` | CQ-D-05 | 被拒绝缺陷按发现团队分 |
| `defect.long_runner_count` | CQ-D-07 | 长期未解决缺陷按 ECU |
| `defect.age_days` | CQ-D-08 | 缺陷从创建到关闭平均天数 |
| `testing.pass_rate` | CQ-T-03 | 某 PU 测试通过率 |
| `testing.fail_rate` | CQ-T-04 | 失败率最高的团队 |
| `testing.requirement_coverage_rate` | CQ-TR-01 | 多少 AIDA 需求已被测试覆盖 |
| `team.discovery_efficiency` | CQ-O-03 | 哪个团队缺陷发现效率最高 |
| `quality.defect_density` | CQ-P-03 | 某 SP 下各 PU 缺陷密度 |
| `defect.rejection_rate` / `repeat_rate` / `traceability_rate` | （暂无 draft CQ） | 评估是否直接 deprecated，避免维护无人消费的语义 |

**收益估算**：完成 Wave 1+2（6 个指标）即可解锁 7 条 draft CQ → approved CQ 从 12 → 19（占 35 条的 54%）。

---

## 五、落地动作

1. **本周**：Quality Governance / Testing Governance / Requirements Governance 三个 Owner 各自认领 Wave，按波次排评审会。
2. **每个指标**：走 PR 修改 `metrics.json` 的 `governance.status: draft → approved`，PR 描述粘贴本清单第三节检查清单的勾选结果；若涉及 ambiguity，同步清理 `resolver.mjs` 的 `ambiguityForMetric`。
3. **门禁**：`npm run ontology:compile && ontology:check && test:ontology` 必须全绿（指纹变更会自动反映在编译产物中）。
4. **每月**：从 `semantic_resolver_unmatched` telemetry（本次新增）导出高频未命中概念，反哺是否需要新建指标/词表——形成"使用→演进"闭环。
5. **deprecated 路径**：无人消费的 draft 指标（如 rejection_rate 若确认不做）直接改 `deprecated` 并在 changelog 记录，不要长期挂 draft。
