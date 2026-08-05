// @vitest-environment node
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ACTOR_CAPABILITY_HEADER,
  createActorCapability,
  extractActorCapabilityHeader,
  getActorCapabilitySecret,
  verifyActorCapability,
  verifyActorCapabilityHeader,
} from "../../../server/agentActorCapability.mjs";

const TEST_SECRET = "test-actor-capability-secret";
const FIXED_NOW = 1_700_000_000;
const TEST_NONCE = "nonce-test-123456789";
const STATIC_SECRET = "static-cross-language-secret";
const STATIC_PAYLOAD = "{\"actorId\":\"actor-123\",\"scopeHash\":\"scope-hash-123\",\"scopes\":{\"workspaceIds\":[\"workspace-a\"],\"projectIds\":[\"project-a\"],\"teamIds\":[\"team-a\"],\"allowedObjectTypes\":[\"quality.defect\"],\"allowedPropertyIds\":[\"defect.status\"],\"rowPolicyIds\":[\"quality-readonly\"],\"sensitiveFieldPolicyIds\":[\"mask-reporter\"]},\"issuedAt\":1700000000,\"expiresAt\":1700000060,\"nonce\":\"nonce-static-12345678\",\"audience\":\"vizion-analytics\"}";
const STATIC_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3ItMTIzIiwic2NvcGVIYXNoIjoic2NvcGUtaGFzaC0xMjMiLCJzY29wZXMiOnsid29ya3NwYWNlSWRzIjpbIndvcmtzcGFjZS1hIl0sInByb2plY3RJZHMiOlsicHJvamVjdC1hIl0sInRlYW1JZHMiOlsidGVhbS1hIl0sImFsbG93ZWRPYmplY3RUeXBlcyI6WyJxdWFsaXR5LmRlZmVjdCJdLCJhbGxvd2VkUHJvcGVydHlJZHMiOlsiZGVmZWN0LnN0YXR1cyJdLCJyb3dQb2xpY3lJZHMiOlsicXVhbGl0eS1yZWFkb25seSJdLCJzZW5zaXRpdmVGaWVsZFBvbGljeUlkcyI6WyJtYXNrLXJlcG9ydGVyIl19LCJpc3N1ZWRBdCI6MTcwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzAwMDAwMDYwLCJub25jZSI6Im5vbmNlLXN0YXRpYy0xMjM0NTY3OCIsImF1ZGllbmNlIjoidml6aW9uLWFuYWx5dGljcyJ9.EWB62IJ54BrSaLOefgcC1OnrNYPcyxzNlgo1bPKrVLQ";
const EXPONENT_TIMESTAMP_PAYLOAD = "{\"actorId\":\"actor-123\",\"scopeHash\":\"scope-hash-123\",\"scopes\":{\"workspaceIds\":[\"workspace-a\"],\"projectIds\":[\"project-a\"],\"teamIds\":[\"team-a\"],\"allowedObjectTypes\":[\"quality.defect\"],\"allowedPropertyIds\":[\"defect.status\"],\"rowPolicyIds\":[\"quality-readonly\"],\"sensitiveFieldPolicyIds\":[\"mask-reporter\"]},\"issuedAt\":1e3,\"expiresAt\":1060,\"nonce\":\"nonce-static-12345678\",\"audience\":\"vizion-analytics\"}";
const EXPONENT_TIMESTAMP_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3ItMTIzIiwic2NvcGVIYXNoIjoic2NvcGUtaGFzaC0xMjMiLCJzY29wZXMiOnsid29ya3NwYWNlSWRzIjpbIndvcmtzcGFjZS1hIl0sInByb2plY3RJZHMiOlsicHJvamVjdC1hIl0sInRlYW1JZHMiOlsidGVhbS1hIl0sImFsbG93ZWRPYmplY3RUeXBlcyI6WyJxdWFsaXR5LmRlZmVjdCJdLCJhbGxvd2VkUHJvcGVydHlJZHMiOlsiZGVmZWN0LnN0YXR1cyJdLCJyb3dQb2xpY3lJZHMiOlsicXVhbGl0eS1yZWFkb25seSJdLCJzZW5zaXRpdmVGaWVsZFBvbGljeUlkcyI6WyJtYXNrLXJlcG9ydGVyIl19LCJpc3N1ZWRBdCI6MWUzLCJleHBpcmVzQXQiOjEwNjAsIm5vbmNlIjoibm9uY2Utc3RhdGljLTEyMzQ1Njc4IiwiYXVkaWVuY2UiOiJ2aXppb24tYW5hbHl0aWNzIn0.NGliSy8-EZ0XWDJ3ghJVjOZwllfdrQ1FTfT1_gV5cv4";

