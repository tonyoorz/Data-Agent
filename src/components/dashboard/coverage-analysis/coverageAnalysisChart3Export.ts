import type { CoverageAnalysisTestcaseDetailRow } from "./coverageAnalysisTypes";
import type { Row } from "exceljs";

const EXPORT_BASE_COLUMNS = [
  { key: "test_id", label: "Testcase ID", width: 14 },
  { key: "test_name", label: "Testcase Name", width: 48 },
  { key: "top_aida", label: "Top AIDA", width: 46 },
  { key: "fvp", label: "FVP", width: 16 },
  { key: "fv", label: "FV", width: 16 },
  { key: "project", label: "Project", width: 16 },
  { key: "pu", label: "PU", width: 14 },
  { key: "tester", label: "Tester", width: 18 },
] as const;

const STATUS_PRIORITY: Record<string, number> = {
  Failed: 4,
  Blocked: 3,
  "Requires Attention": 3,
  "In Progress": 2,
  Planned: 1,
  Passed: 0,
};

const STATUS_FILL_COLORS: Record<string, string> = {
  Failed: "FFFFC7CE",
  Blocked: "FFFFD966",
  "Requires Attention": "FFFFD966",
  Planned: "FFD9D9D9",
  Passed: "FFC6EFCE",
};

type ExportBaseKey = keyof Pick<
  CoverageAnalysisTestcaseDetailRow,
  "test_id" | "test_name" | "top_aida" | "fvp" | "fv" | "project" | "pu" | "tester"
>;

type Chart3ExportRow = {
  [key: string]: string | number;
};

export type Chart3ExportModel = {
  pivotHeaders: string[];
  pivotRows: Chart3ExportRow[];
  statsHeaders: string[];
  statsRows: Chart3ExportRow[];
  weekHeaders: string[];
};

function normalizeStatus(value: string) {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "requires attention":
      return "Blocked";
    case "planned":
      return "Planned";
    case "in progress":
    case "in_progress":
    case "not completed":
      return "In Progress";
    default:
      return value.trim();
  }
}

function parseTestWeekSortKey(testWeek: string) {
  const match = String(testWeek).trim().match(/^(\d{2,4})-CW(\d{2})$/i);
  if (!match) {
    return { year: Number.MAX_SAFE_INTEGER, week: Number.MAX_SAFE_INTEGER };
  }

  const rawYear = Number.parseInt(match[1], 10);
  const normalizedYear = rawYear < 100 ? rawYear + 2000 : rawYear;
  return {
    year: normalizedYear,
    week: Number.parseInt(match[2], 10),
  };
}

function compareTestWeek(left: string, right: string) {
  const leftKey = parseTestWeekSortKey(left);
  const rightKey = parseTestWeekSortKey(right);

  if (leftKey.year !== rightKey.year) {
    return leftKey.year - rightKey.year;
  }

  if (leftKey.week !== rightKey.week) {
    return leftKey.week - rightKey.week;
  }

  return left.localeCompare(right);
}

function buildWeekLabelMap(rows: CoverageAnalysisTestcaseDetailRow[]) {
  const orderedWeeks = Array.from(new Set(rows.map((row) => row.test_week).filter(Boolean))).sort(compareTestWeek);
  const yearsPresent = Array.from(
    new Set(
      orderedWeeks
        .map((week) => parseTestWeekSortKey(week).year)
        .filter((year) => Number.isFinite(year) && year !== Number.MAX_SAFE_INTEGER),
    ),
  );
  const useShortLabel = yearsPresent.length === 1;

  const labelMap = new Map<string, string>();
  const usedLabels = new Set<string>();
  orderedWeeks.forEach((week) => {
    const { year, week: weekNumber } = parseTestWeekSortKey(week);
    let label = week;
    if (Number.isFinite(year) && year !== Number.MAX_SAFE_INTEGER && Number.isFinite(weekNumber)) {
      label = useShortLabel ? `CW${String(weekNumber).padStart(2, "0")}` : `${String(year).slice(-2)}-CW${String(weekNumber).padStart(2, "0")}`;
    }
    if (usedLabels.has(label)) {
      label = week;
    }
    usedLabels.add(label);
    labelMap.set(week, label);
  });

  return {
    orderedWeeks,
    orderedLabels: orderedWeeks.map((week) => labelMap.get(week) ?? week),
    labelMap,
  };
}

