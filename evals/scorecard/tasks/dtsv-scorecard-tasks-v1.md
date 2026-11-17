# DTSV 智能问数 Agent 评分卡任务库（v1）

> 生成时间：2026-08-17T10:08:38.451584+00:00  ·  任务数：**88**（满足 60–100 区间）

> 落盘：`evals/scorecard/tasks/dtsv-scorecard-tasks-v1.json`（机器可读）

> 数据来源：真实本体 `ontology/v1`（31 指标 / 51 维度）+ 真实测试用例 `testcase/dtsv_testcases_R-22-02.json`（DTSV_China / R-22-02）+ 运行指标 `evals/scorecard/metrics.mjs`


## 一、六维评分标准（定义 / 取值范围 / 评分）

| 维度 | 定义 | 取值范围 | 关键评分标准 |
|------|------|----------|--------------|
| **准确率 accuracy** | 答案与 golden 在值/单位/粒度/时间窗/过滤上一致；SQL/语义计划可执行 | ratio 0–1 | 1.00 全对；0.85–0.99 次要差异；0.70–0.84 口径偏差；0.40–0.69 计算错；0.10–0.39 严重错；0.00 幻觉 |
| **策略 strategy** | 规划/推理复杂度与策略恰当度（消歧/多跳/聚合/时序/澄清/编排） | ordinal 1–5 | 1 单跳；2 单实体多过滤；3 跨实体多跳；4 时序/对比/澄清；5 复合分解规划 |
| **证据 evidence** | 可程序化校验的引用链（语义计划/SQL、行级来源、ontology 版本、snapshot） | ordinal 1–5 | 1 无需；2 来源系统名；3 指标 id+维度；4 行级 id+citation pass；5 完整证据包+citation pass |
| **恢复 recovery** | 歧义/空结果/超时/限流/拒绝/schema 不匹配的自愈 | ordinal 1–5 | 1 直路；2 空结果兜底；3 澄清/fallback；4 重试退避熔断；5 多步恢复+审计留痕 |
| **延迟 latency** | 端到端响应耗时（含 LLM+工具） | 秒（p50/p95/max） | L1≤4s / L2≤8s / L3≤15s 为达标，超出按比例扣分 |
| **成本 cost** | 单次 LLM token 与折算 ¥（BMW 内部端点估算） | token / ¥ | L1≤3000tok/¥0.006 / L2≤6000/¥0.012 / L3≤12000/¥0.024 为达标 |

> 评分口径与 `evals/scorecard/metrics.mjs` 六运行指标对齐：evidence≈citation_pass_rate，recovery≈recovery_success_rate，latency≈latency_ms，accuracy/strategy/cost 为任务级预期目标。

## 二、任务分布

- 难度：L1=15，L2=36，L3=37
- 领域：
  - 缺陷度量查询：12
  - 缺陷根因分析：8
  - 测试覆盖率：9
  - 测试执行与通过率：9
  - 供应商与团队质量：9
  - 时间序列与趋势：8
  - 可追溯性：9
  - 多跳关系推理：8
  - 异常检测与恢复：8
  - 报告与可视化叙事：8

## 三、完整任务表（80 条）

