# Data-Agent Ontology 胜任问题清单（Competency Questions）

> 目标：用业务语言显式定义 Data-Agent 必须能回答的问题，作为 `ontology/v1` 升级和 v2 semantic-kernel 的业务契约。
> 方法：从现有 19 实体 / 22 指标反推；标注支持状态；找出无 CQ 支撑的实体/指标（候选下线）和无本体支撑的 CQ（候选新建）。

## 使用说明

- 每条 CQ 用**业务语言**书写，避免技术字段名。
- `status`：
  - `approved` — 有已批准的实体、指标、维度可回答；
  - `draft` — 依赖 draft 指标或待决策的业务规则；
  - `gap` — 当前本体/数据无法直接回答，需要新建实体、指标或源。
- 工作坊流程：SME 逐条确认 → 修改措辞 → 补充缺失 CQ → 把 `draft` 和 `gap` 转成本周决策单。

---

## 一、缺陷管理（Defect Management）

| ID | 业务问题 | 实体 | 指标 | 维度/过滤 | 时间 | 范围 | 状态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| CQ-D-01 | 上周 DTSV 团队新提交了多少个缺陷？ | `quality.defect` | `defect.created_count` | `org.problem_finder_team = DTSV_China` | 上周 | DTSV | approved | |
| CQ-D-02 | 本月各 PU 的新增缺陷数是多少？ | `quality.defect`, `product.pu` | `defect.created_count` | `product.pu` | 本月 | 全部 | approved | |
| CQ-D-03 | 当前未关闭的缺陷有多少？按严重程度分 | `quality.defect` | `defect.open_count` | `quality.severity` | 快照 | 全部 | draft | 需批准 "open/terminal" 定义 |
| CQ-D-04 | 某 PU 的缺陷解决率趋势如何？ | `quality.defect`, `product.pu` | `defect.resolve_rate` | `product.pu` | 近 4 周 | 全部 | draft | 需批准 resolved-forward 规则 |
| CQ-D-05 | 被拒绝的缺陷有多少？按发现团队分 | `quality.defect` | `defect.rejected_count` | `org.problem_finder_team` | 本月 | 全部 | draft | 需批准直接拒绝规则 |
| CQ-D-06 | 当前严重/致命缺陷有多少？ | `quality.defect` | `defect.critical_active_count` | `quality.severity` | 快照 | 全部 | gap | v2 计划中的指标 |
| CQ-D-07 | 长期未解决的缺陷（老缺陷）有多少？按 ECU 分 | `quality.defect`, `product.ecu` | `defect.long_runner_count` | `product.ecu` | 快照 | 全部 | draft | 需批准 long-runner 阈值 |
| CQ-D-08 | 某缺陷从创建到关闭平均用了多少天？ | `quality.defect` | `defect.age_days` | — | 本季 | 全部 | draft | 需批准 clock-stop 规则 |
| CQ-D-09 | 哪些缺陷是重开的？ | `quality.defect` | `defect.reopen_count` | — | 本月 | 全部 | gap | v2 计划中的指标 |
| CQ-D-10 | Top Issue（重点问题）有哪些？ | `quality.defect` | `defect.top_issue_count` | `quality.severity`, `age_days` | 快照 | 全部 | gap | v2 分析产品 |

## 二、测试管理（Test Management）

| ID | 业务问题 | 实体 | 指标 | 维度/过滤 | 时间 | 范围 | 状态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| CQ-T-01 | 上周完成了多少个 Manual Run？ | `testing.test_run` | `testing.run_count` | — | 上周 | 全部 | approved | |
| CQ-T-02 | 上周通过的测试执行有多少？按执行团队分 | `testing.test_run` | `testing.passed_run_count` | `org.team` | 上周 | 全部 | approved | |
| CQ-T-03 | 某 PU 的测试通过率是多少？ | `testing.test_run`, `product.pu` | `testing.pass_rate` | `product.pu` | 近 4 周 | 全部 | draft | 需批准分母定义 |
| CQ-T-04 | 失败率最高的团队是哪个？ | `testing.test_run`, `organization.team` | `testing.fail_rate` | `org.team` | 本月 | 全部 | draft | 同上 |
| CQ-T-05 | 有多少测试用例还没有执行过？ | `testing.test_case`, `testing.test_run` | `testing.unexecuted_testcase_count` | — | 快照 | 全部 | gap | v2 计划中的指标 |
| CQ-T-06 | 各项目/Release 的测试执行覆盖率是多少？ | `testing.test_case`, `product.project`, `product.release` | `testing.testcase_execution_coverage_rate` | `product.project`, `product.release` | 快照 | 全部 | gap | v2 计划中的指标 |
| CQ-T-07 | 平均每个 Manual Run 耗时多久？ | `testing.test_run` | `testing.run_duration_avg_hours` | — | 本月 | 全部 | gap | v2 计划中的指标 |

## 三、可追溯性与需求（Traceability）

