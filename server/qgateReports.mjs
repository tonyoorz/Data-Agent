import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DASHBOARD_FILE_RE = /^qgate_kpi_dashboard_.*\.html$/;
const RUN_DIR_RE = /^\d{8}_\d{6}$/;

export const defaultQGateReportsRoot = path.resolve(
  process.cwd(),
  "docs",
  "qgate-reports",
  "generated_runs",
);

export function findLatestQGateDashboardReport(root = defaultQGateReportsRoot) {
  if (!fs.existsSync(root)) {
    return unavailable();
  }

  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_DIR_RE.test(entry.name))
    .flatMap((entry) => {
      const runDir = path.join(root, entry.name);
      return fs
        .readdirSync(runDir, { withFileTypes: true })
        .filter((file) => file.isFile() && DASHBOARD_FILE_RE.test(file.name))
        .map((file) => {
          const filePath = path.join(runDir, file.name);
          return {
            run: entry.name,
            fileName: file.name,
            mtimeMs: fs.statSync(filePath).mtimeMs,
          };
        });
    })
    .sort((left, right) => right.run.localeCompare(left.run) || right.mtimeMs - left.mtimeMs);

  const latest = candidates[0];
  if (!latest) {
    return unavailable();
  }

  return {
    available: true,
    run: latest.run,
    fileName: latest.fileName,
    generatedAt: new Date(latest.mtimeMs).toISOString(),
    iframeUrl: `/api/qgate-reports/dashboard-html?run=${encodeURIComponent(latest.run)}&file=${encodeURIComponent(latest.fileName)}`,
  };
}

export function resolveQGateDashboardHtmlPath(root, run, fileName) {
  if (!RUN_DIR_RE.test(String(run || ""))) {
    throw new Error("Invalid QGate report path");
  }
  if (!DASHBOARD_FILE_RE.test(String(fileName || ""))) {
    throw new Error("Invalid QGate dashboard file");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, run, fileName);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Invalid QGate report path");
  }
  if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
    throw new Error("QGate dashboard file not found");
  }
  return resolvedFile;
}

export function createQGateDashboardNonce() {
  return randomBytes(18).toString("base64url");
}

export function buildQGateDashboardCsp(nonce) {
  if (!nonce || typeof nonce !== "string") {
    throw new TypeError("QGATE_DASHBOARD_NONCE_REQUIRED");
  }
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function stampQGateScriptNonce(html, nonce) {
  if (typeof html !== "string") {
    throw new TypeError("QGATE_DASHBOARD_HTML_REQUIRED");
  }
  if (!nonce || typeof nonce !== "string") {
    throw new TypeError("QGATE_DASHBOARD_NONCE_REQUIRED");
  }
  // The generated dashboard has exactly one inline <script> (the renderer).
  // String#replace with a string pattern rewrites only the first occurrence, so
  // any injected </script><script> breakout stays un-noned and is blocked by
  // the script-src 'nonce-...' policy.
  return html.replace("<script>", `<script nonce="${nonce}">`);
}

function unavailable() {
  return {
    available: false,
    message: "No QGate KPI Dashboard report has been generated yet.",
  };
}