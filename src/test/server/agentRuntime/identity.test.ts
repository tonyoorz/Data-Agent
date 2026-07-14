import { describe, expect, it, vi } from "vitest";
import { createIdentityResolver } from "../../../../server/agentRuntime/identity.mjs";

const scopes = {
  workspaceIds: ["DTSV_China"],
  projectIds: ["SP25"],
  teamIds: ["DTSV"],
  allowedObjectTypes: ["defect"],
  allowedPropertyIds: [],
  rowPolicyIds: ["dtsv"],
  sensitiveFieldPolicyIds: [],
};

const request = (overrides = {}) => {
  const { headers: headerOverrides = {}, ...rest } = overrides;
  return {
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: {
    "x-forwarded-proto": "https",
    "x-agent-actor-id": "alice",
    "x-agent-auth-session-id": "session-1",
    "x-agent-roles": "qa,viewer",
      ...headerOverrides,
    },
    body: { actorId: "mallory", scopes: { workspaceIds: ["ALL"] } },
    ...rest,
  };
};

describe("Phase 1 identity boundary", () => {
  it("derives actor and scopes from a trusted proxy, never request body", async () => {
    const scopeProvider = vi.fn().mockResolvedValue({ scopeVersion: "scope-v1", scopes });
    const resolveIdentity = createIdentityResolver({
      mode: "trusted-proxy",
      trustedProxyAddresses: ["127.0.0.1"],
      scopeProvider,
      devActor: null,
    });

    const actor = await resolveIdentity(request());

    expect(actor).toMatchObject({
      actorId: "alice",
      authSessionId: "session-1",
      roles: ["qa", "viewer"],
      scopeVersion: "scope-v1",
      scopes,
    });
    expect(actor.scopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(actor).not.toHaveProperty("body");
    expect(scopeProvider).toHaveBeenCalledWith(expect.objectContaining({ actorId: "alice", roles: ["qa", "viewer"] }));
  });

  it("rejects untrusted peers, missing headers and non-HTTPS forwarding", async () => {
    const resolveIdentity = createIdentityResolver({
      mode: "trusted-proxy",
      trustedProxyAddresses: ["10.0.0.10"],
      scopeProvider: vi.fn().mockResolvedValue({ scopeVersion: "scope-v1", scopes }),
      devActor: null,
    });

    await expect(resolveIdentity(request())).rejects.toMatchObject({ code: "UNTRUSTED_PROXY" });
    await expect(createIdentityResolver({
      mode: "trusted-proxy",
      trustedProxyAddresses: ["127.0.0.1"],
      scopeProvider: vi.fn().mockResolvedValue({ scopeVersion: "scope-v1", scopes }),
      devActor: null,
    })(request({ headers: { "x-agent-actor-id": "" } }))).rejects.toMatchObject({ code: "TRUSTED_IDENTITY_MISSING" });
    await expect(createIdentityResolver({
      mode: "trusted-proxy",
      trustedProxyAddresses: ["127.0.0.1"],
      scopeProvider: vi.fn().mockResolvedValue({ scopeVersion: "scope-v1", scopes }),
      devActor: null,
    })(request({ headers: { "x-forwarded-proto": "http" } }))).rejects.toMatchObject({ code: "TRUSTED_PROXY_TLS_REQUIRED" });
  });

  it("uses stable scope hashes and rotates when scope changes", async () => {
    const resolveA = createIdentityResolver({
      mode: "dev",
      trustedProxyAddresses: [],
      scopeProvider: null,
      devActor: { actorId: "dev", authSessionId: "dev-session", roles: ["developer"], scopes: { ...scopes, projectIds: ["B", "A"] }, scopeVersion: "v1" },
    });
    const resolveB = createIdentityResolver({
      mode: "dev",
      trustedProxyAddresses: [],
      scopeProvider: null,
      devActor: { actorId: "dev", authSessionId: "dev-session", roles: ["developer"], scopes: { ...scopes, projectIds: ["A", "B"] }, scopeVersion: "v1" },
    });
    const resolveC = createIdentityResolver({
      mode: "dev",
      trustedProxyAddresses: [],
      scopeProvider: null,
      devActor: { actorId: "dev", authSessionId: "dev-session", roles: ["developer"], scopes, scopeVersion: "v2" },
    });

    const actorA = await resolveA(request());
    const actorB = await resolveB(request());
    const actorC = await resolveC(request());

    expect(actorA.scopeHash).toBe(actorB.scopeHash);
    expect(actorA.scopeHash).not.toBe(actorC.scopeHash);
  });
});