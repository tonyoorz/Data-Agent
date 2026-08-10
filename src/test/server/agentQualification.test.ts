import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertQualificationOutputPathSafe,
  computeQualificationPayloadSha256,
  runAgentQualification,
  verifyAgentQualification,
} from "../../../server/agentQualification.mjs";
import { parseAgentQualificationArgs } from "../../../scripts/agentQualification.mjs";

const temporaryRoots: string[] = [];
const COMMIT = "a".repeat(40);
const FINGERPRINT = "b".repeat(64);

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-qualification-"));
  temporaryRoots.push(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "artifacts/\n");
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore", shell: false });
  if (gitInit.status !== 0) throw new Error("test git init failed");
  fs.mkdirSync(path.join(root, "ontology/generated"), { recursive: true });
  fs.writeFileSync(path.join(root, "ontology/generated/fingerprint.txt"), `${FINGERPRINT}\n`);
  writeJson(path.join(root, "ontology/generated/runtime-capabilities.json"), {
    ontologyFingerprint: FINGERPRINT,
    metrics: [
      { metricId: "defect.count", runtimeStatus: "ready" },
      { metricId: "testing.run_count", runtimeStatus: "ready" },
      { metricId: "kpi.coverage", runtimeStatus: "planned" },
    ],
  });
  fs.mkdirSync(path.join(root, "evals/main-agent/target"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "evals/main-agent/target/agent-golden.jsonl"),
    `${JSON.stringify({ caseId: "agent-001" })}\n${JSON.stringify({ caseId: "agent-002" })}\n`,
  );
  fs.writeFileSync(
    path.join(root, "evals/main-agent/target/policy-golden.jsonl"),
    `${JSON.stringify({ caseId: "policy-001" })}\n`,
  );
  return {
    root,
    outputPath: path.join(root, "artifacts/agent-qualification.json"),
  };
}

