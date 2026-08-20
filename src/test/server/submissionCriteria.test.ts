// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  evaluateSubmissionCriteria,
  actorToCriteriaContext,
} from "../../../server/agentRuntime/submissionCriteria.mjs";

describe("Submission criteria engine (P1-C5)", () => {
  it("userGroup: allows actors inside the required group", () => {
    const result = evaluateSubmissionCriteria(
      [{ kind: "userGroup", userGroup: "dtsv_team" }],
      { groups: ["dtsv_team", "quality_governance"] },
    );
    expect(result.allowed).toBe(true);
    expect(result.unmet).toHaveLength(0);
  });

  it("userGroup: rejects actors outside the group with an explicit message", () => {
    const result = evaluateSubmissionCriteria(
      [{ kind: "userGroup", userGroup: "quality_governance" }],
      { groups: ["dtsv_team"] },
    );
    expect(result.allowed).toBe(false);
    expect(result.unmet[0].message).toContain("quality_governance");
    expect(result.unmet[0].message).toContain("dtsv_team");
  });

  it("actorAttribute: matches single value and enum values", () => {
    expect(evaluateSubmissionCriteria(
      [{ kind: "actorAttribute", attribute: "teamId", value: "DTSV" }],
      { attributes: { teamId: "DTSV" } },
    ).allowed).toBe(true);

    expect(evaluateSubmissionCriteria(
      [{ kind: "actorAttribute", attribute: "teamId", values: ["DTSV", "QG"] }],
      { attributes: { teamId: "QG" } },
    ).allowed).toBe(true);

    expect(evaluateSubmissionCriteria(
      [{ kind: "actorAttribute", attribute: "teamId", value: "DTSV" }],
      { attributes: { teamId: "OTHER" } },
    ).allowed).toBe(false);

    const missing = evaluateSubmissionCriteria(
      [{ kind: "actorAttribute", attribute: "teamId", value: "DTSV" }],
      { attributes: {} },
    );
    expect(missing.allowed).toBe(false);
    expect(missing.unmet[0].message).toContain("missing attribute teamId");
  });

  it("timeWindow: workHours honors Shanghai local time", () => {
    // 2026-08-20 is a Thursday. 10:00 Shanghai (=02:00 UTC) is inside work hours.
    expect(evaluateSubmissionCriteria(
      [{ kind: "timeWindow", window: "workHours" }],
      { now: "2026-08-20T02:00:00.000Z" },
    ).allowed).toBe(true);

    // 22:00 Shanghai (14:00 UTC) is outside work hours.
    const night = evaluateSubmissionCriteria(
      [{ kind: "timeWindow", window: "workHours" }],
      { now: "2026-08-20T14:00:00.000Z" },
    );
    expect(night.allowed).toBe(false);
    expect(night.unmet[0].message).toMatch(/hour=22/);

    // Sunday 10:00 Shanghai is a weekend.
    // 2026-08-23 is a Sunday (03:00 UTC = 11:00 Shanghai).
    expect(evaluateSubmissionCriteria(
      [{ kind: "timeWindow", window: "workHours" }],
      { now: "2026-08-23T03:00:00.000Z" },
    ).allowed).toBe(false);
  });

  it("scenario: sandbox-only actions block production submissions", () => {
    expect(evaluateSubmissionCriteria(
      [{ kind: "scenario", scenario: "sandbox" }],
      { scenario: "sandbox" },
    ).allowed).toBe(true);

    const blocked = evaluateSubmissionCriteria(
      [{ kind: "scenario", scenario: "sandbox" }],
      { scenario: "production" },
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.unmet[0].message).toContain("scenario=production");
  });

  it("AND semantics: all criteria must pass; unmet list names each failure", () => {
    const criteria = [
      { kind: "userGroup", userGroup: "dtsv_team" },
      { kind: "actorAttribute", attribute: "teamId", value: "DTSV" },
      { kind: "timeWindow", window: "workHours" },
    ];
    // only the group passes; attribute + timeWindow fail
    const result = evaluateSubmissionCriteria(criteria, {
      groups: ["dtsv_team"],
      attributes: { teamId: "OTHER" },
      now: "2026-08-20T14:00:00.000Z",
    });
    expect(result.allowed).toBe(false);
    expect(result.unmet).toHaveLength(2);
    expect(result.unmet.map((u) => u.kind).sort()).toEqual(["actorAttribute", "timeWindow"]);
    expect(result.evaluated).toHaveLength(3);
  });

  it("unknown criterion kinds fail closed", () => {
    const result = evaluateSubmissionCriteria([{ kind: "quantumSignature" }], {});
    expect(result.allowed).toBe(false);
    expect(result.unmet[0].message).toContain("unknown criterion kind: quantumSignature");
  });

  it("empty criteria list allows submission", () => {
    expect(evaluateSubmissionCriteria([], {}).allowed).toBe(true);
    expect(evaluateSubmissionCriteria(undefined, {}).allowed).toBe(true);
  });

  it("actorToCriteriaContext maps scopes/teamIds to groups", () => {
    const ctx = actorToCriteriaContext(
      { actorId: "alice", scopes: { teamIds: ["DTSV"] }, attributes: { teamId: "DTSV" } },
      { scenario: "sandbox", now: "2026-08-20T02:00:00.000Z" },
    );
    expect(ctx.groups).toContain("DTSV");
    expect(ctx.scenario).toBe("sandbox");
    expect(ctx.now).toBe("2026-08-20T02:00:00.000Z");
    expect(evaluateSubmissionCriteria(
      [{ kind: "userGroup", userGroup: "DTSV" }],
      ctx,
    ).allowed).toBe(true);
  });
});
