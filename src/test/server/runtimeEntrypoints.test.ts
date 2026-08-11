import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("qualified runtime entrypoints", () => {
  it("routes standalone development services through versioned wrappers", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

    expect(packageJson.scripts["dev:analytics"]).toBe("node ./scripts/devAnalytics.mjs");
    expect(packageJson.scripts["dev:client"]).toBe("node ./scripts/devClient.mjs");
    expect(packageJson.scripts["predev:server"]).toBe("node ./scripts/ensureNodeVersion.mjs");
    expect(packageJson.scripts["report:qgate-kpi"]).toContain("scripts/runPython.mjs");
    expect(packageJson.scripts["test:ontology"]).toContain("scripts/runPython.mjs");
    expect(packageJson.scripts["pretest:ontology"]).toBe("node ./scripts/ensureNodeVersion.mjs");
  });

  it("keeps the Windows nightly refresh on the qualified Python 3.12 line", () => {
    const refreshScript = fs.readFileSync(path.join(repoRoot, "scripts/run-nightly-source-refresh.ps1"), "utf8");

    expect(refreshScript).toContain('[string]$PythonExecutable = ""');
    expect(refreshScript).toContain('Join-Path $repoRoot ".venv\\Scripts\\python.exe"');
    expect(refreshScript).toContain('assert sys.version_info[:2] == (3, 12)');
    expect(refreshScript).toContain('$env:PYTHONNOUSERSITE = "1"');
    expect(refreshScript).toContain('"DUPSEARCH_CHAT_"');
    expect(refreshScript).toContain('"VIZION_OIDC_"');
    expect(refreshScript).not.toContain('$PythonVersion');
    expect(refreshScript).not.toContain('$PythonLauncher');
  });
});