| # | ID | 领域 | 难度 | 意图 | 自然语言任务 | 期望工具 | 准确率目标 | 策略等级 | 证据要求 | 恢复要求 | 延迟预算(s) | 成本预算(¥) |
|---|----|------|------|------|--------------|----------|-----------|----------|----------|----------|-------------|-------------|
| 001 | DTSV-001 | 缺陷度量查询 | L1 | metric_query | 本发布 R-22-02 中国区新建了多少个缺陷？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 002 | DTSV-002 | 缺陷度量查询 | L1 | metric_query | 当前还有几个未关闭(open)缺陷？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 003 | DTSV-003 | 缺陷度量查询 | L2 | metric_query | R-22-02 中严重(severe)缺陷有多少个？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 004 | DTSV-004 | 缺陷度量查询 | L2 | metric_query | Showstopper 缺陷数量是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 005 | DTSV-005 | 缺陷度量查询 | L2 | metric_query | R-22-02 的缺陷解决率是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 006 | DTSV-006 | 缺陷度量查询 | L3 | metric_query | R-22-02 相较 R-22-01，严重缺陷数变化了多少？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 3 | 15 | 0.024 |
| 007 | DTSV-007 | 缺陷度量查询 | L2 | metric_query | 按严重程度(severity)分布，各等级缺陷数是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 008 | DTSV-008 | 缺陷度量查询 | L3 | metric_query | 本月新建缺陷中，属于 solution_cluster='DiPS' 的比例是多少？ | query_semantic_metrics, resolve_business_terms | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 009 | DTSV-009 | 缺陷根因分析 | L2 | high_frequency | 哪些 defect_category 出现频率最高（Top 5）？ | query_defect_high_frequency_analysis | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 010 | DTSV-010 | 缺陷根因分析 | L2 | metric_query | 重复缺陷率(repeat_rate)是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 011 | DTSV-011 | 缺陷根因分析 | L3 | business_risk_assessment | 长期未解决(long_runner)缺陷有哪些，按年龄排序前 10？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 3 | 15 | 0.024 |
| 012 | DTSV-012 | 缺陷根因分析 | L3 | business_risk_assessment | 识别 R-22-02 中高 risk_score 且未关闭的缺陷，给出根因聚类。 | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 013 | DTSV-013 | 缺陷根因分析 | L2 | metric_query | 缺陷拒绝率(rejection_rate)与 CWA 拒收率(kpi.defect_rejection_rate)差异？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 014 | DTSV-014 | 缺陷根因分析 | L3 | business_risk_assessment | 哪些 PU 的缺陷密度(defect_density)最高？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 4 | 4 | 15 | 0.024 |
| 015 | DTSV-015 | 缺陷根因分析 | L2 | metric_query | Top Issue 缺陷数是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 016 | DTSV-016 | 缺陷根因分析 | L3 | business_risk_assessment | 对比 R-22-01 与 R-22-02 的缺陷类别分布漂移。 | query_defect_high_frequency_analysis, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 017 | DTSV-017 | 测试覆盖率 | L1 | coverage_query | R-22-02 整体需求覆盖率(requirement_coverage_rate)是多少？ | query_testing_coverage_project_status | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 018 | DTSV-018 | 测试覆盖率 | L2 | coverage_query | AIDA 功能覆盖率(kpi.function_coverage)是多少？ | query_testing_coverage_aida_status | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 019 | DTSV-019 | 测试覆盖率 | L2 | coverage_query | 回归测试覆盖率(kpi.regression_coverage)是多少？ | query_testing_coverage_project_status | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 020 | DTSV-020 | 测试覆盖率 | L2 | coverage_query | 配置覆盖率（车型, kpi.config_coverage_models）是多少？ | query_testing_coverage_project_status | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 021 | DTSV-021 | 测试覆盖率 | L3 | coverage_query | 哪些 AIDA 需求尚未被任何测试用例覆盖（覆盖缺口）？ | query_traceability, query_testing_coverage_aida_status | 0.9 | 3 | 5 | 4 | 15 | 0.024 |
| 022 | DTSV-022 | 测试覆盖率 | L2 | coverage_query | 按车型系列(model_series)维度，各车型的覆盖率差异？ | query_testing_coverage_project_status | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 023 | DTSV-023 | 测试覆盖率 | L3 | coverage_query | SET_23-03 下各功能组(function_group)的覆盖率如何？ | query_testing_coverage_project_status, query_analytics | 0.9 | 3 | 5 | 4 | 15 | 0.024 |
| 024 | DTSV-024 | 测试覆盖率 | L1 | coverage_query | 当前项目共有多少个测试用例？ | query_testing_coverage_project_status | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 025 | DTSV-025 | 测试执行与通过率 | L1 | metric_query | 本月测试通过率(pass_rate)是多少？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 026 | DTSV-026 | 测试执行与通过率 | L2 | metric_query | R-22-02 失败测试执行数(failed_run_count)是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 027 | DTSV-027 | 测试执行与通过率 | L2 | metric_query | 按测试域(testing.domain)的通过率对比？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 028 | DTSV-028 | 测试执行与通过率 | L3 | metric_query | 某车型系列下失败率最高的测试项 Top 10？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 029 | DTSV-029 | 测试执行与通过率 | L2 | metric_query | 测试执行总数与通过/失败/阻塞分布？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 030 | DTSV-030 | 测试执行与通过率 | L3 | metric_query | 按测试周(time.test_week)的通过率趋势？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 031 | DTSV-031 | 测试执行与通过率 | L2 | metric_query | 可追溯率(traceability_rate)是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 032 | DTSV-032 | 测试执行与通过率 | L3 | metric_query | 对比 DV 与 PV 阶段的测试通过率差异？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 033 | DTSV-033 | 供应商与团队质量 | L2 | business_risk_assessment | 各执行团队(org.team)的缺陷发现效率如何排名？ | query_semantic_metrics, query_analytics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 034 | DTSV-034 | 供应商与团队质量 | L2 | business_risk_assessment | 问题发现团队(problem_finder_team)发现缺陷 Top 排名？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 035 | DTSV-035 | 供应商与团队质量 | L3 | business_risk_assessment | 供应商相关 PU 的缺陷检测率(DDP, kpi.defect_detection_ratio)是否达标(≥0.85)？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 036 | DTSV-036 | 供应商与团队质量 | L3 | business_risk_assessment | 哪个 team 的 open 缺陷最多且年龄最长（综合风险最高）？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 037 | DTSV-037 | 供应商与团队质量 | L2 | business_risk_assessment | 团队测试执行数(team.execution_count)排名？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 038 | DTSV-038 | 供应商与团队质量 | L3 | business_risk_assessment | 跨团队的缺陷泄漏（在后期 phase 才被发现）分析？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 039 | DTSV-039 | 供应商与团队质量 | L2 | business_risk_assessment | China Scope=Y 的缺陷占比是多少？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 040 | DTSV-040 | 供应商与团队质量 | L3 | business_risk_assessment | ECU/模块(product.ecu)维度的缺陷密度排名？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 4 | 4 | 15 | 0.024 |
| 041 | DTSV-041 | 时间序列与趋势 | L2 | metric_query | 最近 8 周新建缺陷数趋势？ | query_semantic_metrics, query_analytics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 042 | DTSV-042 | 时间序列与趋势 | L3 | metric_query | 缺陷解决时长(defect.age_days)的月度中位数趋势？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 043 | DTSV-043 | 时间序列与趋势 | L2 | metric_query | 本月 vs 上月缺陷解决率(resolve_rate)环比？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 044 | DTSV-044 | 时间序列与趋势 | L3 | metric_query | 缺陷创建到解决时长按 severity 分布的对比？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 045 | DTSV-045 | 时间序列与趋势 | L2 | metric_query | 今年各月测试通过率趋势？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 046 | DTSV-046 | 时间序列与趋势 | L3 | metric_query | 识别缺陷数异常的周（超过均值+2σ）？ | query_semantic_metrics, query_analytics | 0.9 | 4 | 4 | 4 | 15 | 0.024 |
| 047 | DTSV-047 | 时间序列与趋势 | L2 | metric_query | Release 维度的缺陷数演进？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 048 | DTSV-048 | 时间序列与趋势 | L3 | metric_query | 基于近 6 月趋势外推，预测下月严重缺陷数（标注不确定性）？ | query_semantic_metrics, query_analytics | 0.8 | 5 | 5 | 4 | 15 | 0.024 |
| 049 | DTSV-049 | 可追溯性 | L1 | testcase_context | 测试项 532211 的上下文是什么？ | get_test_case_context | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 050 | DTSV-050 | 可追溯性 | L2 | record_query | 缺陷 920669 关联到哪些特性(feature)与故事(story)？ | query_traceability, query_semantic_records | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 051 | DTSV-051 | 可追溯性 | L2 | record_query | AIDA 需求 aida_id 的需求追溯状态(trace_status)？ | query_traceability, query_semantic_records | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 052 | DTSV-052 | 可追溯性 | L3 | record_query | 从 story 892994 反向追溯其下所有缺陷？ | query_traceability, query_semantic_records | 0.9 | 3 | 5 | 4 | 15 | 0.024 |
| 053 | DTSV-053 | 可追溯性 | L2 | record_query | 测试项 532211 的 run 状态分布？ | query_semantic_records, get_test_case_context | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 054 | DTSV-054 | 可追溯性 | L3 | coverage_query | 配置覆盖率（硬件变体, kpi.config_coverage_variants）缺口分析？ | query_testing_coverage_project_status, query_analytics | 0.9 | 3 | 5 | 4 | 15 | 0.024 |
| 055 | DTSV-055 | 可追溯性 | L2 | record_query | 成熟度等级(maturity_grade, RG)分布？ | query_semantic_records | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 056 | DTSV-056 | 可追溯性 | L3 | record_query | Q-Gate 类型(qgate_type)各阶段的通过情况？ | query_semantic_records, query_analytics | 0.9 | 3 | 5 | 4 | 15 | 0.024 |
| 057 | DTSV-057 | 多跳关系推理 | L3 | testcase_context | IDC23 自动服务呼叫相关测试项失败，根因缺陷属于哪个 PU/ECU？ | query_traceability, query_semantic_metrics, query_analytics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 058 | DTSV-058 | 多跳关系推理 | L3 | testcase_context | HU-MGU 故事下所有测试项的失败率？ | query_traceability, query_semantic_metrics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 059 | DTSV-059 | 多跳关系推理 | L3 | record_query | feature 896016 下缺陷的严重程度分布与解决状态？ | query_traceability, query_semantic_metrics | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 060 | DTSV-060 | 多跳关系推理 | L3 | record_query | 找出既影响 DV 又影响 PV 阶段的同一缺陷（父子关系）？ | query_traceability, query_semantic_records | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 061 | DTSV-061 | 多跳关系推理 | L2 | record_query | 缺陷类别为 DiPS 的缺陷集中在哪些车型？ | query_semantic_metrics, query_analytics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 062 | DTSV-062 | 多跳关系推理 | L3 | record_query | 跨 release 同一 solution_cluster 的复发缺陷？ | query_traceability, query_semantic_records | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 063 | DTSV-063 | 多跳关系推理 | L3 | record_query | 从 ECU 反查相关测试用例与需求覆盖？ | query_traceability, query_testing_coverage_aida_status | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 064 | DTSV-064 | 多跳关系推理 | L2 | duplicate_search | 检测与缺陷 920669 重复的缺陷（search_duplicates）？ | search_duplicates | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 065 | DTSV-065 | 异常检测与恢复 | L2 | dashboard_fallback | 当 dashboard 底层数据为空时，agent 应如何兜底？ | diagnose_analytics_empty, query_full_picture_module | 0.95 | 3 | 3 | 4 | 8 | 0.012 |
| 066 | DTSV-066 | 异常检测与恢复 | L3 | dashboard_fallback | 上游 analytics 不可用时，能否切换到 fallback 并完成查询？ | query_analytics, query_analytics_fallback | 0.9 | 4 | 4 | 5 | 15 | 0.024 |
| 067 | DTSV-067 | 异常检测与恢复 | L3 | dashboard_fallback | query 返回空结果时，agent 是否主动澄清或给出全貌？ | diagnose_analytics_empty, query_full_picture_module | 0.9 | 4 | 3 | 3 | 15 | 0.024 |
| 068 | DTSV-068 | 异常检测与恢复 | L2 | high_frequency | 检测到严重缺陷突增时，应给出怎样的告警话术？ | query_defect_high_frequency_analysis | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 069 | DTSV-069 | 异常检测与恢复 | L3 | metric_query | 歧义 query（『上个月的数据』跨 release 上下文）能否澄清？ | ask_clarification, resolve_business_terms | 0.9 | 4 | 2 | 3 | 15 | 0.024 |
| 070 | DTSV-070 | 异常检测与恢复 | L3 | metric_query | actor scope 拒绝访问时，返回 denied 而非内部报错？ | query_analytics | 0.98 | 4 | 2 | 5 | 15 | 0.024 |
| 071 | DTSV-071 | 异常检测与恢复 | L2 | metric_query | 工具超时后是否重试并恢复结果？ | query_analytics, query_analytics_fallback | 0.95 | 3 | 4 | 4 | 8 | 0.012 |
| 072 | DTSV-072 | 异常检测与恢复 | L3 | dashboard_fallback | 多步工具编排中一步失败，能否回退并仍给出部分答案？ | query_semantic_metrics, query_analytics, query_analytics_fallback | 0.9 | 4 | 4 | 5 | 15 | 0.024 |
| 073 | DTSV-073 | 报告与可视化叙事 | L2 | metric_query | 生成 R-22-02 质量周报的 KPI 摘要？ | query_semantic_metrics, query_testing_coverage_project_status | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 074 | DTSV-074 | 报告与可视化叙事 | L3 | metric_query | 用图表展示各 severity 缺陷分布（kpi/line/bar）？ | query_semantic_metrics, analysisPlanner | 0.9 | 4 | 4 | 4 | 12 | 0.024 |
| 075 | DTSV-075 | 报告与可视化叙事 | L3 | metric_query | 给出缺陷趋势的洞察叙述，并标注异常点？ | query_semantic_metrics, query_analytics | 0.9 | 5 | 5 | 4 | 15 | 0.024 |
| 076 | DTSV-076 | 报告与可视化叙事 | L2 | business_risk_assessment | 对比两个团队的质量评分卡？ | query_semantic_metrics, query_analytics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 077 | DTSV-077 | 报告与可视化叙事 | L3 | coverage_query | 输出可分享的覆盖率差距报告（含证据链接）？ | query_testing_coverage_aida_status, query_traceability | 0.9 | 4 | 5 | 4 | 15 | 0.024 |
| 078 | DTSV-078 | 报告与可视化叙事 | L2 | metric_query | 按市场(market)维度拆分缺陷？ | query_semantic_metrics | 0.95 | 3 | 4 | 3 | 8 | 0.012 |
| 079 | DTSV-079 | 报告与可视化叙事 | L3 | metric_query | 综合多 KPI 的健康度评分（0–100）？ | query_semantic_metrics, query_analytics, analysisPlanner | 0.9 | 5 | 5 | 4 | 15 | 0.024 |
| 080 | DTSV-080 | 报告与可视化叙事 | L1 | general | 闲聊/越界问题（如『今天天气如何』）应被正确路由，不触发数据查询？ | ask_clarification | 0.98 | 1 | 1 | 1 | 2 | 0.003 |
| 081 | DTSV-081 | 缺陷度量查询 | L1 | metric_query | 本月新建缺陷数是多少（不限 release）？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 082 | DTSV-082 | 缺陷度量查询 | L1 | metric_query | 当前缺陷总数(defect.count)是多少？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 083 | DTSV-083 | 缺陷度量查询 | L1 | metric_query | 缺陷状态为 Blocked 的有多少个？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 084 | DTSV-084 | 缺陷度量查询 | L1 | metric_query | R-22-02 的缺陷拒绝数(rejected_count)是多少？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 085 | DTSV-085 | 测试执行与通过率 | L1 | metric_query | R-22-02 的测试执行总数(run_count)是多少？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 086 | DTSV-086 | 测试覆盖率 | L1 | coverage_query | SET_23-03 的需求覆盖率是多少？ | query_testing_coverage_project_status | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 087 | DTSV-087 | 可追溯性 | L1 | testcase_context | 测试项 690490 的测试结果是什么？ | get_test_case_context | 0.97 | 1 | 3 | 2 | 4 | 0.006 |
| 088 | DTSV-088 | 供应商与团队质量 | L1 | business_risk_assessment | 本执行团队(org.team)本月的测试执行数？ | query_semantic_metrics | 0.97 | 1 | 3 | 2 | 4 | 0.006 |