export function buildChart3ExportModel(rows: CoverageAnalysisTestcaseDetailRow[]): Chart3ExportModel {
  if (rows.length === 0) {
    return {
      pivotHeaders: [],
      pivotRows: [],
      statsHeaders: [],
      statsRows: [],
      weekHeaders: [],
    };
  }

  const { orderedLabels, labelMap } = buildWeekLabelMap(rows);
  const baseKeys = EXPORT_BASE_COLUMNS.map((column) => column.key) as ExportBaseKey[];
  const groupedRows = new Map<string, { base: Record<ExportBaseKey, string>; weeks: Map<string, string> }>();

  rows.forEach((row) => {
    const base = {
      test_id: row.test_id,
      test_name: row.test_name,
      top_aida: row.top_aida,
      fvp: row.fvp,
      fv: row.fv,
      project: row.project,
      pu: row.pu,
      tester: row.tester,
    };
    const baseKey = baseKeys.map((key) => base[key] || "").join("||");
    const weekLabel = labelMap.get(row.test_week) ?? row.test_week;
    const status = normalizeStatus(row.status);

    const current = groupedRows.get(baseKey) ?? {
      base,
      weeks: new Map<string, string>(),
    };
    const existingStatus = current.weeks.get(weekLabel);
    if (!existingStatus || (STATUS_PRIORITY[status] ?? -1) > (STATUS_PRIORITY[existingStatus] ?? -1)) {
      current.weeks.set(weekLabel, status);
    }
    groupedRows.set(baseKey, current);
  });

  const groupedValues = Array.from(groupedRows.values()).sort((left, right) => {
    const leftId = Number.parseInt(left.base.test_id, 10);
    const rightId = Number.parseInt(right.base.test_id, 10);
    const bothNumeric = Number.isFinite(leftId) && Number.isFinite(rightId);
    if (bothNumeric && leftId !== rightId) {
      return leftId - rightId;
    }
    return left.base.test_id.localeCompare(right.base.test_id) || left.base.test_name.localeCompare(right.base.test_name);
  });

  const totalWeeks = orderedLabels.length;
  const pivotHeaders = [
    ...EXPORT_BASE_COLUMNS.map((column) => column.label),
    ...orderedLabels,
    "Test Frequency",
    "Pass Rate",
  ];
  const statsHeaders = [
    ...EXPORT_BASE_COLUMNS.map((column) => column.label),
    "Weeks With Result",
    "Weeks Passed",
    "Test Frequency",
    "Pass Rate",
  ];

  const pivotRows: Chart3ExportRow[] = [];
  const statsRows: Chart3ExportRow[] = [];

  groupedValues.forEach(({ base, weeks }) => {
    const weeksWithResult = orderedLabels.filter((weekLabel) => {
      const value = weeks.get(weekLabel);
      return Boolean(value && value.trim());
    }).length;
    const weeksPassed = orderedLabels.filter((weekLabel) => weeks.get(weekLabel) === "Passed").length;
    const testFrequency = totalWeeks > 0 ? weeksWithResult / totalWeeks : 0;
    const passRate = weeksWithResult > 0 ? weeksPassed / weeksWithResult : 0;

    const pivotRow: Chart3ExportRow = {};
    EXPORT_BASE_COLUMNS.forEach((column) => {
      pivotRow[column.label] = base[column.key] || "";
    });
    orderedLabels.forEach((weekLabel) => {
      pivotRow[weekLabel] = weeks.get(weekLabel) ?? "";
    });
    pivotRow["Test Frequency"] = testFrequency;
    pivotRow["Pass Rate"] = passRate;
    pivotRows.push(pivotRow);

    const statsRow: Chart3ExportRow = {};
    EXPORT_BASE_COLUMNS.forEach((column) => {
      statsRow[column.label] = base[column.key] || "";
    });
    statsRow["Weeks With Result"] = weeksWithResult;
    statsRow["Weeks Passed"] = weeksPassed;
    statsRow["Test Frequency"] = testFrequency;
    statsRow["Pass Rate"] = passRate;
    statsRows.push(statsRow);
  });

  return {
    pivotHeaders,
    pivotRows,
    statsHeaders,
    statsRows,
    weekHeaders: orderedLabels,
  };
}

