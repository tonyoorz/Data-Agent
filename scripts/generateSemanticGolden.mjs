import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "evals/main-agent/target/semantic-golden.jsonl");
const anchorAt = "2026-07-15T04:00:00.000Z";

const cases = [];
function add(query, expected) {
  cases.push({
    schemaVersion: "1.0",
    caseId: `semantic-${String(cases.length + 1).padStart(3, "0")}`,
    query,
    anchorAt,
    expected,
  });
}

const defectMetrics = [
  { phrase: "缺陷数", id: "defect.count" },
  { phrase: "新增缺陷", id: "defect.created_count" },
];
const defectDimensions = [
  { phrase: "ECU", id: "product.ecu" },
  { phrase: "项目", id: "product.project" },
  { phrase: "PU", id: "product.pu" },
  { phrase: "Phase", id: "quality.phase" },
  { phrase: "严重度", id: "quality.severity" },
];
const defectTimes = [
  { phrase: "2026 年", start: "2026-01-01" },
  { phrase: "最近一周", start: "2026-07-09" },
  { phrase: "本月", start: "2026-07-01" },
  { phrase: "上周", start: "2026-07-06" },
  { phrase: "今年", start: "2026-01-01" },
];
for (const metric of defectMetrics) {
  for (const dimension of defectDimensions) {
    for (const time of defectTimes) {
      add(`${time.phrase} DTSV ${metric.phrase} 按 ${dimension.phrase} 统计`, {
        intent: "aggregate",
        metricIds: [metric.id],
        dimensionIds: [dimension.id],
        timeFieldId: "time.defect_creation_date",
        timeStart: time.start,
      });
    }
  }
}

const testingMetrics = [
  { phrase: "测试执行数", id: "testing.run_count" },
  { phrase: "通过的测试数", id: "testing.passed_run_count" },
  { phrase: "失败的测试数", id: "testing.failed_run_count" },
];
const testingDimensions = [
  { phrase: "项目", id: "product.project" },
  { phrase: "PU", id: "product.pu" },
  { phrase: "测试人员", id: "org.tester" },
];
const testingTimes = [
  { phrase: "2026 年", start: "2026-01-01" },
  { phrase: "最近一周", start: "2026-07-09" },
  { phrase: "本月", start: "2026-07-01" },
  { phrase: "上周", start: "2026-07-06" },
];
for (const metric of testingMetrics) {
  for (const dimension of testingDimensions) {
    for (const time of testingTimes) {
      add(`${time.phrase} ${metric.phrase} 按 ${dimension.phrase} 统计`, {
        intent: "aggregate",
        metricIds: [metric.id],
        dimensionIds: [dimension.id],
        timeFieldId: "time.test_finished_date",
        timeStart: time.start,
      });
    }
  }
}

for (const dimension of [
  { phrase: "项目", id: "product.project" },
  { phrase: "PU", id: "product.pu" },
  { phrase: "AIDA", id: "requirements.aida" },
]) {
  add(`测试用例数按 ${dimension.phrase}`, {
    intent: "aggregate",
    metricIds: ["testing.testcase_count"],
    dimensionIds: [dimension.id],
  });
}

for (const query of [
  "蓝牙断连缺陷查重",
  "查找相似缺陷",
  "判断是否为重复缺陷",
  "duplicate search for audio issue",
  "find a similar defect for navigation crash",
]) {
  add(query, { intent: "similarity", metricIds: [], dimensionIds: [] });
}

for (const query of [
  "追溯 Requirement 到 TestCase、TestRun 和 Defect",
  "查看需求测试缺陷链路",
  "trace AIDA to test run and defect",
]) {
  add(query, { intent: "trace", metricIds: [], dimensionIds: [] });
}

for (const query of [
  "OS8 与 OS9 缺陷数对比",
  "比较 OS8 和 OS9 的 defect count",
  "defect count OS8 vs OS9",
]) {
  add(query, {
    intent: "compare",
    metricIds: ["defect.count"],
    dimensionIds: ["product.os"],
    comparisonGroups: ["OS8", "OS9"],
  });
}