## 四、每个任务的 gold 提示与验证方法

### DTSV-001 · 本发布 R-22-02 中国区新建了多少个缺陷？
- **领域/难度/意图**：缺陷度量查询 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.created_count WHERE detected_in_release='R-22-02' AND china_scope='Y'
- **验证方法**：返回值==golden count（±0 容差，整数）；evidence 含执行的指标 id
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#defect.created_count; ontology/v1/dimensions.json#quality.china_scope; ontology/v1/dimensions.json#product.release

### DTSV-002 · 当前还有几个未关闭(open)缺陷？
- **领域/难度/意图**：缺陷度量查询 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.open_count WHERE status='Open'
- **验证方法**：返回值==golden；断言 status 过滤生效
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#defect.open_count; ontology/v1/dimensions.json#quality.status

### DTSV-003 · R-22-02 中严重(severe)缺陷有多少个？
- **领域/难度/意图**：缺陷度量查询 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.severe_count WHERE detected_in_release='R-22-02' AND severity 严重
- **验证方法**：返回值==golden；断言 severity 维度过滤正确
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.severe_count; ontology/v1/dimensions.json#quality.severity

### DTSV-004 · Showstopper 缺陷数量是多少？
- **领域/难度/意图**：缺陷度量查询 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.showstopper_count WHERE detected_in_release='R-22-02'
- **验证方法**：返回值==golden；Showstopper 为 severity 最高级
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.showstopper_count; ontology/v1/dimensions.json#quality.severity

