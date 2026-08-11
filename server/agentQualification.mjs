import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./ontology/fingerprint.mjs";

const AGENT_EVAL_TEST_FILES = Object.freeze([
  "src/test/server/mainAgentGolden.test.ts",
  "src/test/server/ontology/semanticGolden.test.ts",
  "src/test/server/ontology/semanticQualityGolden.test.ts",
  "src/test/server/mainAgentExecutionGolden.test.ts",
  "src/test/server/mainAgentPolicyGolden.test.ts",
  "src/test/server/mainAgentToolRecovery.test.ts",
  "src/test/server/answerValidator.test.ts",
]);

const mandatoryGateIds = Object.freeze(["agent_evals", "ontology_check"]);

export class AgentQualificationError extends Error {
  constructor(code, details = "") {
    super(details ? `${code}:${details}` : code);
    this.name = "AgentQualificationError";
    this.code = code;
  }
}

function fail(code, details = "") {
  throw new AgentQualificationError(code, details);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function resolvePackageEntrypoint(packageName, relativeEntrypoint) {
  try {
    const packageJsonPath = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
    return path.join(path.dirname(packageJsonPath), relativeEntrypoint);
  } catch {
    fail("AGENT_QUALIFICATION_NODE_PACKAGE_MISSING", packageName);
  }
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(code, path.basename(filePath));
  }
}

function readOntologyFingerprint(root) {
  const fingerprintPath = path.join(root, "ontology/generated/fingerprint.txt");
  let fingerprint = "";
  try {
    fingerprint = fs.readFileSync(fingerprintPath, "utf8").trim();
  } catch {
    fail("AGENT_QUALIFICATION_ONTOLOGY_FINGERPRINT_MISSING");
  }
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    fail("AGENT_QUALIFICATION_ONTOLOGY_FINGERPRINT_INVALID");
  }
  return fingerprint;
}

export function readQualificationOntologyState(root) {
  const fingerprint = readOntologyFingerprint(root);
  const report = readJson(
    path.join(root, "ontology/generated/runtime-capabilities.json"),
    "AGENT_QUALIFICATION_RUNTIME_CAPABILITY_REPORT_INVALID",
  );
  if (report?.ontologyFingerprint !== fingerprint) {
    fail("AGENT_QUALIFICATION_RUNTIME_REPORT_FINGERPRINT_MISMATCH");
  }
  if (!Array.isArray(report.metrics) || report.metrics.length === 0) {
    fail("AGENT_QUALIFICATION_RUNTIME_METRICS_MISSING");
  }
  const statuses = report.metrics.map((metric) => metric?.runtimeStatus);
  if (statuses.some((status) => status !== "ready" && status !== "planned")) {
    fail("AGENT_QUALIFICATION_RUNTIME_METRIC_STATUS_INVALID");
  }
  const ready = statuses.filter((status) => status === "ready").length;
  const planned = statuses.filter((status) => status === "planned").length;
  if (
    report.summary?.runtimeReadyMetricCount !== undefined
    && report.summary.runtimeReadyMetricCount !== ready
  ) {
    fail("AGENT_QUALIFICATION_RUNTIME_METRIC_COUNT_MISMATCH");
  }
  return {
    fingerprint,
    runtimeMetricCounts: { ready, planned, total: statuses.length },
  };
}