const MAX_TIMESTAMP = 9_007_199_254_740_991;
const ABOVE_MAX_TIMESTAMP_PAYLOAD = "{\"actorId\":\"actor-123\",\"scopeHash\":\"scope-hash-123\",\"scopes\":{\"workspaceIds\":[\"workspace-a\"],\"projectIds\":[\"project-a\"],\"teamIds\":[\"team-a\"],\"allowedObjectTypes\":[\"quality.defect\"],\"allowedPropertyIds\":[\"defect.status\"],\"rowPolicyIds\":[\"quality-readonly\"],\"sensitiveFieldPolicyIds\":[\"mask-reporter\"]},\"issuedAt\":9007199254740992,\"expiresAt\":9007199254740993,\"nonce\":\"nonce-static-12345678\",\"audience\":\"vizion-analytics\"}";
const ABOVE_MAX_TIMESTAMP_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3ItMTIzIiwic2NvcGVIYXNoIjoic2NvcGUtaGFzaC0xMjMiLCJzY29wZXMiOnsid29ya3NwYWNlSWRzIjpbIndvcmtzcGFjZS1hIl0sInByb2plY3RJZHMiOlsicHJvamVjdC1hIl0sInRlYW1JZHMiOlsidGVhbS1hIl0sImFsbG93ZWRPYmplY3RUeXBlcyI6WyJxdWFsaXR5LmRlZmVjdCJdLCJhbGxvd2VkUHJvcGVydHlJZHMiOlsiZGVmZWN0LnN0YXR1cyJdLCJyb3dQb2xpY3lJZHMiOlsicXVhbGl0eS1yZWFkb25seSJdLCJzZW5zaXRpdmVGaWVsZFBvbGljeUlkcyI6WyJtYXNrLXJlcG9ydGVyIl19LCJpc3N1ZWRBdCI6OTAwNzE5OTI1NDc0MDk5MiwiZXhwaXJlc0F0Ijo5MDA3MTk5MjU0NzQwOTkzLCJub25jZSI6Im5vbmNlLXN0YXRpYy0xMjM0NTY3OCIsImF1ZGllbmNlIjoidml6aW9uLWFuYWx5dGljcyJ9.PoKlEIv8pHrW_2cM6QJJAePa0mlywSkU52mlWUmF67k";
const LONE_SURROGATE_SCOPE_PAYLOAD = String.raw`{"actorId":"actor","scopeHash":"hash","scopes":{"workspaceIds":["\ud800"],"allowedObjectTypes":["thing"]},"issuedAt":1700000000,"expiresAt":1700000060,"nonce":"nonce-static-12345678","audience":"vizion-analytics"}`;
const LONE_SURROGATE_SCOPE_TOKEN = "v1.eyJhY3RvcklkIjoiYWN0b3IiLCJzY29wZUhhc2giOiJoYXNoIiwic2NvcGVzIjp7IndvcmtzcGFjZUlkcyI6WyJcdWQ4MDAiXSwiYWxsb3dlZE9iamVjdFR5cGVzIjpbInRoaW5nIl19LCJpc3N1ZWRBdCI6MTcwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzAwMDAwMDYwLCJub25jZSI6Im5vbmNlLXN0YXRpYy0xMjM0NTY3OCIsImF1ZGllbmNlIjoidml6aW9uLWFuYWx5dGljcyJ9.KBByAZUhruVPg_03MzRj2ZC1jIYNbqXGXHNq4vyiyqg";
const FORBIDDEN_EDGE_WHITESPACE = ["\u0085", "\uFEFF"];

const actor = {
  actorId: "actor-test",
  scopeHash: "scope-hash-test",
  scopes: {
    workspaceIds: ["workspace-a"],
    projectIds: ["project-b", "project-a"],
    teamIds: ["team-a"],
    allowedObjectTypes: ["quality.defect"],
    allowedPropertyIds: ["defect.status"],
    rowPolicyIds: ["quality-readonly"],
    sensitiveFieldPolicyIds: ["mask-reporter"],
  },
};

function captureError(callback: () => unknown) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected capability operation to throw");
}

function signTestPayload(payload: object, secret = TEST_SECRET) {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `v1.${payloadPart}`;
  const signaturePart = createHmac("sha256", secret).update(signingInput, "ascii").digest("base64url");
  return `${signingInput}.${signaturePart}`;
}

