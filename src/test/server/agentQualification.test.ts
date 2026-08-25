import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertQualificationOutputPathSafe,
  computeQualificationPayloadSha256,
  inspectQualificationBuildArtifact,
  isSupportedQualificationNodeVersion,
  runAgentQualification as runAgentQualificationImpl,
  verifyAgentQualification as verifyAgentQualificationImpl,
} from "../../../server/agentQualification.mjs";
import { inspectCheckoutNodeDependencies } from "../../../server/nodeDependencyBoundary.mjs";
import { parseAgentQualificationArgs } from "../../../scripts/agentQualification.mjs";

const temporaryRoots: string[] = [];
const COMMIT = "a".repeat(40);
const FINGERPRINT = "b".repeat(64);
const QUALIFIED_NODE_VERSION = "v24.14.0";

function runAgentQualification(options: Parameters<typeof runAgentQualificationImpl>[0]) {
  return runAgentQualificationImpl({ nodeVersion: QUALIFIED_NODE_VERSION, ...options });
}

function verifyAgentQualification(options: Parameters<typeof verifyAgentQualificationImpl>[0]) {
  return verifyAgentQualificationImpl({ currentNodeVersion: QUALIFIED_NODE_VERSION, ...options });
}

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
  const devDependencies = {
    vite: "^8.1.5",
    vitest: "^4.1.10",
  };
  writeJson(path.join(root, "package.json"), {
    name: "qualification-fixture",
    version: "1.0.0",
    devDependencies,
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "qualification-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "qualification-fixture", version: "1.0.0", devDependencies },
      "node_modules/vite": {
        version: "8.1.5",
        integrity: "sha512-dml0ZS1maXh0dXJl",
        dev: true,
      },
      "node_modules/vitest": {
        version: "4.1.10",
        integrity: "sha512-dml0ZXN0LWZpeHR1cmU=",
        dev: true,
      },
    },
  });
  writeJson(path.join(root, "node_modules/vite/package.json"), { name: "vite", version: "8.1.5" });
  fs.mkdirSync(path.join(root, "node_modules/vite/bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/vite/bin/vite.js"), "// fixture\n");
  writeJson(path.join(root, "node_modules/vitest/package.json"), { name: "vitest", version: "4.1.10" });
  fs.writeFileSync(path.join(root, "node_modules/vitest/vitest.mjs"), "// fixture\n");
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