### DTSV-005 · R-22-02 的缺陷解决率是多少？
- **领域/难度/意图**：缺陷度量查询 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.resolve_rate = resolved_count/created_count（比率，0–1）
- **验证方法**：比值误差≤0.02；evidence 含分子分母来源
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.resolve_rate; ontology/v1/metrics.json#defect.resolved_count

### DTSV-006 · R-22-02 相较 R-22-01，严重缺陷数变化了多少？
- **领域/难度/意图**：缺陷度量查询 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：Δ = severe(R-22-02) − severe(R-22-01)，需两次 release 查询后相减
- **验证方法**：差值符号与量级正确；evidence 含两次 release 的行级来源
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=3 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#defect.severe_count; ontology/v1/dimensions.json#product.release

### DTSV-007 · 按严重程度(severity)分布，各等级缺陷数是多少？
- **领域/难度/意图**：缺陷度量查询 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：GROUP BY quality.severity 返回各等级计数
- **验证方法**：各桶计数之和==总缺陷数；维度枚举完整
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#quality.severity; ontology/v1/dimensions.json#quality.phase_enum

### DTSV-008 · 本月新建缺陷中，属于 solution_cluster='DiPS' 的比例是多少？
- **领域/难度/意图**：缺陷度量查询 / L3 / metric_query
- **期望工具**：query_semantic_metrics, resolve_business_terms
- **gold 提示**：ratio = count(solution_cluster='DiPS') / created_count，本月窗
- **验证方法**：比率误差≤0.03；solution_cluster 消歧正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#defect.created_count; ontology/v1/dimensions.json#quality.solution_cluster

### DTSV-009 · 哪些 defect_category 出现频率最高（Top 5）？
- **领域/难度/意图**：缺陷根因分析 / L2 / high_frequency
- **期望工具**：query_defect_high_frequency_analysis
- **gold 提示**：按 defect_category 计数降序取前 5
- **验证方法**：Top5 集合与 golden 一致（顺序允许并列）；evidence 含计数
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#quality.defect_category; server/ontology/queryPlanner.mjs

### DTSV-010 · 重复缺陷率(repeat_rate)是多少？
- **领域/难度/意图**：缺陷根因分析 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.repeat_rate = repeat_count / total
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.repeat_rate

### DTSV-011 · 长期未解决(long_runner)缺陷有哪些，按年龄排序前 10？
- **领域/难度/意图**：缺陷根因分析 / L3 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：defect.long_runner_count + defect.age_days 降序 Top10（defect_id 列表）
- **验证方法**：返回 defect_id 列表与 age_days；行级来源可追溯
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=3 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#defect.long_runner_count; ontology/v1/metrics.json#defect.age_days

### DTSV-012 · 识别 R-22-02 中高 risk_score 且未关闭的缺陷，给出根因聚类。
- **领域/难度/意图**：缺陷根因分析 / L3 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：WHERE risk_score 高 AND status='Open' GROUP BY solution_cluster
- **验证方法**：聚类集合与 golden 一致；evidence 含 defect_id + solution_cluster
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/entities.json#risk_score; ontology/v1/dimensions.json#quality.solution_cluster

### DTSV-013 · 缺陷拒绝率(rejection_rate)与 CWA 拒收率(kpi.defect_rejection_rate)差异？
- **领域/难度/意图**：缺陷根因分析 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：对比 defect.rejection_rate 与 kpi.defect_rejection_rate 两值
- **验证方法**：两值各自误差≤0.02，差异表述正确
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.rejection_rate; ontology/v1/metrics.json#kpi.defect_rejection_rate

### DTSV-014 · 哪些 PU 的缺陷密度(defect_density)最高？
- **领域/难度/意图**：缺陷根因分析 / L3 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：quality.defect_density GROUP BY product.pu 降序
- **验证方法**：PU 排名与 golden 一致；密度计算口径正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=4 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#quality.defect_density; ontology/v1/dimensions.json#product.pu

### DTSV-015 · Top Issue 缺陷数是多少？
- **领域/难度/意图**：缺陷根因分析 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.top_issue_count WHERE detected_in_release='R-22-02'
- **验证方法**：返回值==golden
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.top_issue_count

### DTSV-016 · 对比 R-22-01 与 R-22-02 的缺陷类别分布漂移。
- **领域/难度/意图**：缺陷根因分析 / L3 / business_risk_assessment
- **期望工具**：query_defect_high_frequency_analysis, query_analytics
- **gold 提示**：两 release 的 defect_category 分布，计算 KL/Δ
- **验证方法**：分布集合一致；漂移方向与量级正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#quality.defect_category; ontology/v1/dimensions.json#product.release

### DTSV-017 · R-22-02 整体需求覆盖率(requirement_coverage_rate)是多少？
- **领域/难度/意图**：测试覆盖率 / L1 / coverage_query
- **期望工具**：query_testing_coverage_project_status
- **gold 提示**：testing.requirement_coverage_rate WHERE release='R-22-02'
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#testing.requirement_coverage_rate

### DTSV-018 · AIDA 功能覆盖率(kpi.function_coverage)是多少？
- **领域/难度/意图**：测试覆盖率 / L2 / coverage_query
- **期望工具**：query_testing_coverage_aida_status
- **gold 提示**：kpi.function_coverage = covered_aida / total_aida
- **验证方法**：比率误差≤0.02；evidence 含 aida 维度
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#kpi.function_coverage; ontology/v1/dimensions.json#requirements.aida

### DTSV-019 · 回归测试覆盖率(kpi.regression_coverage)是多少？
- **领域/难度/意图**：测试覆盖率 / L2 / coverage_query
- **期望工具**：query_testing_coverage_project_status
- **gold 提示**：kpi.regression_coverage
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#kpi.regression_coverage

### DTSV-020 · 配置覆盖率（车型, kpi.config_coverage_models）是多少？
- **领域/难度/意图**：测试覆盖率 / L2 / coverage_query
- **期望工具**：query_testing_coverage_project_status
- **gold 提示**：kpi.config_coverage_models
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#kpi.config_coverage_models; ontology/v1/dimensions.json#vehicle.model_series

### DTSV-021 · 哪些 AIDA 需求尚未被任何测试用例覆盖（覆盖缺口）？
- **领域/难度/意图**：测试覆盖率 / L3 / coverage_query
- **期望工具**：query_traceability, query_testing_coverage_aida_status
- **gold 提示**：AIDA 需求 − 已关联 testcase 的 AIDA，返回缺口列表
- **验证方法**：缺口集合与 golden 一致；多跳可追溯
- **六维目标**：acc=0.9 | strategy=3 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#requirements.aida; ontology/v1/metrics.json#testing.traceability_rate

### DTSV-022 · 按车型系列(model_series)维度，各车型的覆盖率差异？
- **领域/难度/意图**：测试覆盖率 / L2 / coverage_query
- **期望工具**：query_testing_coverage_project_status
- **gold 提示**：GROUP BY vehicle.model_series 返回覆盖率
- **验证方法**：各车型覆盖率误差≤0.03
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#vehicle.model_series

