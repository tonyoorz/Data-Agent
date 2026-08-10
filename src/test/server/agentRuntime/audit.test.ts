// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime, alice } from "./runtimeFixture";

describe("Audit store", () => {
  let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
  beforeEach(async () => { fixture = await createTestRuntime(); });
  afterEach(() => fixture.cleanup());

  it("appends immutable redacted audit records", () => {
    const record = fixture.auditStore.append({ actor: alice, action: "runtime.start", threadId: "thread-1", runId: "run-1", details: { credential: "secret", apiKey: "key", authorization_header: "Bearer token", ok: true } });
    expect(JSON.stringify(record)).not.toMatch(/secret|Bearer token|key/);
    expect(() => fixture.runtimeDb.db.prepare("UPDATE agent_audit SET action='tamper' WHERE audit_id=?").run(record.auditId)).toThrow(/IMMUTABLE_AUDIT/);
  });
});