function gitState() {
  return { commit: COMMIT, dirty: false };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("agent qualification artifact", () => {
  it("parses portable CLI flags and keeps verify mode read-only", () => {
    expect(parseAgentQualificationArgs(["--full", "--build", "--output", "reports/result.json"])).toMatchObject({
      includeFullTests: true,
      includeBuild: true,
      verify: false,
      output: "reports/result.json",
    });
    expect(parseAgentQualificationArgs(["--verify", "--output=reports/result.json"])).toMatchObject({
      includeFullTests: false,
      includeBuild: false,
      verify: true,
      output: "reports/result.json",
    });
    expect(() => parseAgentQualificationArgs(["--verify", "--full"])).toThrow(
      "AGENT_QUALIFICATION_VERIFY_FLAGS_INVALID",
    );
  });

  it("requires generated artifacts inside the checkout to be Git-ignored", () => {
    const { root } = createRepositoryFixture();

    expect(() => assertQualificationOutputPathSafe(root, path.join(root, "qualification.json"))).toThrow(
      "AGENT_QUALIFICATION_OUTPUT_PATH_NOT_IGNORED",
    );
    expect(() => assertQualificationOutputPathSafe(root, path.join(root, "artifacts/qualification.json"))).not.toThrow();
    expect(() => assertQualificationOutputPathSafe(root, path.join(os.tmpdir(), "external-qualification.json"))).not.toThrow();
  });

  it("runs the required gates and writes a hashed deterministic-fixture artifact atomically", async () => {
    const { root, outputPath } = createRepositoryFixture();
    const observedCommands: Array<{ id: string; executable: string; args: string[] }> = [];

    const result = await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async (command) => {
        observedCommands.push(command);
        return { exitCode: 0, durationMs: command.id === "agent_evals" ? 120 : 30 };
      },
      now: () => new Date("2026-08-10T08:00:00.000Z"),
    });

    expect(result.exitCode).toBe(0);
    expect(observedCommands.map((command) => command.id)).toEqual(["agent_evals", "ontology_check"]);
    expect(observedCommands.every((command) => command.executable === process.execPath)).toBe(true);
    expect(result.document.payload).toMatchObject({
      schemaVersion: "1.0",
      artifactType: "agent_qualification",
      status: "passed",
      evidenceClass: "deterministic_fixture",
      productionSnapshot: false,
      repository: { commit: COMMIT, dirty: false },
      runtime: {
        nodeVersion: process.version,
        environmentValuesCaptured: false,
        secretValuesCaptured: false,
      },
      ontology: {
        fingerprint: FINGERPRINT,
        runtimeMetricCounts: { ready: 2, planned: 1, total: 3 },
      },
      fixtureSummary: { fileCount: 2, caseCount: 3 },
      fixtures: [
        expect.objectContaining({ path: "evals/main-agent/target/agent-golden.jsonl", caseCount: 2 }),
        expect.objectContaining({ path: "evals/main-agent/target/policy-golden.jsonl", caseCount: 1 }),
      ],
      gates: [
        expect.objectContaining({ id: "agent_evals", durationMs: 120, exitCode: 0, status: "passed" }),
        expect.objectContaining({ id: "ontology_check", durationMs: 30, exitCode: 0, status: "passed" }),
      ],
    });
    expect(result.document.payload).not.toHaveProperty("environment");
    expect(result.document.integrity).toEqual({
      algorithm: "sha256",
      canonicalization: "sorted-json-v1",
      payloadSha256: computeQualificationPayloadSha256(result.document.payload),
    });
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual(result.document);
    expect(fs.readdirSync(path.dirname(outputPath)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("adds full tests and build only when explicitly requested", async () => {
    const { root, outputPath } = createRepositoryFixture();
    const commandIds: string[] = [];

    await runAgentQualification({
      root,
      outputPath,
      includeFullTests: true,
      includeBuild: true,
      getGitState: gitState,
      runCommand: async (command) => {
        commandIds.push(command.id);
        return { exitCode: 0, durationMs: 1 };
      },
    });

    expect(commandIds).toEqual(["agent_evals", "ontology_check", "full_node_tests", "production_build"]);
  });

  it("writes a failed artifact and returns non-zero when any command fails", async () => {
    const { root, outputPath } = createRepositoryFixture();

    const result = await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async (command) => ({
        exitCode: command.id === "agent_evals" ? 1 : 0,
        durationMs: 5,
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.document.payload.status).toBe("failed");
    expect(result.document.payload.gates).toEqual([
      expect.objectContaining({ id: "agent_evals", exitCode: 1, status: "failed" }),
      expect.objectContaining({ id: "ontology_check", exitCode: 0, status: "passed" }),
    ]);
    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_NOT_PASSED",
    );
  });

  it("never qualifies a dirty worktree and verify rejects artifact or current-checkout dirtiness", async () => {
    const { root, outputPath } = createRepositoryFixture();
    const dirtyGitState = () => ({ commit: COMMIT, dirty: true });
    const dirtyResult = await runAgentQualification({
      root,
      outputPath,
      getGitState: dirtyGitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });

    expect(dirtyResult.exitCode).toBe(1);
    expect(dirtyResult.document.payload).toMatchObject({
      status: "failed",
      repository: { dirtyBefore: true, dirty: true },
    });

    await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });
    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    artifact.payload.repository.dirty = true;
    artifact.integrity.payloadSha256 = computeQualificationPayloadSha256(artifact.payload);
    writeJson(outputPath, artifact);
    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_ARTIFACT_WORKTREE_DIRTY",
    );

    artifact.payload.repository.dirty = false;
    artifact.integrity.payloadSha256 = computeQualificationPayloadSha256(artifact.payload);
    writeJson(outputPath, artifact);
    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: dirtyGitState })).toThrow(
      "AGENT_QUALIFICATION_CURRENT_WORKTREE_DIRTY",
    );
  });

  it("rejects payload tampering and current ontology fingerprint drift", async () => {
    const { root, outputPath } = createRepositoryFixture();
    await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });

    const tampered = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    tampered.payload.repository.dirty = true;
    writeJson(outputPath, tampered);
    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_PAYLOAD_HASH_MISMATCH",
    );

    tampered.payload.repository.dirty = false;
    tampered.integrity.payloadSha256 = computeQualificationPayloadSha256(tampered.payload);
    writeJson(outputPath, tampered);
    fs.writeFileSync(path.join(root, "ontology/generated/fingerprint.txt"), `${"c".repeat(64)}\n`);
    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_ONTOLOGY_FINGERPRINT_DRIFT",
    );
  });

  it("rejects fixture drift even when the artifact payload remains intact", async () => {
    const { root, outputPath } = createRepositoryFixture();
    await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });

    fs.appendFileSync(
      path.join(root, "evals/main-agent/target/agent-golden.jsonl"),
      `${JSON.stringify({ caseId: "agent-003" })}\n`,
    );

    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_FIXTURE_DRIFT",
    );
  });
});