### DTSV-023 · SET_23-03 下各功能组(function_group)的覆盖率如何？
- **领域/难度/意图**：测试覆盖率 / L3 / coverage_query
- **期望工具**：query_testing_coverage_project_status, query_analytics
- **gold 提示**：WHERE project='SET_23-03' GROUP BY quality.function_group
- **验证方法**：功能组集合正确；覆盖率误差≤0.03
- **六维目标**：acc=0.9 | strategy=3 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#quality.function_group; ontology/v1/dimensions.json#product.project

### DTSV-024 · 当前项目共有多少个测试用例？
- **领域/难度/意图**：测试覆盖率 / L1 / coverage_query
- **期望工具**：query_testing_coverage_project_status
- **gold 提示**：testing.testcase_count WHERE release='R-22-02'
- **验证方法**：返回值==golden 整数
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#testing.testcase_count

### DTSV-025 · 本月测试通过率(pass_rate)是多少？
- **领域/难度/意图**：测试执行与通过率 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：testing.pass_rate = passed_run_count / run_count
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#testing.pass_rate

### DTSV-026 · R-22-02 失败测试执行数(failed_run_count)是多少？
- **领域/难度/意图**：测试执行与通过率 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：testing.failed_run_count WHERE release='R-22-02'
- **验证方法**：返回值==golden
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#testing.failed_run_count

### DTSV-027 · 按测试域(testing.domain)的通过率对比？
- **领域/难度/意图**：测试执行与通过率 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：GROUP BY testing.domain 返回 pass_rate
- **验证方法**：各域通过率误差≤0.03
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#testing.domain; ontology/v1/metrics.json#testing.pass_rate

### DTSV-028 · 某车型系列下失败率最高的测试项 Top 10？
- **领域/难度/意图**：测试执行与通过率 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：WHERE vehicle.model_series=X GROUP BY testcase ORDER BY fail_rate DESC Top10
- **验证方法**：Top10 集合与 golden 一致；行级 test_id 可追溯
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#vehicle.model_series; ontology/v1/metrics.json#testing.fail_rate

### DTSV-029 · 测试执行总数与通过/失败/阻塞分布？
- **领域/难度/意图**：测试执行与通过率 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：testing.run_count + run_status 分布(Passed/Failed/Blocked)
- **验证方法**：分布之和==run_count
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#testing.run_count; ontology/v1/dimensions.json#testing.run_status

### DTSV-030 · 按测试周(time.test_week)的通过率趋势？
- **领域/难度/意图**：测试执行与通过率 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：GROUP BY time.test_week 返回 pass_rate 序列
- **验证方法**：序列长度与周数一致；趋势方向正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#time.test_week; ontology/v1/metrics.json#testing.pass_rate

### DTSV-031 · 可追溯率(traceability_rate)是多少？
- **领域/难度/意图**：测试执行与通过率 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：testing.traceability_rate
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#testing.traceability_rate

### DTSV-032 · 对比 DV 与 PV 阶段的测试通过率差异？
- **领域/难度/意图**：测试执行与通过率 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：pass_rate WHERE testing.test_phase='DV' vs 'PV'
- **验证方法**：两阶段值误差≤0.02，差异表述正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#testing.test_phase; ontology/v1/metrics.json#testing.pass_rate

### DTSV-033 · 各执行团队(org.team)的缺陷发现效率如何排名？
- **领域/难度/意图**：供应商与团队质量 / L2 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：team.discovery_efficiency GROUP BY org.team 降序
- **验证方法**：排名与 golden 一致；口径正确
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#team.discovery_efficiency; ontology/v1/dimensions.json#org.team

### DTSV-034 · 问题发现团队(problem_finder_team)发现缺陷 Top 排名？
- **领域/难度/意图**：供应商与团队质量 / L2 / business_risk_assessment
- **期望工具**：query_semantic_metrics
- **gold 提示**：team.defect_discovery_count GROUP BY org.problem_finder_team
- **验证方法**：排名与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#team.defect_discovery_count; ontology/v1/dimensions.json#org.problem_finder_team

### DTSV-035 · 供应商相关 PU 的缺陷检测率(DDP, kpi.defect_detection_ratio)是否达标(≥0.85)？
- **领域/难度/意图**：供应商与团队质量 / L3 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：kpi.defect_detection_ratio GROUP BY product.pu，与阈值 0.85 比较
- **验证方法**：每 PU 达标判定正确；evidence 含阈值比较依据
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#kpi.defect_detection_ratio; ontology/v1/dimensions.json#product.pu

### DTSV-036 · 哪个 team 的 open 缺陷最多且年龄最长（综合风险最高）？
- **领域/难度/意图**：供应商与团队质量 / L3 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：聚合 team.execution_count/open 缺陷数/age_days 求风险最高团队
- **验证方法**：选中团队与 golden 一致；多指标聚合正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#org.team; ontology/v1/metrics.json#defect.age_days

### DTSV-037 · 团队测试执行数(team.execution_count)排名？
- **领域/难度/意图**：供应商与团队质量 / L2 / business_risk_assessment
- **期望工具**：query_semantic_metrics
- **gold 提示**：team.execution_count GROUP BY org.team 降序
- **验证方法**：排名与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#team.execution_count

### DTSV-038 · 跨团队的缺陷泄漏（在后期 phase 才被发现）分析？
- **领域/难度/意图**：供应商与团队质量 / L3 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：缺陷按 detected phase 分布，识别'早期发现应捕获却后期才发现'的泄漏
- **验证方法**：泄漏判定与 golden 一致；phase 维度正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#quality.phase; ontology/v1/dimensions.json#quality.phase_enum

### DTSV-039 · China Scope=Y 的缺陷占比是多少？
- **领域/难度/意图**：供应商与团队质量 / L2 / business_risk_assessment
- **期望工具**：query_semantic_metrics
- **gold 提示**：ratio = count(china_scope='Y') / total
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#quality.china_scope

### DTSV-040 · ECU/模块(product.ecu)维度的缺陷密度排名？
- **领域/难度/意图**：供应商与团队质量 / L3 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：quality.defect_density GROUP BY product.ecu 降序
- **验证方法**：ECU 排名与 golden 一致
- **六维目标**：acc=0.9 | strategy=4 | evidence=4 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#quality.defect_density; ontology/v1/dimensions.json#product.ecu

### DTSV-041 · 最近 8 周新建缺陷数趋势？
- **领域/难度/意图**：时间序列与趋势 / L2 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：defect.created_count GROUP BY week(creation_date) 最近 8 周
- **验证方法**：序列长度==8；每周值误差≤2
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.created_count; ontology/v1/dimensions.json#time.defect_creation_date

### DTSV-042 · 缺陷解决时长(defect.age_days)的月度中位数趋势？
- **领域/难度/意图**：时间序列与趋势 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：median(age_days) GROUP BY month(resolution_date)
- **验证方法**：中位数序列正确；时序方向合理
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#defect.age_days; ontology/v1/dimensions.json#time.defect_resolution_date

