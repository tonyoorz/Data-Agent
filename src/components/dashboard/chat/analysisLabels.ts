// Frontend label resolver for analysis-result visualizations.
//
// Generated from the authoritative ontology (ontology/v1/metrics.json,
// dimensions.json, entities.json) so chart axis/series labels and KPI card
// captions show human-readable zh-CN names instead of raw dot-path ids
// (e.g. `defect.count` -> `缺陷数`). Keep in sync by re-running the
// ontology extraction when metrics/dimensions change.
//
// Fallback: an unknown id is humanized (segments split on `.`/`_` and
// title-cased) so a new metric never renders as a broken blank label.

export interface MetricMeta {
  label: string;
  unit: string;
}

export const METRIC_LABELS: Record<string, MetricMeta> = {
  "defect.count": { label: "缺陷数", unit: "count" },
  "defect.created_count": { label: "新建缺陷数", unit: "count" },
  "defect.resolved_count": { label: "解决缺陷数", unit: "count" },
  "defect.rejected_count": { label: "拒绝缺陷数", unit: "count" },
  "defect.open_count": { label: "未关闭缺陷数", unit: "count" },
  "defect.resolve_rate": { label: "缺陷解决率", unit: "percent" },
  "defect.rejection_rate": { label: "缺陷拒绝率", unit: "percent" },
  "defect.age_days": { label: "缺陷年龄", unit: "days" },
  "defect.long_runner_count": { label: "长期未解决缺陷数", unit: "count" },
  "defect.repeat_rate": { label: "重复缺陷率", unit: "percent" },
  "testing.run_count": { label: "测试执行数", unit: "count" },
  "testing.testcase_count": { label: "测试用例数", unit: "count" },
  "testing.passed_run_count": { label: "通过测试执行数", unit: "count" },
  "testing.failed_run_count": { label: "失败测试执行数", unit: "count" },
  "testing.pass_rate": { label: "测试通过率", unit: "percent" },
  "testing.fail_rate": { label: "测试失败率", unit: "percent" },
  "testing.requirement_coverage_rate": { label: "需求覆盖率", unit: "percent" },
  "testing.traceability_rate": { label: "可追溯率", unit: "percent" },
  "quality.defect_density": { label: "缺陷密度", unit: "ratio" },
  "team.execution_count": { label: "团队测试执行数", unit: "count" },
  "team.defect_discovery_count": { label: "团队发现缺陷数", unit: "count" },
  "team.discovery_efficiency": { label: "团队缺陷发现效率", unit: "ratio" },
  "kpi.defect_detection_ratio": { label: "缺陷检测率(DDP)", unit: "percent" },
  "kpi.regression_coverage": { label: "回归测试覆盖率", unit: "percent" },
  "kpi.config_coverage_models": { label: "配置覆盖率(车型)", unit: "percent" },
  "kpi.config_coverage_variants": { label: "配置覆盖率(硬件变体)", unit: "percent" },
  "kpi.defect_rejection_rate": { label: "缺陷拒收率(CWA)", unit: "percent" },
  "kpi.function_coverage": { label: "功能(AIDA)覆盖率", unit: "percent" },
  "defect.top_issue_count": { label: "Top Issue缺陷数", unit: "count" },
  "defect.showstopper_count": { label: "Showstopper缺陷数", unit: "count" },
  "defect.severe_count": { label: "严重缺陷数", unit: "count" },
};