| ID | 业务问题 | 实体 | 指标 | 维度/过滤 | 时间 | 范围 | 状态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| CQ-TR-01 | 有多少 AIDA 需求已被测试用例覆盖？ | `requirements.aida_node`, `testing.test_case` | `traceability.requirement_coverage_rate` | `requirements.aida` | 快照 | 全部 | draft | 需批准需求总体定义 |
| CQ-TR-02 | 有多少测试用例未关联需求？ | `testing.test_case` | `traceability.orphan_testcase_count` | `testing.trace_status = Untraced` | 快照 | 全部 | gap | v2 计划中的指标 |
| CQ-TR-03 | 哪些需求有端到端的 test-run 链路？ | `requirements.aida_node`, `testing.test_case`, `testing.test_run` | `traceability.end_to_end_chain_rate` | `requirements.aida` | 快照 | 全部 | gap | v2 计划中的指标 |
| CQ-TR-04 | 失效的追溯链接有多少？ | `traceability.link` | `traceability.broken_link_count` | — | 快照 | 全部 | gap | v2 计划中的指标 |
| CQ-TR-05 | 某 Feature 下有多少 Story 有测试覆盖？ | `requirements.feature`, `requirements.story`, `testing.test_case` | `traceability.requirement_coverage_rate` | `requirements.feature` | 快照 | 全部 | gap | 需确认 Feature/Story 数据源 |

## 四、团队与组织（Organization）

| ID | 业务问题 | 实体 | 指标 | 维度/过滤 | 时间 | 范围 | 状态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| CQ-O-01 | 各问题发现团队本月发现了多少缺陷？ | `quality.defect`, `organization.team` | `team.defect_discovery_count` | `org.problem_finder_team` | 本月 | 全部 | approved | |
| CQ-O-02 | 各测试团队上周执行了多少 Manual Run？ | `testing.test_run`, `organization.team` | `team.execution_count` | `org.team` | 上周 | 全部 | approved | |
| CQ-O-03 | 哪个团队的缺陷发现效率最高？ | `organization.team` | `team.discovery_efficiency` | `org.team` | 本季 | 全部 | draft | 需批准公式和归因窗口 |
| CQ-O-04 | 活跃测试人员有多少？按团队分 | `testing.test_run`, `organization.tester`, `organization.team` | `testing.active_tester_count` | `org.team` | 本月 | 全部 | gap | 注意 tester 为 confidential |

## 五、产品与项目上下文（Product & Project）

| ID | 业务问题 | 实体 | 指标 | 维度/过滤 | 时间 | 范围 | 状态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| CQ-P-01 | 某 Project 当前未关闭缺陷按 ECU 分布？ | `quality.defect`, `product.project`, `product.ecu` | `defect.open_count` | `product.project`, `product.ecu` | 快照 | 该 Project | draft | 依赖 CQ-D-03 定义 |
| CQ-P-02 | 某 Release 的测试通过率趋势如何？ | `testing.test_run`, `product.release` | `testing.pass_rate` | `product.release` | 近 4 周 | 该 Release | draft | 依赖 CQ-T-03 定义 |
| CQ-P-03 | 某 Service Pack 下各 PU 的缺陷密度是多少？ | `quality.defect`, `product.service_pack`, `product.pu` | `quality.defect_density` | `product.service_pack`, `product.pu` | 本月 | 全部 | draft | 需批准 exposure 分母 |
| CQ-P-04 | 不同 OS/Platform 的缺陷分布如何？ | `quality.defect`, `product.os`, `product.platform` | `defect.count` | `product.os`, `product.platform` | 本月 | 全部 | approved | |
| CQ-P-05 | 不同车型系列的缺陷数是多少？ | `quality.defect`, `vehicle.model_series` | `defect.count` | `vehicle.model_series` | 本月 | 全部 | approved | |

## 六、周报与综合分析（Quality Intelligence）

| ID | 业务问题 | 实体 | 指标 | 维度/过滤 | 时间 | 范围 | 状态 | 备注 |
|---|---|---|---|---|---|---|---|---|
| CQ-QI-01 | 本周缺陷流入、流出、净变化是多少？ | `quality.defect` | `quality.weekly_defect_inflow`, `quality.weekly_defect_outflow`, `quality.weekly_net_defect_change` | — | 本周 | 全部 | gap | v2 分析产品 |
| CQ-QI-02 | 本周缺陷增长最快的模块是哪些？ | `quality.defect` | `defect.created_count` | `product.business_module` | 本周 vs 上周 | 全部 | gap | 需处理 "模块" 歧义 |
| CQ-QI-03 | 当前高风险缺陷的清单和负责人？ | `quality.defect`, `organization.person` | `defect.top_issue_count` | severity, age | 快照 | 全部 | gap | v2 Top Issue 产品 |
| CQ-QI-04 | 每百个已完成测试执行对应多少个缺陷？ | `quality.defect`, `testing.test_run` | `quality.defects_per_100_completed_runs` | — | 本月 | 全部 | gap | v2 跨域指标 |

---

## 统计与行动

- **approved**：12 条 — 可直接接入 golden case 和演示。
- **draft**：9 条 — 需 Owner 在两周内评审为 approved/deprecated，对应 `docs/main-agent-v2/metric-decisions.md`。
- **gap**：14 条 — 需要 v2 semantic-kernel 或新增实体/指标/源支持。

### 下一步（本周）

1. 召集质量/测试/需求/产品 SME，逐条确认以上 CQ 的措辞、时间窗口、敏感级别。
2. 把 `draft` 状态的 CQ 对应到具体 metric-decision owner，排期评审。
3. 把 `gap` 状态的 CQ 拆分到 v2 semantic-kernel 计划（`docs/superpowers/plans/2026-07-20-testing-quality-ontology-v2-semantic-kernel.md`）的 12 个任务中。
4. 为每条 approved CQ 编写至少 1 个 semantic golden case，接入 `npm run semantic-golden:check`。
