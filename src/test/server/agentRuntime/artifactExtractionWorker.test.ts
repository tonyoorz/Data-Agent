// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setupArtifactFixture } from "./artifactFixture";

describe("Artifact extraction worker", () => {
  it("extracts authorized text and stores a bounded text ref", async () => {
    const fixture = await setupArtifactFixture();
    try {
      const artifact = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "note.txt", declaredMime: "text/plain", bytes: Buffer.from("hello") });
      const extracted = await fixture.store.extractText({ actor: fixture.actor, artifactId: artifact.artifactId });
      expect(extracted).toMatchObject({ text: "hello", truncated: false, parserVersion: expect.any(String) });
      expect(extracted.textRef).toMatch(/^artifact-/);
      await expect(fixture.store.extractText({ actor: fixture.otherActor, artifactId: artifact.artifactId })).rejects.toThrow(/ARTIFACT_NOT_FOUND/);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects PDFs above 100 pages and truncates long text", async () => {
    const fixture = await setupArtifactFixture({ perArtifactBytes: 512 * 1024 });
    try {
      const tooManyPages = Buffer.from(`%PDF-1.4\n${"/Type /Page\n".repeat(101)}`);
      const pdf = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "long.pdf", declaredMime: "application/pdf", bytes: tooManyPages });
      await expect(fixture.store.extractText({ actor: fixture.actor, artifactId: pdf.artifactId })).rejects.toThrow(/PDF_PAGE_LIMIT_EXCEEDED/);

      const longText = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "long.txt", declaredMime: "text/plain", bytes: Buffer.alloc(200_001, 65) });
      const extracted = await fixture.store.extractText({ actor: fixture.actor, artifactId: longText.artifactId });
      expect(extracted.text).toHaveLength(200_000);
      expect(extracted.truncated).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});