### DTSV-043 · 本月 vs 上月缺陷解决率(resolve_rate)环比？
- **领域/难度/意图**：时间序列与趋势 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：Δ = resolve_rate(本月) − resolve_rate(上月)
- **验证方法**：差值符号与量级正确
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.resolve_rate; ontology/v1/dimensions.json#time.defect_resolution_date

### DTSV-044 · 缺陷创建到解决时长按 severity 分布的对比？
- **领域/难度/意图**：时间序列与趋势 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：age_days 分组统计 by quality.severity（均值/中位数）
- **验证方法**：各 severity 统计与 golden 一致
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#defect.age_days; ontology/v1/dimensions.json#quality.severity

### DTSV-045 · 今年各月测试通过率趋势？
- **领域/难度/意图**：时间序列与趋势 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：testing.pass_rate GROUP BY month(test_finished_date)
- **验证方法**：序列与月份数一致；趋势方向正确
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#testing.pass_rate; ontology/v1/dimensions.json#time.test_finished_date

### DTSV-046 · 识别缺陷数异常的周（超过均值+2σ）？
- **领域/难度/意图**：时间序列与趋势 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：weekly count 序列，标注 count > mean+2σ 的周
- **验证方法**：异常周集合与 golden 一致
- **六维目标**：acc=0.9 | strategy=4 | evidence=4 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#defect.created_count; ontology/v1/dimensions.json#time.test_week

### DTSV-047 · Release 维度的缺陷数演进？
- **领域/难度/意图**：时间序列与趋势 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.count GROUP BY product.release 降序
- **验证方法**：各 release 计数与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.count; ontology/v1/dimensions.json#product.release

### DTSV-048 · 基于近 6 月趋势外推，预测下月严重缺陷数（标注不确定性）？
- **领域/难度/意图**：时间序列与趋势 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：对 severe_count 月度序列做线性外推，返回预测值+置信区间
- **验证方法**：预测在区间内；必须显式声明不确定性（不编造精确值）
- **六维目标**：acc=0.8 | strategy=5 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#defect.severe_count; ontology/v1/dimensions.json#time.defect_creation_date

### DTSV-049 · 测试项 532211 的上下文是什么？
- **领域/难度/意图**：可追溯性 / L1 / testcase_context
- **期望工具**：get_test_case_context
- **gold 提示**：返回 test_name/subtype/run 状态/关联 feature/story
- **验证方法**：test_id=532211 的上下文字段完整准确
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：testcase/dtsv_testcases_R-22-02.json#532211; server/ontology/queryPlanner.mjs

### DTSV-050 · 缺陷 920669 关联到哪些特性(feature)与故事(story)？
- **领域/难度/意图**：可追溯性 / L2 / record_query
- **期望工具**：query_traceability, query_semantic_records
- **gold 提示**：defect 920669 → feature_links(896016) + story_links(892994)
- **验证方法**：关联 id 集合与 golden 一致；多跳正确
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：testcase/dtsv_testcases_R-22-02.json#920669; ontology/v1/relationships.json

### DTSV-051 · AIDA 需求 aida_id 的需求追溯状态(trace_status)？
- **领域/难度/意图**：可追溯性 / L2 / record_query
- **期望工具**：query_traceability, query_semantic_records
- **gold 提示**：testing.trace_status WHERE aida=aida_id
- **验证方法**：状态值与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#testing.trace_status; ontology/v1/dimensions.json#requirements.aida

### DTSV-052 · 从 story 892994 反向追溯其下所有缺陷？
- **领域/难度/意图**：可追溯性 / L3 / record_query
- **期望工具**：query_traceability, query_semantic_records
- **gold 提示**：story 892994 → feature → testcase → defect 反向链路
- **验证方法**：反向缺陷集合与 golden 一致
- **六维目标**：acc=0.9 | strategy=3 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/relationships.json; ontology/v1/dimensions.json#requirements.aida

### DTSV-053 · 测试项 532211 的 run 状态分布？
- **领域/难度/意图**：可追溯性 / L2 / record_query
- **期望工具**：query_semantic_records, get_test_case_context
- **gold 提示**：run_status_distribution(Passed/Failed/Blocked) for test_id 532211
- **验证方法**：分布与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：testcase/dtsv_testcases_R-22-02.json#532211

### DTSV-054 · 配置覆盖率（硬件变体, kpi.config_coverage_variants）缺口分析？
- **领域/难度/意图**：可追溯性 / L3 / coverage_query
- **期望工具**：query_testing_coverage_project_status, query_analytics
- **gold 提示**：kpi.config_coverage_variants 缺口 = 1 − 覆盖率，列出未覆盖变体
- **验证方法**：缺口集合与 golden 一致
- **六维目标**：acc=0.9 | strategy=3 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#kpi.config_coverage_variants; ontology/v1/dimensions.json#product.i_step

### DTSV-055 · 成熟度等级(maturity_grade, RG)分布？
- **领域/难度/意图**：可追溯性 / L2 / record_query
- **期望工具**：query_semantic_records
- **gold 提示**：GROUP BY quality.maturity_grade 计数
- **验证方法**：各 RG 等级计数与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#quality.maturity_grade

### DTSV-056 · Q-Gate 类型(qgate_type)各阶段的通过情况？
- **领域/难度/意图**：可追溯性 / L3 / record_query
- **期望工具**：query_semantic_records, query_analytics
- **gold 提示**：GROUP BY quality.qgate_type 统计通过/未通过
- **验证方法**：Q-Gate 集合与判定正确
- **六维目标**：acc=0.9 | strategy=3 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#quality.qgate_type

### DTSV-057 · IDC23 自动服务呼叫相关测试项失败，根因缺陷属于哪个 PU/ECU？
- **领域/难度/意图**：多跳关系推理 / L3 / testcase_context
- **期望工具**：query_traceability, query_semantic_metrics, query_analytics
- **gold 提示**：test('IDC23 Automatic Service Call') → failed run → defect 920669 → product.pu / product.ecu
- **验证方法**：PU/ECU 归因与 golden 一致；3 跳链路正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：testcase/dtsv_testcases_R-22-02.json; ontology/v1/relationships.json

### DTSV-058 · HU-MGU 故事下所有测试项的失败率？
- **领域/难度/意图**：多跳关系推理 / L3 / testcase_context
- **期望工具**：query_traceability, query_semantic_metrics
- **gold 提示**：story('HU-MGU') → feature → testcases → runs 计算 fail_rate
- **验证方法**：失败率与 golden 一致；多跳聚合正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/relationships.json; ontology/v1/metrics.json#testing.fail_rate

### DTSV-059 · feature 896016 下缺陷的严重程度分布与解决状态？
- **领域/难度/意图**：多跳关系推理 / L3 / record_query
- **期望工具**：query_traceability, query_semantic_metrics
- **gold 提示**：feature 896016 → defects GROUP BY severity × status
- **验证方法**：分布与 golden 一致
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/relationships.json; ontology/v1/dimensions.json#quality.severity

### DTSV-060 · 找出既影响 DV 又影响 PV 阶段的同一缺陷（父子关系）？
- **领域/难度/意图**：多跳关系推理 / L3 / record_query
- **期望工具**：query_traceability, query_semantic_records
- **gold 提示**：WHERE parent_child_type 关联 AND phase 跨 DV/PV
- **验证方法**：父子缺陷集合与 golden 一致
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#quality.parent_child_type; ontology/v1/dimensions.json#quality.phase