export function inspectQualificationFixtures(root) {
  const fixtureDir = path.join(root, "evals/main-agent/target");
  let entries;
  try {
    entries = fs.readdirSync(fixtureDir, { withFileTypes: true });
  } catch {
    fail("AGENT_QUALIFICATION_FIXTURE_DIRECTORY_MISSING");
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(fixtureDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) fail("AGENT_QUALIFICATION_FIXTURES_MISSING");

  const caseIds = new Set();
  return files.map((filePath) => {
    const content = fs.readFileSync(filePath);
    const lines = content.toString("utf8").split(/\r?\n/u).filter((line) => line.trim());
    if (lines.length === 0) fail("AGENT_QUALIFICATION_FIXTURE_EMPTY", path.basename(filePath));
    for (let index = 0; index < lines.length; index += 1) {
      let item;
      try {
        item = JSON.parse(lines[index]);
      } catch {
        fail("AGENT_QUALIFICATION_FIXTURE_JSON_INVALID", `${path.basename(filePath)}:${index + 1}`);
      }
      const caseId = typeof item?.caseId === "string" ? item.caseId.trim() : "";
      if (!caseId) fail("AGENT_QUALIFICATION_FIXTURE_CASE_ID_MISSING", `${path.basename(filePath)}:${index + 1}`);
      if (caseIds.has(caseId)) fail("AGENT_QUALIFICATION_FIXTURE_CASE_ID_DUPLICATE", caseId);
      caseIds.add(caseId);
    }
    return {
      path: normalizedRelativePath(root, filePath),
      caseCount: lines.length,
      sha256: sha256(content),
    };
  });
}

export function readQualificationGitState(root) {
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const commit = String(commitResult.stdout || "").trim();
  if (commitResult.status !== 0 || !/^[a-f0-9]{40,64}$/u.test(commit)) {
    fail("AGENT_QUALIFICATION_GIT_COMMIT_UNAVAILABLE");
  }
  const statusResult = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (statusResult.status !== 0) fail("AGENT_QUALIFICATION_GIT_STATUS_UNAVAILABLE");
  return { commit, dirty: Boolean(String(statusResult.stdout || "").trim()) };
}

export function assertQualificationOutputPathSafe(root, outputPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutputPath = path.resolve(outputPath);
  const relativeOutputPath = path.relative(resolvedRoot, resolvedOutputPath);
  if (relativeOutputPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutputPath)) return;
  if (!relativeOutputPath) fail("AGENT_QUALIFICATION_OUTPUT_PATH_INVALID");
  const ignoredResult = spawnSync("git", ["check-ignore", "--quiet", "--", relativeOutputPath], {
    cwd: resolvedRoot,
    stdio: "ignore",
    shell: false,
  });
  if (ignoredResult.status !== 0) {
    fail("AGENT_QUALIFICATION_OUTPUT_PATH_NOT_IGNORED", relativeOutputPath.split(path.sep).join("/"));
  }
}

export function buildAgentQualificationCommands({ includeFullTests = false, includeBuild = false } = {}) {
  const vitestEntrypoint = resolvePackageEntrypoint("vitest", "vitest.mjs");
  const commands = [
    {
      id: "agent_evals",
      label: "Deterministic Agent fixture evaluations",
      executable: process.execPath,
      args: [vitestEntrypoint, "run", ...AGENT_EVAL_TEST_FILES],
      portableCommand: { runner: "node", package: "vitest", args: ["run", ...AGENT_EVAL_TEST_FILES] },
      cwd: ".",
      required: true,
    },
    {
      id: "ontology_check",
      label: "Ontology generated-artifact and runtime-publication check",
      executable: process.execPath,
      args: ["scripts/compileOntology.mjs", "--check"],
      portableCommand: { runner: "node", script: "scripts/compileOntology.mjs", args: ["--check"] },
      cwd: ".",
      required: true,
    },
  ];
  if (includeFullTests) {
    commands.push({
      id: "full_node_tests",
      label: "Full Node test suite",
      executable: process.execPath,
      args: [vitestEntrypoint, "run"],
      portableCommand: { runner: "node", package: "vitest", args: ["run"] },
      cwd: ".",
      required: true,
    });
  }
  if (includeBuild) {
    const viteEntrypoint = resolvePackageEntrypoint("vite", "bin/vite.js");
    commands.push({
      id: "production_build",
      label: "Production frontend build",
      executable: process.execPath,
      args: [viteEntrypoint, "build"],
      portableCommand: { runner: "node", package: "vite", args: ["build"] },
      cwd: ".",
      required: true,
    });
  }
  return commands;
}

export async function executeQualificationCommand(command, { root }) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    };
    const child = spawn(command.executable, command.args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (error) => finish({
      exitCode: -1,
      spawnErrorCode: /^[A-Z0-9_]+$/u.test(String(error?.code || "")) ? String(error.code) : "SPAWN_FAILED",
    }));
    child.once("close", (exitCode, signal) => finish({
      exitCode: Number.isInteger(exitCode) ? exitCode : -1,
      ...(signal ? { signal } : {}),
    }));
  });
}

function normalizeCommandResult(command, result) {
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : -1;
  const durationMs = Number.isFinite(result?.durationMs) && result.durationMs >= 0
    ? Math.round(result.durationMs)
    : 0;
  return {
    id: command.id,
    label: command.label,
    required: command.required,
    command: {
      executable: command.executable,
      args: [...command.args],
      portable: command.portableCommand,
      cwd: command.cwd,
      shell: false,
    },
    durationMs,
    exitCode,
    status: exitCode === 0 ? "passed" : "failed",
    ...(result?.signal ? { signal: String(result.signal) } : {}),
    ...(result?.spawnErrorCode ? { spawnErrorCode: String(result.spawnErrorCode) } : {}),
  };
}

export function computeQualificationPayloadSha256(payload) {
  return sha256(canonicalJson(payload));
}