export const DIMENSION_LABELS: Record<string, string> = {
  "time.defect_creation_date": "缺陷创建时间",
  "time.defect_resolution_date": "缺陷解决时间",
  "time.test_finished_date": "测试完成时间",
  "time.test_week": "测试周",
  "org.problem_finder_team": "问题发现团队",
  "org.tester": "测试人员",
  "org.team": "执行团队",
  "product.project": "项目",
  "product.service_pack": "Service Pack",
  "product.pu": "PU",
  "product.i_step": "I-Step",
  "product.os": "OS",
  "product.platform": "平台",
  "product.ecu": "ECU/模块",
  "vehicle.model_series": "车型系列",
  "requirements.aida": "AIDA 需求",
  "quality.phase": "缺陷阶段",
  "quality.severity": "严重程度",
  "quality.business_impact": "业务影响（BI）",
  "quality.status": "缺陷状态",
  "quality.china_scope": "China Scope",
  "testing.run_status": "测试运行状态",
  "testing.trace_status": "需求追溯状态",
  "quality.solution_cluster": "解决方案聚类",
  "quality.defect_category": "缺陷类别",
  "quality.reporting_class": "报告类别",
  "quality.user_tags": "用户标签",
  "quality.market": "市场",
  "quality.blocking_reason": "阻塞原因",
  "quality.error_occurrence": "错误发生频率",
  "quality.detected_in_release": "发现版本",
  "quality.parent_child_type": "父子类型",
  "time.defect_last_modified": "缺陷最后修改时间",
  "time.run_started": "测试开始时间",
  "time.run_creation": "测试创建时间",
  "testing.domain": "测试域",
  "testing.test_phase": "测试阶段",
  "testing.testing_tool_type": "测试工具类型",
  "testing.run_team": "执行团队(详细)",
  "product.release": "Release",
  "vehicle.lead_model": "车型(Lead Model)",
  "quality.phase_enum": "缺陷阶段(完整枚举)",
  "quality.maturity_grade": "成熟度等级(RG)",
  "quality.evaluation_phase": "评估阶段",
  "quality.function_group": "功能组",
  "testing.quality_category": "测试质量类别(ISO 25010)",
  "testing.activity_type": "测试活动类型",
  "org.cn_team_domain": "中国团队域",
  "product.release_enum": "Release(完整枚举)",
  "quality.qgate_type": "Q-Gate类型",
  "quality.tqr_enum": "工单质量评级(TQR)",
};

export const ENTITY_LABELS: Record<string, string> = {
  "quality.defect": "缺陷",
  "testing.test_case": "测试用例",
  "testing.test_run": "测试执行",
  "requirements.aida_node": "AIDA 需求节点",
  "requirements.epic": "Epic",
  "requirements.feature": "Feature",
  "requirements.story": "Story",
  "product.project": "项目",
  "product.service_pack": "Service Pack",
  "product.pu": "PU",
  "product.i_step": "I-Step",
  "product.os": "操作系统代际",
  "product.platform": "平台",
  "product.ecu": "ECU/模块",
  "vehicle.model_series": "车型系列",
  "organization.team": "团队",
  "organization.tester": "测试人员",
  "quality.qgate": "质量门",
  "evidence.artifact": "证据附件",
  "quality.defect_history_event": "缺陷历史事件",
  "traceability.link": "追溯链接",
  "traceability.testcase_summary": "测试用例追溯汇总",
  "quality.defect_outcome": "缺陷结果",
  "quality.maturity_grade": "成熟度等级",
  "organization.function_team_mapping": "功能团队映射",
  "testing.test_event": "测试事件",
  "product.test_rack": "测试台架",
  "vehicle.test_vehicle": "测试车辆",
};

function humanize(id: string): string {
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(" ");
}

export function resolveLabel(id: string): string {
  if (!id) return "";
  return METRIC_LABELS[id]?.label ?? DIMENSION_LABELS[id] ?? ENTITY_LABELS[id] ?? humanize(id);
}

export function resolveUnit(id: string): string {
  return METRIC_LABELS[id]?.unit ?? "";
}

// Percentage metrics are stored as ratios (0..1) in the semantic summary;
// render them as a percentage so a KPI card reads `92.0%` not `0.92`.
export function formatMetricValue(id: string, value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const unit = resolveUnit(id);
  if (unit === "percent" || unit === "%") {
    const pct = value <= 1 ? value * 100 : value;
    return `${pct.toFixed(pct >= 100 || Number.isInteger(pct) ? 0 : 1)}%`;
  }
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toFixed(2);
}

