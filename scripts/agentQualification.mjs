import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentQualificationError,
  runAgentQualification,
  verifyAgentQualification,
} from "../server/agentQualification.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseAgentQualificationArgs(argv) {
  const options = {
    includeFullTests: false,
    includeBuild: false,
    requireFullTests: false,
    requireBuild: false,
    verify: false,
    help: false,
    output: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--full" || value === "--full-tests") {
      options.includeFullTests = true;
    } else if (value === "--build" || value === "--production-build") {
      options.includeBuild = true;
    } else if (value === "--verify") {
      options.verify = true;
    } else if (value === "--require-full" || value === "--require-full-tests") {
      options.requireFullTests = true;
    } else if (value === "--require-build" || value === "--require-production-build") {
      options.requireBuild = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else if (value === "--output") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new AgentQualificationError("AGENT_QUALIFICATION_OUTPUT_PATH_MISSING");
      options.output = next;
      index += 1;
    } else if (value.startsWith("--output=")) {
      options.output = value.slice("--output=".length);
      if (!options.output) throw new AgentQualificationError("AGENT_QUALIFICATION_OUTPUT_PATH_MISSING");
    } else {
      throw new AgentQualificationError("AGENT_QUALIFICATION_ARGUMENT_UNKNOWN", value);
    }
  }
  if (options.verify && (options.includeFullTests || options.includeBuild)) {
    throw new AgentQualificationError("AGENT_QUALIFICATION_VERIFY_FLAGS_INVALID");
  }
  if (!options.verify && (options.requireFullTests || options.requireBuild)) {
    throw new AgentQualificationError("AGENT_QUALIFICATION_RELEASE_VERIFY_FLAGS_INVALID");
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run agent:qualification -- [--full] [--build] [--output <path>]",
    "  npm run agent:qualification:verify -- [--require-full] [--require-build] [--output <path>]",
    "",
    "The default artifact path is artifacts/agent-qualification/latest.json.",
    "Python is not invoked implicitly; this qualification runs Node gates only.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), { root = defaultRoot } = {}) {
  const options = parseAgentQualificationArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const outputPath = path.resolve(root, options.output || "artifacts/agent-qualification/latest.json");
  if (options.verify) {
    const result = verifyAgentQualification({
      root,
      artifactPath: outputPath,
      requireFullTests: options.requireFullTests,
      requireBuild: options.requireBuild,
    });
    process.stdout.write(`${JSON.stringify({
      status: "verified",
      artifactPath: result.artifactPath,
      payloadSha256: result.payloadSha256,
      repositoryCommit: result.repositoryCommit,
      ontologyFingerprint: result.ontologyFingerprint,
    })}\n`);
    return 0;
  }
  const result = await runAgentQualification({
    root,
    outputPath,
    includeFullTests: options.includeFullTests,
    includeBuild: options.includeBuild,
  });
  process.stdout.write(`${JSON.stringify({
    status: result.document.payload.status,
    artifactPath: result.outputPath,
    payloadSha256: result.document.integrity.payloadSha256,
    fixtureCaseCount: result.document.payload.fixtureSummary.caseCount,
    gateCount: result.document.payload.gates.length,
  })}\n`);
  return result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const code = error instanceof AgentQualificationError ? error.code : "AGENT_QUALIFICATION_INTERNAL_ERROR";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 1;
  }
}
