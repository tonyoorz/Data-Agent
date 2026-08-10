import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateUsageRecords,
  parseChatSessionPatchLog,
  renderUsageReportHtml,
} from "./copilotUsageReport.mjs";

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listSessionFiles(rootPath) {
  if (!(await pathExists(rootPath))) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path.join(rootPath, entry.name));
    }
  }

  return files;
}

async function discoverChatSessionFiles(userRoot) {
  const workspaceStorageRoot = path.join(userRoot, "workspaceStorage");
  const globalEmptyWindowRoot = path.join(userRoot, "globalStorage", "emptyWindowChatSessions");
  const discovered = new Set();

  if (await pathExists(workspaceStorageRoot)) {
    const workspaceEntries = await fs.readdir(workspaceStorageRoot, { withFileTypes: true });

    for (const entry of workspaceEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const chatSessionsRoot = path.join(workspaceStorageRoot, entry.name, "chatSessions");

      for (const sessionFile of await listSessionFiles(chatSessionsRoot)) {
        discovered.add(sessionFile);
      }
    }
  }

  for (const sessionFile of await listSessionFiles(globalEmptyWindowRoot)) {
    discovered.add(sessionFile);
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}

async function readUsageRecords(sessionFiles) {
  const records = [];
  const warnings = [];

  for (const sessionFile of sessionFiles) {
    try {
      const stats = await fs.stat(sessionFile);

      if (stats.size === 0) {
        continue;
      }

      const content = await fs.readFile(sessionFile, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);

      if (lines.length === 0) {
        continue;
      }

      const record = parseChatSessionPatchLog(lines);
      records.push(record);
    } catch (error) {
      warnings.push(`Skipped ${sessionFile}: ${error.message}`);
    }
  }

  return { records, warnings };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const userRoot = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Code", "User");
  const outputPath = path.join(repoRoot, "docs", "copilot-usage-history.html");
  const sessionFiles = await discoverChatSessionFiles(userRoot);
  const { records, warnings } = await readUsageRecords(sessionFiles);
  const summary = aggregateUsageRecords(records);
  summary.warnings = warnings;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderUsageReportHtml(summary), "utf8");

  console.log(
    JSON.stringify(
      {
        sessionFiles: sessionFiles.length,
        parsedSessions: summary.totals.sessionCount,
        requests: summary.totals.requestCount,
        estimatedCost: Number(summary.totals.estimatedCost.toFixed(4)),
        warnings: warnings.length,
        outputPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});