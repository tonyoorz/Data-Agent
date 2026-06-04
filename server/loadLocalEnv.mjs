import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function parseEnvValue(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    return "";
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const unwrapped = value.slice(1, -1);
    if (value.startsWith('"')) {
      return unwrapped
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
    }
    return unwrapped;
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function parseEnvFile(content) {
  const parsed = {};

  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const exportLine = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = exportLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = exportLine.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const value = exportLine.slice(separatorIndex + 1);
    parsed[key] = parseEnvValue(value);
  }

  return parsed;
}

export function loadLocalEnv(env = process.env) {
  const merged = {};
  const loadedFiles = [];

  for (const fileName of [".env", ".env.local"]) {
    const filePath = path.join(repoRoot, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    Object.assign(merged, parseEnvFile(fs.readFileSync(filePath, "utf8")));
    loadedFiles.push(fileName);
  }

  for (const [key, value] of Object.entries(merged)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  return loadedFiles;
}
