import type { MainDashboardTicketRow } from "./mainDashboardTypes";

const CHINA_SCOPE_LABEL = "China";
const GLOBAL_SCOPE_LABEL = "Global";

const CHINA_SOLUTION_CLUSTERS = new Set(
  [
    "Solution cluster:China Product",
    "IPA CN",
    "Speech CN",
    "Navigation CN",
    "ENT_and_CON CN",
    "Navigation TWN",
    "ETC JP",
  ].map(normalizeChinaValue),
);

const CHINA_DEFECT_CATEGORIES = new Set(
  [
    "ENT/CONNECTED_MUSIC_CHINA",
    "Application Navigation China HK",
    "CN DKR",
    "CN Backend_Service",
    "CN ETC",
    "CN for Asia Contact book",
    "CN for AsiaTextSupportLib",
    "CN For Global Festive App",
    "CN for Asia Speller",
    "CN for USB media service",
    "CN Intelligent Reminder",
    "CN IPA_Visualization",
    "CN Launcher",
    "CN IPA_Intelligence",
    "CN LLM",
    "CN Media",
    "CN MLS",
    "CN Nav",
    "CN MPP",
    "CN Social login Via Wechat",
    "CN Store",
    "CN Speech",
    "CN VoD",
    "CN Wechat",
    "CN_Core_UI",
    "CN_Experience_Mode",
    "CN_HUAWEI_HiCar",
    "CN_Karaoke",
    "CN_Gaming",
    "CN_UI_Lib",
    "CN_Platform",
    "CN_Subscription",
    "oap/weather/cn",
    "Offboard eRoute",
    "Road Map Taiwan",
    "Application Navigation Taiwan",
    "International Keyboard",
    "Apps_FestivalMode",
    "CN_Video_conference",
    "CN ADAS Setting",
    "CN_Demo_Mode",
    "CN AD View",
    "CN Video Casting",
  ].map(normalizeChinaValue),
);

function normalizeChinaValue(value: string) {
  return value.trim().toLocaleLowerCase();
}

function isChinaSolutionCluster(solutionCluster?: string | null) {
  const normalizedSolutionCluster = normalizeChinaValue(solutionCluster ?? "");

  return normalizedSolutionCluster
    ? CHINA_SOLUTION_CLUSTERS.has(normalizedSolutionCluster)
    : false;
}

function isChinaDefectCategory(defectCategory?: string | null) {
  const normalizedDefectCategory = normalizeChinaValue(defectCategory ?? "");

  return normalizedDefectCategory
    ? CHINA_DEFECT_CATEGORIES.has(normalizedDefectCategory)
    : false;
}

export function getTicketChinaScope(row: Pick<MainDashboardTicketRow, "solutionCluster" | "defectCategory">) {
  if (isChinaSolutionCluster(row.solutionCluster)) {
    return CHINA_SCOPE_LABEL;
  }

  if (!normalizeChinaValue(row.solutionCluster ?? "") && isChinaDefectCategory(row.defectCategory)) {
    return CHINA_SCOPE_LABEL;
  }

  return GLOBAL_SCOPE_LABEL;
}

export function collectChinaScopeOptions(ticketRows: MainDashboardTicketRow[]) {
  const scopes = new Set(ticketRows.map((row) => getTicketChinaScope(row)));
  const orderedScopes = [CHINA_SCOPE_LABEL, GLOBAL_SCOPE_LABEL];

  return orderedScopes.filter((scope) => scopes.has(scope));
}