add("最近三个月新增缺陷趋势", {
  intent: "trend",
  metricIds: ["defect.created_count"],
  dimensionIds: ["time.defect_creation_date"],
  timeFieldId: "time.defect_creation_date",
  timeStart: "2026-05-01",
});

add("本周比上周新增缺陷增加多少", {
  intent: "compare",
  metricIds: ["defect.created_count"],
  dimensionIds: ["time.defect_creation_date"],
  timeFieldId: "time.defect_creation_date",
  timeStart: "2026-07-06",
  comparisonGroups: ["2026-07-06/2026-07-12", "2026-07-13/2026-07-15"],
});

add("OS9 和 OS8 最近三个月新增缺陷趋势有什么差异？", {
  intent: "compare",
  metricIds: ["defect.created_count"],
  dimensionIds: ["product.os", "time.defect_creation_date"],
  timeFieldId: "time.defect_creation_date",
  timeStart: "2026-05-01",
  comparisonGroups: ["OS8", "OS9"],
});

add("25-07 PU 当前缺陷数量是多少？", {
  intent: "aggregate",
  metricIds: ["defect.count"],
  dimensionIds: [],
  filters: [{ dimensionId: "product.pu", operator: "in", values: ["25-07"], source: "user" }],
});

add("OS9 最近四周失败 Run 数量是多少？", {
  intent: "aggregate",
  metricIds: ["testing.failed_run_count"],
  dimensionIds: [],
  timeFieldId: "time.test_finished_date",
  timeStart: "2026-06-18",
  ambiguityCode: "FILTER_DIMENSION_NOT_AVAILABLE",
});

add("缺陷最多的五个项目是什么？", {
  intent: "rank",
  metricIds: ["defect.count"],
  dimensionIds: ["product.project"],
  limit: 5,
});

add("解决得快不快？", {
  intent: "aggregate",
  metricIds: ["defect.age_days"],
  dimensionIds: [],
  ambiguityCode: "DEFECT_AGE_RULE_UNAPPROVED",
});

add("这个 AIDA Requirement 有哪些 TestCase 和最近的 TestRun？", {
  intent: "trace",
  metricIds: [],
  dimensionIds: [],
  timeFieldId: "time.test_finished_date",
  ambiguityCode: "TRACE_SUBJECT_REQUIRED",
});

add("失败 Run 关联了哪些 Defect？", {
  intent: "trace",
  metricIds: [],
  dimensionIds: [],
  timeFieldId: "time.test_finished_date",
  filters: [{ dimensionId: "testing.run_status", operator: "in", values: ["Failed"], source: "user" }],
});

add("25-03 与 25-07 的测试通过率比较。", {
  intent: "compare",
  metricIds: ["testing.pass_rate"],
  dimensionIds: ["product.pu"],
  filters: [{ dimensionId: "product.pu", operator: "in", values: ["25-03", "25-07"], source: "user" }],
  comparisonGroups: ["25-03", "25-07"],
  ambiguityCode: "TEST_RUN_DENOMINATOR_UNAPPROVED",
});

add("哪些 TestCase 没有 Requirement traceability？", {
  intent: "trace",
  metricIds: [],
  dimensionIds: [],
  filters: [{ dimensionId: "testing.trace_status", operator: "in", values: ["Untraced"], source: "user" }],
});

add("覆盖率怎么样？", {
  intent: "aggregate",
  metricIds: ["testing.requirement_coverage_rate"],
  dimensionIds: [],
  ambiguityCode: "COVERAGE_POPULATION_UNAPPROVED",
});

add("缺陷密度高吗？", {
  intent: "aggregate",
  metricIds: ["quality.defect_density"],
  dimensionIds: [],
  ambiguityCode: "DEFECT_DENSITY_DENOMINATOR_REQUIRED",
});

if (cases.length !== 113) throw new Error(`SEMANTIC_GOLDEN_CASE_COUNT:${cases.length}`);
const content = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
const check = process.argv.includes("--check");
if (check) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== content) {
    throw new Error("SEMANTIC_GOLDEN_STALE");
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content);
}
process.stdout.write(`${JSON.stringify({ caseCount: cases.length, outputPath, check })}\n`);