### DTSV-061 · 缺陷类别为 DiPS 的缺陷集中在哪些车型？
- **领域/难度/意图**：多跳关系推理 / L2 / record_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：WHERE defect_category='DiPS' GROUP BY vehicle.model_series
- **验证方法**：车型集合与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#quality.defect_category; ontology/v1/dimensions.json#vehicle.model_series

### DTSV-062 · 跨 release 同一 solution_cluster 的复发缺陷？
- **领域/难度/意图**：多跳关系推理 / L3 / record_query
- **期望工具**：query_traceability, query_semantic_records
- **gold 提示**：同 solution_cluster 且 detected_in_release 跨多 release 的缺陷
- **验证方法**：复发集合与 golden 一致
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#quality.solution_cluster; ontology/v1/dimensions.json#product.release

### DTSV-063 · 从 ECU 反查相关测试用例与需求覆盖？
- **领域/难度/意图**：多跳关系推理 / L3 / record_query
- **期望工具**：query_traceability, query_testing_coverage_aida_status
- **gold 提示**：product.ecu → testcase → aida 覆盖状态
- **验证方法**：反查集合与 golden 一致
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/dimensions.json#product.ecu; ontology/v1/dimensions.json#requirements.aida

### DTSV-064 · 检测与缺陷 920669 重复的缺陷（search_duplicates）？
- **领域/难度/意图**：多跳关系推理 / L2 / duplicate_search
- **期望工具**：search_duplicates
- **gold 提示**：返回与 920669 语义/字段重复 candidate 列表
- **验证方法**：重复候选集合与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/entities.json#defect_id; server/ontology/queryPlanner.mjs

### DTSV-065 · 当 dashboard 底层数据为空时，agent 应如何兜底？
- **领域/难度/意图**：异常检测与恢复 / L2 / dashboard_fallback
- **期望工具**：diagnose_analytics_empty, query_full_picture_module
- **gold 提示**：返回『数据为空』说明 + 全貌模块，而非报错/幻觉
- **验证方法**：outcome=completed 且 evidence 合理；无幻觉值
- **六维目标**：acc=0.95 | strategy=3 | evidence=3 | recovery=4 | latency≤8s | cost≤¥0.012
- **引用来源**：evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-018; server/mainAgentToolRecovery.mjs

### DTSV-066 · 上游 analytics 不可用时，能否切换到 fallback 并完成查询？
- **领域/难度/意图**：异常检测与恢复 / L3 / dashboard_fallback
- **期望工具**：query_analytics, query_analytics_fallback
- **gold 提示**：上游 5xx → fallback 工具恢复，返回结果 + recoveryOutcomes=['recovered']
- **验证方法**：recovery_success=真；审计含 failureCode + stoppedReason
- **六维目标**：acc=0.9 | strategy=4 | evidence=4 | recovery=5 | latency≤15s | cost≤¥0.024
- **引用来源**：evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-013; server/companyChat.mjs

### DTSV-067 · query 返回空结果时，agent 是否主动澄清或给出全貌？
- **领域/难度/意图**：异常检测与恢复 / L3 / dashboard_fallback
- **期望工具**：diagnose_analytics_empty, query_full_picture_module
- **gold 提示**：空结果 → 澄清或全貌兜底，不得编造
- **验证方法**：outcome 合理；无幻觉
- **六维目标**：acc=0.9 | strategy=4 | evidence=3 | recovery=3 | latency≤15s | cost≤¥0.024
- **引用来源**：server/mainAgentToolRecovery.mjs; server/mainAgentToolLoop/Recovery.mjs

### DTSV-068 · 检测到严重缺陷突增时，应给出怎样的告警话术？
- **领域/难度/意图**：异常检测与恢复 / L2 / high_frequency
- **期望工具**：query_defect_high_frequency_analysis
- **gold 提示**：返回突增说明 + 量级 + 建议（不泄漏内部错误）
- **验证方法**：话术含真实量级；不暴露堆栈
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#defect.severe_count; server/answerValidator.mjs

### DTSV-069 · 歧义 query（『上个月的数据』跨 release 上下文）能否澄清？
- **领域/难度/意图**：异常检测与恢复 / L3 / metric_query
- **期望工具**：ask_clarification, resolve_business_terms
- **gold 提示**：低置信度 → ask_clarification 反问明确时间窗，而非硬猜
- **验证方法**：outcome=needs_clarification；未返回错误答案
- **六维目标**：acc=0.9 | strategy=4 | evidence=2 | recovery=3 | latency≤15s | cost≤¥0.024
- **引用来源**：evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-011; server/mainAgentIntentRouter.mjs

### DTSV-070 · actor scope 拒绝访问时，返回 denied 而非内部报错？
- **领域/难度/意图**：异常检测与恢复 / L3 / metric_query
- **期望工具**：query_analytics
- **gold 提示**：scope 不匹配 → outcome=denied, failureCode=ACTOR_CAPABILITY_SCOPE_DENIED
- **验证方法**：返回 denied 且 failureCode 正确；不泄漏权限细节
- **六维目标**：acc=0.98 | strategy=4 | evidence=2 | recovery=5 | latency≤15s | cost≤¥0.024
- **引用来源**：evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-014; server/agentAuth.mjs

### DTSV-071 · 工具超时后是否重试并恢复结果？
- **领域/难度/意图**：异常检测与恢复 / L2 / metric_query
- **期望工具**：query_analytics, query_analytics_fallback
- **gold 提示**：timeout → 指数退避重试 → 恢复
- **验证方法**：recoveryOutcomes 含 recovered；延迟在预算内
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=4 | latency≤8s | cost≤¥0.012
- **引用来源**：server/companyChat.mjs; server/mainAgentToolRecovery.mjs

### DTSV-072 · 多步工具编排中一步失败，能否回退并仍给出部分答案？
- **领域/难度/意图**：异常检测与恢复 / L3 / dashboard_fallback
- **期望工具**：query_semantic_metrics, query_analytics, query_analytics_fallback
- **gold 提示**：部分工具失败 → 返回已完成部分 + 说明缺失
- **验证方法**：部分答案正确；明确标注缺失项
- **六维目标**：acc=0.9 | strategy=4 | evidence=4 | recovery=5 | latency≤15s | cost≤¥0.024
- **引用来源**：server/mainAgentToolOrchestrator.mjs; server/mainAgentToolLoop/Planning.mjs

### DTSV-073 · 生成 R-22-02 质量周报的 KPI 摘要？
- **领域/难度/意图**：报告与可视化叙事 / L2 / metric_query
- **期望工具**：query_semantic_metrics, query_testing_coverage_project_status
- **gold 提示**：汇总 defect.count/resolve_rate/pass_rate/coverage 等核心 KPI
- **验证方法**：KPI 集合与 golden 一致；数值误差≤0.02
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json; server/analysisPlanner.mjs