describe("agent actor capability", () => {
  it("creates and verifies a normalized short-lived capability", () => {
    const token = createActorCapability(actor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    });

    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyActorCapability(token, { secret: TEST_SECRET, now: FIXED_NOW + 1 })).toEqual({
      actorId: actor.actorId,
      scopeHash: actor.scopeHash,
      scopes: {
        ...actor.scopes,
        projectIds: ["project-a", "project-b"],
      },
      issuedAt: FIXED_NOW,
      expiresAt: FIXED_NOW + 60,
      nonce: TEST_NONCE,
      audience: "vizion-analytics",
    });
  });

  it("accepts the fixed cross-language wire-format vector", () => {
    expect(verifyActorCapability(STATIC_TOKEN, {
      secret: STATIC_SECRET,
      now: 1_700_000_001,
    })).toEqual(JSON.parse(STATIC_PAYLOAD));
  });

  it("rejects the fixed cross-language vector with an exponent timestamp", () => {
    expect(EXPONENT_TIMESTAMP_PAYLOAD).toContain("\"issuedAt\":1e3");
    expect(captureError(() => verifyActorCapability(EXPONENT_TIMESTAMP_TOKEN, {
      secret: STATIC_SECRET,
      now: 1_001,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects capability creation when the timestamp plus TTL exceeds the shared maximum", () => {
    expect(captureError(() => createActorCapability(actor, {
      secret: TEST_SECRET,
      now: MAX_TIMESTAMP,
      ttlSeconds: 1,
      nonce: TEST_NONCE,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects the hardcoded cross-language vector with timestamps above the shared maximum", () => {
    expect(ABOVE_MAX_TIMESTAMP_PAYLOAD).toContain("\"issuedAt\":9007199254740992");
    expect(captureError(() => verifyActorCapability(ABOVE_MAX_TIMESTAMP_TOKEN, {
      secret: STATIC_SECRET,
      now: MAX_TIMESTAMP,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects a tampered signature", () => {
    const token = createActorCapability(actor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    });
    const [version, payloadPart, signaturePart] = token.split(".");
    const tamperedToken = `${version}.${payloadPart}.${signaturePart.slice(0, -1)}A`;

    expect(captureError(() => verifyActorCapability(tamperedToken, {
      secret: TEST_SECRET,
      now: FIXED_NOW + 1,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects an expired capability", () => {
    const token = createActorCapability(actor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
      ttlSeconds: 1,
    });

    expect(captureError(() => verifyActorCapability(token, {
      secret: TEST_SECRET,
      now: FIXED_NOW + 2,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_EXPIRED" });
  });

  it("rejects a validly signed capability for the wrong audience", () => {
    const wrongAudienceToken = signTestPayload({
      ...JSON.parse(STATIC_PAYLOAD),
      audience: "other-service",
    }, STATIC_SECRET);

    expect(captureError(() => verifyActorCapability(wrongAudienceToken, {
      secret: STATIC_SECRET,
      now: 1_700_000_001,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects an invalid actor identifier before signing", () => {
    expect(captureError(() => createActorCapability({
      ...actor,
      actorId: " ",
    }, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects a sparse scope list before signing", () => {
    expect(captureError(() => createActorCapability({
      ...actor,
      scopes: {
        ...actor.scopes,
        workspaceIds: new Array(1),
      },
    }, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects explicit edge whitespace in every signed text input", () => {
    for (const edgeWhitespace of FORBIDDEN_EDGE_WHITESPACE) {
      for (const malformedActor of [
        { ...actor, actorId: `${edgeWhitespace}actor-test` },
        { ...actor, scopeHash: `${edgeWhitespace}scope-hash-test` },
        {
          ...actor,
          scopes: {
            ...actor.scopes,
            workspaceIds: [`${edgeWhitespace}workspace-a`],
          },
        },
      ]) {
        expect(captureError(() => createActorCapability(malformedActor, {
          secret: TEST_SECRET,
          now: FIXED_NOW,
          nonce: TEST_NONCE,
        }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
      }

      expect(captureError(() => createActorCapability(actor, {
        secret: TEST_SECRET,
        now: FIXED_NOW,
        nonce: `${edgeWhitespace}${TEST_NONCE}`,
      }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
    }
  });

  it("rejects a lone surrogate in creation input before signing", () => {
    expect(captureError(() => createActorCapability({
      ...actor,
      actorId: "\uD800",
    }, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects the hardcoded signed raw vector with an escaped lone surrogate scope", () => {
    const [version, payloadPart, signaturePart] = LONE_SURROGATE_SCOPE_TOKEN.split(".");
    expect(LONE_SURROGATE_SCOPE_PAYLOAD).toContain("\\ud800");
    expect(Buffer.from(payloadPart, "base64url").toString("utf8")).toBe(LONE_SURROGATE_SCOPE_PAYLOAD);
    expect(signaturePart).toBe(
      createHmac("sha256", STATIC_SECRET).update(`${version}.${payloadPart}`, "ascii").digest("base64url"),
    );
    expect(captureError(() => verifyActorCapability(LONE_SURROGATE_SCOPE_TOKEN, {
      secret: STATIC_SECRET,
      now: FIXED_NOW + 1,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("uses Unicode code points for normalized text length limits", () => {
    const atLimit = "\u{1F642}".repeat(256);
    const unicodeActor = {
      actorId: atLimit,
      scopeHash: atLimit,
      scopes: {
        workspaceIds: [atLimit],
        allowedObjectTypes: [atLimit],
      },
    };
    const token = createActorCapability(unicodeActor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    });

    expect(verifyActorCapability(token, {
      secret: TEST_SECRET,
      now: FIXED_NOW + 1,
    })).toMatchObject(unicodeActor);
    expect(captureError(() => createActorCapability({
      ...unicodeActor,
      actorId: `${atLimit}\u{1F642}`,
    }, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("rejects wildcard object-type scope before signing", () => {
    expect(captureError(() => createActorCapability({
      ...actor,
      scopes: {
        ...actor.scopes,
        allowedObjectTypes: ["*"],
      },
    }, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
  });

  it("extracts the capability from a case-insensitive server header map", () => {
    const token = createActorCapability(actor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    });

    expect(extractActorCapabilityHeader({
      [ACTOR_CAPABILITY_HEADER.toLowerCase()]: token,
    })).toBe(token);
  });

  it("extracts a capability header padded with ASCII space and horizontal tab", () => {
    const token = createActorCapability(actor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    });

    expect(extractActorCapabilityHeader({
      [ACTOR_CAPABILITY_HEADER]: ` \t${token}\t `,
    })).toBe(token);
  });

  it("rejects non-ASCII padding around a capability header", () => {
    const token = createActorCapability(actor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    });

    for (const edgeWhitespace of FORBIDDEN_EDGE_WHITESPACE) {
      for (const malformedHeader of [`${edgeWhitespace}${token}`, `${token}${edgeWhitespace}`]) {
        expect(captureError(() => extractActorCapabilityHeader({
          [ACTOR_CAPABILITY_HEADER]: malformedHeader,
        }))).toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
      }
    }
  });

  it("verifies object and Headers capability headers and rejects missing or multiple values", () => {
    const token = createActorCapability(actor, {
      secret: TEST_SECRET,
      now: FIXED_NOW,
      nonce: TEST_NONCE,
    });
    const options = { secret: TEST_SECRET, now: FIXED_NOW + 1 };
    const repeatedHeaders = new Headers();
    repeatedHeaders.append(ACTOR_CAPABILITY_HEADER, token);
    repeatedHeaders.append(ACTOR_CAPABILITY_HEADER, token);

    expect(verifyActorCapabilityHeader({ [ACTOR_CAPABILITY_HEADER]: token }, options))
      .toMatchObject({ actorId: actor.actorId });
    expect(verifyActorCapabilityHeader(new Headers({ [ACTOR_CAPABILITY_HEADER]: token }), options))
      .toMatchObject({ actorId: actor.actorId });
    expect(captureError(() => verifyActorCapabilityHeader({}, options)))
      .toMatchObject({ code: "ACTOR_CAPABILITY_MISSING", statusCode: 401 });

    for (const headers of [
      { [ACTOR_CAPABILITY_HEADER]: "not-a-capability" },
      { [ACTOR_CAPABILITY_HEADER]: [token] },
      {
        [ACTOR_CAPABILITY_HEADER]: token,
        [ACTOR_CAPABILITY_HEADER.toLowerCase()]: token,
      },
      repeatedHeaders,
    ]) {
      expect(captureError(() => verifyActorCapabilityHeader(headers, options)))
        .toMatchObject({ code: "ACTOR_CAPABILITY_INVALID" });
    }
  });

  it("treats a missing environment secret as server configuration failure", () => {
    expect(captureError(() => getActorCapabilitySecret({}))).toMatchObject({
      code: "ACTOR_CAPABILITY_CONFIGURATION_INVALID",
      statusCode: 503,
    });
  });
});