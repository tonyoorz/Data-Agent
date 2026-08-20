// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileOntology, documentDefinitions } from "../../../scripts/compileOntology.mjs";
import { exportOntology, exportBundleToDocuments, serializeDocument } from "../../../scripts/ontoExport.mjs";
import { applyOntology, diffBundles } from "../../../scripts/ontoApply.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Envelope extras (locale/description/rules…) per file, read from the repo v1 sources. */
function readExtrasMap(dir = path.join(repoRoot, "ontology/v1")) {
  const extras: Record<string, any> = {};
  for (const definition of documentDefinitions) {
    const filePath = path.join(dir, definition.file);
    if (!fs.existsSync(filePath)) continue;
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rest: Record<string, any> = {};
    for (const [key, value] of Object.entries(doc)) {
      if (key === "schemaVersion" || key === "ontologyVersion" || key === definition.key) continue;
      rest[key] = value;
    }
    extras[definition.file] = rest;
  }
  return extras;
}

describe("Ontology-as-code round-trip (P1-C4)", () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function makeTemp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onto-roundtrip-"));
    temporaryRoots.push(dir);
    return dir;
  }

  it("export → apply → export is a fixed point (three-point equivalence)", () => {
    // 1) compile from the real repo sources
    const first = compileOntology({ root: repoRoot, outputDir: path.join(makeTemp(), "gen1") });

    // 2) export the compiled bundle into a fresh v1-style source dir
    const exportedDir = path.join(makeTemp(), "v1");
    const exported = exportOntology({
      compiledPath: (first as any).compiledPath,
      targetDir: exportedDir,
      extrasFromDir: path.join(repoRoot, "ontology/v1"),
    });
    expect(exported.changed).toHaveLength(10);

    // 3) recompile from the exported sources — fingerprint must be identical
    const second = compileOntology({
      root: repoRoot,
      sourceDir: exportedDir,
      outputDir: path.join(makeTemp(), "gen2"),
    });
    expect(second.fingerprint).toBe(first.fingerprint);

    // 4) export again — byte-for-byte identical (fixed point)
    const exportedAgain = exportOntology({
      compiledPath: (second as any).compiledPath,
      targetDir: exportedDir,
      extrasFromDir: exportedDir,
    });
    expect(exportedAgain.changed).toHaveLength(0);
    expect(exportedAgain.unchanged).toHaveLength(10);
  });

  it("repo v1 sources are in canonical exported form (CI guard)", () => {
    const compiled = compileOntology({ root: repoRoot, outputDir: path.join(makeTemp(), "gen") });
    const documents = exportBundleToDocuments(compiled.bundle, readExtrasMap());
    for (const [file, document] of Object.entries(documents)) {
      const sourceText = fs.readFileSync(path.join(repoRoot, "ontology/v1", file), "utf8");
      expect(
        serializeDocument(document),
        `${file} not in canonical exported form — run: node scripts/ontoExport.mjs`,
      ).toBe(sourceText);
    }
  });

  it("tampering with the compiled artifact without changing sources reports critical drift", () => {
    const sandbox = makeTemp();
    // copy the real v1 sources + schema into the sandbox
    fs.cpSync(path.join(repoRoot, "ontology/v1"), path.join(sandbox, "v1"), { recursive: true });
    fs.cpSync(path.join(repoRoot, "ontology/schema"), path.join(sandbox, "schema"), { recursive: true });
    // generate a clean artifact first
    compileOntology({
      root: sandbox,
      sourceDir: path.join(sandbox, "v1"),
      schemaDir: path.join(sandbox, "schema"),
      outputDir: path.join(sandbox, "generated"),
    });

    // tamper: flip a label in the compiled artifact only
    const artifactPath = path.join(sandbox, "generated", "ontology.compiled.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    artifact.entities[0].labels["zh-CN"] = "被篡改";
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

    const report = applyOntology({
      root: sandbox,
      sourceDir: path.join(sandbox, "v1"),
      schemaDir: path.join(sandbox, "schema"),
      outputDir: path.join(sandbox, "generated"),
      checkOnly: true,
    });
    expect(report.critical).toBe(true);
    expect(report.checked.artifactDiffers).toBe(true);
    expect(report.changes.some((c: any) => c.kind === "changed")).toBe(true);
  });

  it("diffBundles classifies added/removed/changed between bundles", () => {
    const base = {
      entities: [{ id: "a.keep", v: 1 }, { id: "a.drop", v: 1 }],
      metrics: [{ id: "m.change", v: 1 }],
    };
    const next = {
      entities: [{ id: "a.keep", v: 1 }, { id: "a.new", v: 2 }],
      metrics: [{ id: "m.change", v: 2 }],
    };
    const changes = diffBundles(next, base);
    expect(changes).toContainEqual(expect.objectContaining({ section: "entities", id: "a.new", kind: "added" }));
    expect(changes).toContainEqual(expect.objectContaining({ section: "entities", id: "a.drop", kind: "removed" }));
    expect(changes).toContainEqual(expect.objectContaining({ section: "metrics", id: "m.change", kind: "changed" }));
  });

  it("exportBundleToDocuments rejects bundles missing collections", () => {
    expect(() => exportBundleToDocuments({ schemaVersion: "1.0" }))
      .toThrow("ONTOLOGY_EXPORT_INVALID");
  });
});