### DTSV-074 · 用图表展示各 severity 缺陷分布（kpi/line/bar）？
- **领域/难度/意图**：报告与可视化叙事 / L3 / metric_query
- **期望工具**：query_semantic_metrics, analysisPlanner
- **gold 提示**：返回 severity 分布 + 推荐图表类型(kpi/line/bar)
- **验证方法**：图表类型推荐合理；数据正确
- **六维目标**：acc=0.9 | strategy=4 | evidence=4 | recovery=4 | latency≤12s | cost≤¥0.024
- **引用来源**：server/ontology/analysisPlanner.mjs; ontology/v1/dimensions.json#quality.severity

### DTSV-075 · 给出缺陷趋势的洞察叙述，并标注异常点？
- **领域/难度/意图**：报告与可视化叙事 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：趋势描述 + 异常周标注 + 根因假设
- **验证方法**：洞察与数据一致；异常点正确；假设明确标注
- **六维目标**：acc=0.9 | strategy=5 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：server/analysisPlanner.mjs; ontology/v1/metrics.json#defect.created_count

### DTSV-076 · 对比两个团队的质量评分卡？
- **领域/难度/意图**：报告与可视化叙事 / L2 / business_risk_assessment
- **期望工具**：query_semantic_metrics, query_analytics
- **gold 提示**：两 team 的多 KPI 并排对比表
- **验证方法**：两团队 KPI 各自误差≤0.02
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/metrics.json#team.discovery_efficiency; ontology/v1/dimensions.json#org.team

### DTSV-077 · 输出可分享的覆盖率差距报告（含证据链接）？
- **领域/难度/意图**：报告与可视化叙事 / L3 / coverage_query
- **期望工具**：query_testing_coverage_aida_status, query_traceability
- **gold 提示**：覆盖率缺口 + 缺口 aida 列表 + 证据链接(defect_id/test_id)
- **验证方法**：缺口集合与 golden 一致；证据齐全
- **六维目标**：acc=0.9 | strategy=4 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：ontology/v1/metrics.json#kpi.function_coverage; server/mainAgentEvidence.mjs

### DTSV-078 · 按市场(market)维度拆分缺陷？
- **领域/难度/意图**：报告与可视化叙事 / L2 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.count GROUP BY quality.market
- **验证方法**：各市场计数与 golden 一致
- **六维目标**：acc=0.95 | strategy=3 | evidence=4 | recovery=3 | latency≤8s | cost≤¥0.012
- **引用来源**：ontology/v1/dimensions.json#quality.market

### DTSV-079 · 综合多 KPI 的健康度评分（0–100）？
- **领域/难度/意图**：报告与可视化叙事 / L3 / metric_query
- **期望工具**：query_semantic_metrics, query_analytics, analysisPlanner
- **gold 提示**：加权多 KPI → 健康度分；需声明权重口径
- **验证方法**：评分与口径一致；权重可解释
- **六维目标**：acc=0.9 | strategy=5 | evidence=5 | recovery=4 | latency≤15s | cost≤¥0.024
- **引用来源**：server/analysisPlanner.mjs; ontology/v1/metrics.json

### DTSV-080 · 闲聊/越界问题（如『今天天气如何』）应被正确路由，不触发数据查询？
- **领域/难度/意图**：报告与可视化叙事 / L1 / general
- **期望工具**：ask_clarification
- **gold 提示**：intent=general/out_of_scope，outcome=completed(模板化)，不调用数据工具
- **验证方法**：误路由率<5%；未触发 query_* 工具
- **六维目标**：acc=0.98 | strategy=1 | evidence=1 | recovery=1 | latency≤2s | cost≤¥0.003
- **引用来源**：evals/scorecard/fixtures/sample-run-summaries.jsonl#run-eval-017; server/mainAgentIntentRouter.mjs

### DTSV-081 · 本月新建缺陷数是多少（不限 release）？
- **领域/难度/意图**：缺陷度量查询 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.created_count（本月时间窗）
- **验证方法**：返回值==golden 整数
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#defect.created_count; ontology/v1/dimensions.json#time.defect_creation_date

### DTSV-082 · 当前缺陷总数(defect.count)是多少？
- **领域/难度/意图**：缺陷度量查询 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.count（全量）
- **验证方法**：返回值==golden 整数
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#defect.count

### DTSV-083 · 缺陷状态为 Blocked 的有多少个？
- **领域/难度/意图**：缺陷度量查询 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.count WHERE status='Blocked'
- **验证方法**：返回值==golden；status 过滤生效
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#defect.count; ontology/v1/dimensions.json#quality.status

### DTSV-084 · R-22-02 的缺陷拒绝数(rejected_count)是多少？
- **领域/难度/意图**：缺陷度量查询 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：defect.rejected_count WHERE detected_in_release='R-22-02'
- **验证方法**：返回值==golden 整数
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#defect.rejected_count

### DTSV-085 · R-22-02 的测试执行总数(run_count)是多少？
- **领域/难度/意图**：测试执行与通过率 / L1 / metric_query
- **期望工具**：query_semantic_metrics
- **gold 提示**：testing.run_count WHERE release='R-22-02'
- **验证方法**：返回值==golden 整数
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#testing.run_count

### DTSV-086 · SET_23-03 的需求覆盖率是多少？
- **领域/难度/意图**：测试覆盖率 / L1 / coverage_query
- **期望工具**：query_testing_coverage_project_status
- **gold 提示**：testing.requirement_coverage_rate WHERE project='SET_23-03'
- **验证方法**：比率误差≤0.02
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#testing.requirement_coverage_rate; ontology/v1/dimensions.json#product.project

### DTSV-087 · 测试项 690490 的测试结果是什么？
- **领域/难度/意图**：可追溯性 / L1 / testcase_context
- **期望工具**：get_test_case_context
- **gold 提示**：返回 test_id=690490 的 run 状态分布
- **验证方法**：上下文与 golden 一致
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：testcase/dtsv_testcases_R-22-02.json#690490

### DTSV-088 · 本执行团队(org.team)本月的测试执行数？
- **领域/难度/意图**：供应商与团队质量 / L1 / business_risk_assessment
- **期望工具**：query_semantic_metrics
- **gold 提示**：team.execution_count WHERE org.team=当前团队
- **验证方法**：返回值==golden
- **六维目标**：acc=0.97 | strategy=1 | evidence=3 | recovery=2 | latency≤4s | cost≤¥0.006
- **引用来源**：ontology/v1/metrics.json#team.execution_count; ontology/v1/dimensions.json#org.team


## 五、使用方式

1. 将本库与 `evals/main-agent/target/agent-golden.jsonl` 的路由用例结合，作为 P2 评测飞轮的 golden 任务集。
2. 运行 agent 后，将结果回填到每个任务的 `dimensions` 实际得分，按六维聚合即可得评分卡（对齐 `scripts/runScorecard.mjs`）。
3. `accuracy` 需 golden 值/不变量校验；`evidence`/`recovery` 取自首运行 `run-summaries.jsonl` 的 citationValidation / recoveryOutcomes；`latency`/`cost` 取自 latencyMs 与 token 计量。
4. CI（`.github/workflows/eval.yml`）可在 PR 自动回归：新增功能若无对应 scorecard 任务则不过审。