function qualificationDocument(payload) {
  return {
    payload,
    integrity: {
      algorithm: "sha256",
      canonicalization: "sorted-json-v1",
      payloadSha256: computeQualificationPayloadSha256(payload),
    },
  };
}

export function writeQualificationArtifactAtomic(outputPath, document) {
  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(resolvedOutputPath),
    `.${path.basename(resolvedOutputPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, resolvedOutputPath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    fail("AGENT_QUALIFICATION_ARTIFACT_WRITE_FAILED", String(error?.code || "UNKNOWN"));
  }
  return resolvedOutputPath;
}

export async function runAgentQualification({
  root,
  outputPath,
  includeFullTests = false,
  includeBuild = false,
  getGitState = readQualificationGitState,
  runCommand = executeQualificationCommand,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const resolvedOutputPath = path.resolve(outputPath || path.join(resolvedRoot, "artifacts/agent-qualification/latest.json"));
  assertQualificationOutputPathSafe(resolvedRoot, resolvedOutputPath);
  const startedAt = now().toISOString();
  const gitBefore = await Promise.resolve(getGitState(resolvedRoot));
  const commands = buildAgentQualificationCommands({ includeFullTests, includeBuild });
  const gates = [];
  for (const command of commands) {
    let result;
    try {
      result = await runCommand(command, { root: resolvedRoot });
    } catch {
      result = { exitCode: -1, durationMs: 0, spawnErrorCode: "RUNNER_EXCEPTION" };
    }
    gates.push(normalizeCommandResult(command, result));
  }
  const gitAfter = await Promise.resolve(getGitState(resolvedRoot));
  const repositoryStateChanged = gitBefore.commit !== gitAfter.commit || gitBefore.dirty !== gitAfter.dirty;
  const ontology = readQualificationOntologyState(resolvedRoot);
  const fixtures = inspectQualificationFixtures(resolvedRoot);
  const passed = (
    gates.every((gate) => gate.exitCode === 0)
    && !gitBefore.dirty
    && !gitAfter.dirty
    && !repositoryStateChanged
  );
  const payload = {
    schemaVersion: "1.0",
    artifactType: "agent_qualification",
    status: passed ? "passed" : "failed",
    evidenceClass: "deterministic_fixture",
    productionSnapshot: false,
    evidenceStatement: "A pass means only that deterministic repository fixtures and the selected local gates passed. It is not a production data snapshot or a model accuracy measurement.",
    startedAt,
    completedAt: now().toISOString(),
    repository: {
      commit: gitAfter.commit,
      dirty: Boolean(gitAfter.dirty),
      dirtyBefore: Boolean(gitBefore.dirty),
      stateChangedDuringQualification: repositoryStateChanged,
    },
    runtime: {
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      platform: process.platform,
      architecture: process.arch,
      environmentValuesCaptured: false,
      secretValuesCaptured: false,
    },
    ontology,
    fixtureSummary: {
      fileCount: fixtures.length,
      caseCount: fixtures.reduce((total, fixture) => total + fixture.caseCount, 0),
    },
    fixtures,
    selectedGates: {
      fullNodeTests: Boolean(includeFullTests),
      productionBuild: Boolean(includeBuild),
    },
    gates,
  };
  const document = qualificationDocument(payload);
  writeQualificationArtifactAtomic(resolvedOutputPath, document);
  return {
    document,
    outputPath: resolvedOutputPath,
    exitCode: passed ? 0 : 1,
  };
}

function assertArtifactGateContract(payload) {
  const selectedGates = payload?.selectedGates || {};
  const artifactNodeExecutable = payload?.runtime?.nodeExecutable;
  if (typeof artifactNodeExecutable !== "string" || !artifactNodeExecutable) {
    fail("AGENT_QUALIFICATION_NODE_EXECUTABLE_INVALID");
  }
  const expectedCommands = buildAgentQualificationCommands({
    includeFullTests: selectedGates.fullNodeTests === true,
    includeBuild: selectedGates.productionBuild === true,
  });
  if (!Array.isArray(payload?.gates) || payload.gates.length !== expectedCommands.length) {
    fail("AGENT_QUALIFICATION_GATE_SET_INVALID");
  }
  for (let index = 0; index < expectedCommands.length; index += 1) {
    const expected = expectedCommands[index];
    const actual = payload.gates[index];
    const portableArgumentTail = expected.portableCommand.script
      ? [expected.portableCommand.script, ...expected.portableCommand.args]
      : expected.portableCommand.args;
    const actualArguments = Array.isArray(actual?.command?.args) ? actual.command.args : [];
    if (
      actual?.id !== expected.id
      || actual?.required !== true
      || actual?.command?.executable !== artifactNodeExecutable
      || canonicalJson(actual?.command?.portable) !== canonicalJson(expected.portableCommand)
      || canonicalJson(actualArguments.slice(-portableArgumentTail.length)) !== canonicalJson(portableArgumentTail)
      || actual?.command?.cwd !== "."
      || actual?.command?.shell !== false
    ) {
      fail("AGENT_QUALIFICATION_GATE_COMMAND_INVALID", expected.id);
    }
    if (actual.exitCode !== 0 || actual.status !== "passed") {
      fail("AGENT_QUALIFICATION_NOT_PASSED", expected.id);
    }
  }
  for (const gateId of mandatoryGateIds) {
    if (!payload.gates.some((gate) => gate.id === gateId)) {
      fail("AGENT_QUALIFICATION_MANDATORY_GATE_MISSING", gateId);
    }
  }
}

export function verifyAgentQualification({
  root,
  artifactPath,
  getGitState = readQualificationGitState,
} = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const resolvedArtifactPath = path.resolve(artifactPath || path.join(resolvedRoot, "artifacts/agent-qualification/latest.json"));
  const document = readJson(resolvedArtifactPath, "AGENT_QUALIFICATION_ARTIFACT_INVALID");
  if (
    document?.integrity?.algorithm !== "sha256"
    || document.integrity.canonicalization !== "sorted-json-v1"
    || !/^[a-f0-9]{64}$/u.test(String(document.integrity.payloadSha256 || ""))
  ) {
    fail("AGENT_QUALIFICATION_INTEGRITY_METADATA_INVALID");
  }
  const computedHash = computeQualificationPayloadSha256(document.payload);
  if (computedHash !== document.integrity.payloadSha256) {
    fail("AGENT_QUALIFICATION_PAYLOAD_HASH_MISMATCH");
  }
  const payload = document.payload;
  if (payload?.schemaVersion !== "1.0" || payload?.artifactType !== "agent_qualification") {
    fail("AGENT_QUALIFICATION_SCHEMA_INVALID");
  }
  if (payload.evidenceClass !== "deterministic_fixture" || payload.productionSnapshot !== false) {
    fail("AGENT_QUALIFICATION_EVIDENCE_CLASS_INVALID");
  }
  if (payload.runtime?.environmentValuesCaptured !== false || payload.runtime?.secretValuesCaptured !== false) {
    fail("AGENT_QUALIFICATION_CAPTURE_POLICY_INVALID");
  }
  if (payload.repository?.dirtyBefore !== false || payload.repository?.dirty !== false) {
    fail("AGENT_QUALIFICATION_ARTIFACT_WORKTREE_DIRTY");
  }
  if (payload.status !== "passed" || payload.repository?.stateChangedDuringQualification !== false) {
    fail("AGENT_QUALIFICATION_NOT_PASSED");
  }
  assertArtifactGateContract(payload);

  const currentGit = getGitState(resolvedRoot);
  if (currentGit?.dirty !== false) {
    fail("AGENT_QUALIFICATION_CURRENT_WORKTREE_DIRTY");
  }
  if (currentGit?.commit !== payload.repository?.commit) {
    fail("AGENT_QUALIFICATION_GIT_COMMIT_DRIFT");
  }
  const currentFingerprint = readOntologyFingerprint(resolvedRoot);
  if (currentFingerprint !== payload.ontology?.fingerprint) {
    fail("AGENT_QUALIFICATION_ONTOLOGY_FINGERPRINT_DRIFT");
  }
  const currentOntology = readQualificationOntologyState(resolvedRoot);
  if (canonicalJson(currentOntology.runtimeMetricCounts) !== canonicalJson(payload.ontology?.runtimeMetricCounts)) {
    fail("AGENT_QUALIFICATION_RUNTIME_CAPABILITY_DRIFT");
  }
  const currentFixtures = inspectQualificationFixtures(resolvedRoot);
  if (canonicalJson(currentFixtures) !== canonicalJson(payload.fixtures)) {
    fail("AGENT_QUALIFICATION_FIXTURE_DRIFT");
  }
  const currentFixtureSummary = {
    fileCount: currentFixtures.length,
    caseCount: currentFixtures.reduce((total, fixture) => total + fixture.caseCount, 0),
  };
  if (canonicalJson(currentFixtureSummary) !== canonicalJson(payload.fixtureSummary)) {
    fail("AGENT_QUALIFICATION_FIXTURE_SUMMARY_INVALID");
  }
  return {
    valid: true,
    artifactPath: resolvedArtifactPath,
    payloadSha256: computedHash,
    repositoryCommit: payload.repository.commit,
    ontologyFingerprint: currentFingerprint,
  };
}
