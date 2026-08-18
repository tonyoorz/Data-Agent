import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PreproductionSmokeError, runPreproductionSmoke } from "../server/preproductionSmoke.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parsePreproductionSmokeArgs(argv) {
  const options = { config: "", output: "artifacts/preproduction-smoke/latest.json", allowTestcaseMutation: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") options.config = String(argv[++index] || "");
    else if (arg.startsWith("--config=")) options.config = arg.slice("--config=".length);
    else if (arg === "--output") options.output = String(argv[++index] || "");
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else if (arg === "--allow-testcase-mutation") options.allowTestcaseMutation = true;
    else throw new PreproductionSmokeError("PREPRODUCTION_SMOKE_ARGUMENT_UNKNOWN");
  }
  if (!options.config) throw new PreproductionSmokeError("PREPRODUCTION_SMOKE_CONFIG_PATH_REQUIRED");
  if (!options.output) throw new PreproductionSmokeError("PREPRODUCTION_SMOKE_OUTPUT_PATH_REQUIRED");
  return options;
}

function readConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new PreproductionSmokeError("PREPRODUCTION_SMOKE_CONFIG_READ_FAILED");
  }
}

function writeArtifact(outputPath, result) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, resolved);
  return resolved;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parsePreproductionSmokeArgs(argv);
  const configPath = path.resolve(repoRoot, options.config);
  const outputPath = path.resolve(repoRoot, options.output);
  const result = await runPreproductionSmoke(readConfig(configPath), {
    allowTestcaseMutation: options.allowTestcaseMutation,
  });
  const written = writeArtifact(outputPath, result);
  process.stdout.write(`${JSON.stringify({ status: result.status, artifactPath: written })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof PreproductionSmokeError ? error.code : "PREPRODUCTION_SMOKE_INTERNAL_ERROR";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 1;
  }
}