function downloadBuffer(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

function applyHeaderStyle(row: Row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF1F2937" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
    };
  });
}

export async function downloadChart3Workbook(rows: CoverageAnalysisTestcaseDetailRow[]) {
  const model = buildChart3ExportModel(rows);
  if (model.pivotHeaders.length === 0) {
    return;
  }

  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Vizion Lab";
  workbook.created = new Date();

  const pivotSheet = workbook.addWorksheet("Pivot", {
    views: [{ state: "frozen", xSplit: EXPORT_BASE_COLUMNS.length, ySplit: 1 }],
  });
  pivotSheet.columns = model.pivotHeaders.map((header) => {
    const baseColumn = EXPORT_BASE_COLUMNS.find((column) => column.label === header);
    if (baseColumn) {
      return { header, key: header, width: baseColumn.width };
    }
    if (header === "Test Frequency") {
      return { header, key: header, width: 14 };
    }
    if (header === "Pass Rate") {
      return { header, key: header, width: 12 };
    }
    return { header, key: header, width: 11 };
  });
  pivotSheet.addRows(model.pivotRows);
  applyHeaderStyle(pivotSheet.getRow(1));
  pivotSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: model.pivotHeaders.length },
  };

  const percentHeaders = new Set(["Test Frequency", "Pass Rate"]);
  model.pivotHeaders.forEach((header, columnIndex) => {
    if (percentHeaders.has(header)) {
      pivotSheet.getColumn(columnIndex + 1).numFmt = "0%";
    }
  });

  for (let rowIndex = 2; rowIndex <= pivotSheet.rowCount; rowIndex += 1) {
    model.weekHeaders.forEach((weekHeader) => {
      const cell = pivotSheet.getCell(rowIndex, model.pivotHeaders.indexOf(weekHeader) + 1);
      const normalizedValue = String(cell.value ?? "").trim();
      const fillColor = STATUS_FILL_COLORS[normalizedValue];
      if (fillColor) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
      }
      cell.alignment = { horizontal: "center" };
    });
  }

  const statsSheet = workbook.addWorksheet("Stats", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  statsSheet.columns = model.statsHeaders.map((header) => {
    const baseColumn = EXPORT_BASE_COLUMNS.find((column) => column.label === header);
    if (baseColumn) {
      return { header, key: header, width: baseColumn.width };
    }
    if (header === "Weeks With Result" || header === "Weeks Passed") {
      return { header, key: header, width: 18 };
    }
    if (percentHeaders.has(header)) {
      return { header, key: header, width: 14 };
    }
    return { header, key: header, width: 16 };
  });
  statsSheet.addRows(model.statsRows);
  applyHeaderStyle(statsSheet.getRow(1));
  statsSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: model.statsHeaders.length },
  };
  model.statsHeaders.forEach((header, columnIndex) => {
    if (percentHeaders.has(header)) {
      statsSheet.getColumn(columnIndex + 1).numFmt = "0%";
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  downloadBuffer(buffer as ArrayBuffer, `测试覆盖率_图表三_导出_${timestamp}.xlsx`);
}
