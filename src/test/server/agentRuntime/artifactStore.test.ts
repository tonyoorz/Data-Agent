// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setupArtifactFixture } from "./artifactFixture";

describe("ArtifactStore", () => {
  it("stores an allowed PDF by server-generated content path", async () => {
    const fixture = await setupArtifactFixture();
    try {
      const bytes = Buffer.from("%PDF-1.4\nfixture");
      const artifact = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "requirement.pdf", declaredMime: "application/pdf", bytes });
      expect(artifact).not.toHaveProperty("storagePath");
      expect(artifact.contentHash).toHaveLength(64);
      expect(fixture.store.get({ actor: fixture.actor, artifactId: artifact.artifactId }).bytes.equals(bytes)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("denies cross-actor reads, spoofed MIME, per-artifact and actor quota overflow", async () => {
    const fixture = await setupArtifactFixture({ perArtifactBytes: 16, perRunBytes: 20, perActorBytes: 32 });
    try {
      const artifact = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "a.txt", declaredMime: "text/plain", bytes: Buffer.from("text") });
      expect(() => fixture.store.get({ actor: fixture.otherActor, artifactId: artifact.artifactId })).toThrow(/ARTIFACT_NOT_FOUND/);
      await expect(fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "fake.png", declaredMime: "image/png", bytes: Buffer.from("not png") })).rejects.toThrow(/MIME_MISMATCH/);
      await expect(fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "bad.json", declaredMime: "application/json", bytes: Buffer.from("not-json") })).rejects.toThrow(/JSON_INVALID/);
      await expect(fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "bad.txt", declaredMime: "text/plain", bytes: Buffer.from([0xff, 0xfe, 0xfd]) })).rejects.toThrow(/MIME_MISMATCH/);
      await expect(fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "large.txt", declaredMime: "text/plain", bytes: Buffer.alloc(17, 65) })).rejects.toThrow(/ARTIFACT_TOO_LARGE/);
      await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "b.txt", declaredMime: "text/plain", bytes: Buffer.alloc(15, 66) });
      await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "c.txt", declaredMime: "text/plain", bytes: Buffer.alloc(12, 67) });
      await expect(fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "d.txt", declaredMime: "text/plain", bytes: Buffer.alloc(2, 68) })).rejects.toThrow(/ACTOR_ARTIFACT_QUOTA_EXCEEDED/);
    } finally {
      fixture.cleanup();
    }
  });

  it("deduplicates blobs but keeps actor-scoped refs and enforces run limits", async () => {
    const fixture = await setupArtifactFixture({ perArtifactBytes: 64, perRunBytes: 20, perActorBytes: 200 });
    try {
      const a = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "a.txt", declaredMime: "text/plain", bytes: Buffer.from("same") });
      const b = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "b.txt", declaredMime: "text/plain", bytes: Buffer.from("same") });
      const c = await fixture.store.put({ actor: fixture.otherActor, threadId: fixture.otherThreadId, fileName: "c.txt", declaredMime: "text/plain", bytes: Buffer.from("same") });
      expect(a.artifactId).toBe(b.artifactId);
      expect(c.artifactId).not.toBe(a.artifactId);
      fixture.store.attachToRun({ actor: fixture.actor, runId: fixture.runId, artifactIds: [a.artifactId] });
      const extra = [];
      for (let index = 0; index < 5; index += 1) {
        extra.push((await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: `x-${index}.txt`, declaredMime: "text/plain", bytes: Buffer.from(`x${index}`) })).artifactId);
      }
      expect(() => fixture.store.attachToRun({ actor: fixture.actor, runId: fixture.runId, artifactIds: [a.artifactId, ...extra] })).toThrow(/RUN_ARTIFACT_COUNT_EXCEEDED/);

      const bigOne = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "big-one.txt", declaredMime: "text/plain", bytes: Buffer.alloc(12, 69) });
      const bigTwo = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "big-two.txt", declaredMime: "text/plain", bytes: Buffer.alloc(12, 70) });
      expect(() => fixture.store.attachToRun({ actor: fixture.actor, runId: fixture.runId, artifactIds: [bigOne.artifactId, bigTwo.artifactId] })).toThrow(/RUN_ARTIFACT_BYTES_EXCEEDED/);
    } finally {
      fixture.cleanup();
    }
  });

  it("cleans expired artifacts and frees actor quota", async () => {
    const fixture = await setupArtifactFixture({ perArtifactBytes: 16, perRunBytes: 20, perActorBytes: 8 });
    try {
      const artifact = await fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "old.txt", declaredMime: "text/plain", bytes: Buffer.alloc(8, 65) });
      fixture.store.get({ actor: fixture.actor, artifactId: artifact.artifactId });
      await expect(fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "blocked.txt", declaredMime: "text/plain", bytes: Buffer.from("x") })).rejects.toThrow(/ACTOR_ARTIFACT_QUOTA_EXCEEDED/);
      fixture.store.cleanupExpired({ asOf: "2026-07-21T00:00:01.000Z" });
      expect(() => fixture.store.get({ actor: fixture.actor, artifactId: artifact.artifactId })).toThrow(/ARTIFACT_NOT_FOUND/);
      await expect(fixture.store.put({ actor: fixture.actor, threadId: fixture.threadId, fileName: "new.txt", declaredMime: "text/plain", bytes: Buffer.from("x") })).resolves.toMatchObject({ fileName: "new.txt" });
    } finally {
      fixture.cleanup();
    }
  });
});