function writeBuildFixture(root: string) {
  fs.mkdirSync(path.join(root, "dist/assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist/index.html"), "<!doctype html><div id=\"root\"></div>\n");
  fs.writeFileSync(path.join(root, "dist/assets/app.js"), "console.log('qualified');\n");
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
      requireFullTests: false,
      requireBuild: false,
      verify: true,
      output: "reports/result.json",
    });
    expect(parseAgentQualificationArgs(["--verify", "--require-full", "--require-build"])).toMatchObject({
      requireFullTests: true,
      requireBuild: true,
      verify: true,
    });
    expect(() => parseAgentQualificationArgs(["--verify", "--full"])).toThrow(
      "AGENT_QUALIFICATION_VERIFY_FLAGS_INVALID",
    );
    expect(() => parseAgentQualificationArgs(["--require-full"])).toThrow(
      "AGENT_QUALIFICATION_RELEASE_VERIFY_FLAGS_INVALID",
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
      schemaVersion: "1.2",
      artifactType: "agent_qualification",
      status: "passed",
      evidenceClass: "deterministic_fixture",
      productionSnapshot: false,
      repository: { commit: COMMIT, dirty: false },
      runtime: {
        nodeVersion: QUALIFIED_NODE_VERSION,
        supportedNodeMajor: 24,
        nodeVersionSupported: true,
        environmentValuesCaptured: false,
        secretValuesCaptured: false,
      },
      nodeDependencies: inspectCheckoutNodeDependencies(root),
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
    writeBuildFixture(root);
    const commandIds: string[] = [];

    const result = await runAgentQualification({
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
    expect(result.exitCode).toBe(0);
    expect(result.document.payload.buildArtifact).toEqual(inspectQualificationBuildArtifact(root));
    expect(() => verifyAgentQualification({
      root,
      artifactPath: outputPath,
      getGitState: gitState,
      requireFullTests: true,
      requireBuild: true,
    })).not.toThrow();
  });

  it("rejects a minimal artifact when release-profile verification is required", async () => {
    const { root, outputPath } = createRepositoryFixture();
    await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });

    expect(() => verifyAgentQualification({
      root,
      artifactPath: outputPath,
      getGitState: gitState,
      requireFullTests: true,
      requireBuild: true,
    })).toThrow("AGENT_QUALIFICATION_RELEASE_PROFILE_REQUIRED:full_node_tests");
  });

  it("fails qualification when the executing Node major is unsupported", async () => {
    const { root, outputPath } = createRepositoryFixture();

    const result = await runAgentQualification({
      root,
      outputPath,
      nodeVersion: "v22.22.3",
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });

    expect(isSupportedQualificationNodeVersion("v24.14.0")).toBe(true);
    expect(isSupportedQualificationNodeVersion("v22.22.3")).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.document.payload).toMatchObject({
      status: "failed",
      runtime: { nodeVersion: "v22.22.3", nodeVersionSupported: false },
    });
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

  it("rejects a rehashed artifact whose gate arguments contain an injected command prefix", async () => {
    const { root, outputPath } = createRepositoryFixture();
    await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });
    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    artifact.payload.gates[0].command.args = [
      "-e",
      "process.exit(0)",
      ...artifact.payload.gates[0].command.args,
    ];
    artifact.integrity.payloadSha256 = computeQualificationPayloadSha256(artifact.payload);
    writeJson(outputPath, artifact);

    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_GATE_COMMAND_INVALID:agent_evals",
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

  it("rejects production build artifact drift", async () => {
    const { root, outputPath } = createRepositoryFixture();
    writeBuildFixture(root);
    await runAgentQualification({
      root,
      outputPath,
      includeBuild: true,
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });

    fs.appendFileSync(path.join(root, "dist/assets/app.js"), "console.log('drift');\n");

    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_BUILD_ARTIFACT_DRIFT",
    );
  });

  it.runIf(process.platform !== "win32")("rejects a dist root symlink outside the candidate checkout", () => {
    const { root } = createRepositoryFixture();
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-qualification-external-dist-"));
    temporaryRoots.push(externalRoot);
    fs.writeFileSync(path.join(externalRoot, "index.html"), "<!doctype html>\n");
    fs.symlinkSync(externalRoot, path.join(root, "dist"), "dir");

    expect(() => inspectQualificationBuildArtifact(root)).toThrow(
      "AGENT_QUALIFICATION_BUILD_ARTIFACT_INVALID:dist",
    );
  });

  it("does not fall back to an ancestor checkout when candidate node_modules is absent", () => {
    const { root } = createRepositoryFixture();
    fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });

    expect(() => inspectCheckoutNodeDependencies(root)).toThrow(
      "AGENT_QUALIFICATION_NODE_MODULES_MISSING:node_modules",
    );
  });

  it("rejects an installed package version that does not match the candidate lockfile", () => {
    const { root } = createRepositoryFixture();
    writeJson(path.join(root, "node_modules/vite/package.json"), { name: "vite", version: "9.0.0" });

    expect(() => inspectCheckoutNodeDependencies(root)).toThrow(
      "AGENT_QUALIFICATION_NODE_PACKAGE_VERSION_MISMATCH:node_modules/vite",
    );
  });

  it("rejects a manifest direct dependency that has no locked installation entry", () => {
    const { root } = createRepositoryFixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    manifest.devDependencies["untracked-runner"] = "^1.0.0";
    lock.packages[""].devDependencies["untracked-runner"] = "^1.0.0";
    writeJson(path.join(root, "package.json"), manifest);
    writeJson(path.join(root, "package-lock.json"), lock);

    expect(() => inspectCheckoutNodeDependencies(root)).toThrow(
      "AGENT_QUALIFICATION_PACKAGE_LOCK_ENTRY_INVALID:untracked-runner",
    );
  });

  it("rejects dependency range drift between package.json and the lock root", () => {
    const { root } = createRepositoryFixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    manifest.devDependencies.vite = "^9.0.0";
    writeJson(path.join(root, "package.json"), manifest);

    expect(() => inspectCheckoutNodeDependencies(root)).toThrow(
      "AGENT_QUALIFICATION_PACKAGE_LOCK_MANIFEST_MISMATCH:devDependencies",
    );
  });

  it("detects ignored dependency bytes changed after qualification", async () => {
    const { root, outputPath } = createRepositoryFixture();
    await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async () => ({ exitCode: 0, durationMs: 1 }),
    });

    fs.appendFileSync(path.join(root, "node_modules/vitest/vitest.mjs"), "// tampered\n");
    expect(() => verifyAgentQualification({ root, artifactPath: outputPath, getGitState: gitState })).toThrow(
      "AGENT_QUALIFICATION_NODE_DEPENDENCY_DRIFT",
    );
  });

  it("fails qualification when a gate mutates the installed dependency tree", async () => {
    const { root, outputPath } = createRepositoryFixture();
    let mutated = false;
    const result = await runAgentQualification({
      root,
      outputPath,
      getGitState: gitState,
      runCommand: async () => {
        if (!mutated) {
          mutated = true;
          fs.appendFileSync(path.join(root, "node_modules/vite/bin/vite.js"), "// mutation\n");
        }
        return { exitCode: 0, durationMs: 1 };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.document.payload).toMatchObject({
      status: "failed",
      nodeDependencyStateChangedDuringQualification: true,
    });
  });

  it.runIf(process.platform !== "win32")("rejects a candidate node_modules symlink outside the checkout", () => {
    const { root } = createRepositoryFixture();
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-qualification-external-modules-"));
    temporaryRoots.push(externalRoot);
    fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
    fs.symlinkSync(externalRoot, path.join(root, "node_modules"), "dir");

    expect(() => inspectCheckoutNodeDependencies(root)).toThrow(
      "AGENT_QUALIFICATION_NODE_MODULES_MISSING:node_modules",
    );
  });

  it.runIf(process.platform !== "win32")("rejects package code symlinked into an excluded dependency cache", () => {
    const { root } = createRepositoryFixture();
    fs.mkdirSync(path.join(root, "node_modules/.cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/.cache/hidden-runtime.mjs"), "export const hidden = true;\n");
    fs.symlinkSync(
      path.join(root, "node_modules/.cache/hidden-runtime.mjs"),
      path.join(root, "node_modules/vitest/runtime.mjs"),
    );

    expect(() => inspectCheckoutNodeDependencies(root)).toThrow(
      "AGENT_QUALIFICATION_NODE_PACKAGE_UNHASHED_SYMLINK:vitest/runtime.mjs",
    );
  });

  it("rejects a package-lock path that traverses outside node_modules", () => {
    const { root } = createRepositoryFixture();
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-qualification-lock-traversal-"));
    temporaryRoots.push(externalRoot);
    writeJson(path.join(externalRoot, "package.json"), { name: "external", version: "9.9.9" });
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const traversalKey = `node_modules/../../${path.basename(externalRoot)}`;
    lock.packages[traversalKey] = { version: "9.9.9" };
    writeJson(path.join(root, "package-lock.json"), lock);

    expect(() => inspectCheckoutNodeDependencies(root)).toThrow(
      `AGENT_QUALIFICATION_PACKAGE_LOCK_PATH_INVALID:${traversalKey}`,
    );
  });
});
