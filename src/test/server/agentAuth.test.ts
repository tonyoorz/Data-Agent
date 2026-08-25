// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { errors } from "jose";

import * as agentAuth from "../../../server/agentAuth.mjs";
import { resolveInternalActorScope } from "../../../server/internalActorScope.mjs";
import {
  createOidcScopePolicy,
  createOidcTokenVerifier,
  resolveInternalAuxiliaryActor,
  resolveAuthenticatedChatBody,
  resolveRequestActor,
  toSafeAgentAuthResponse,
} from "../../../server/agentAuth.mjs";

const qualityReaderPolicy = createOidcScopePolicy({
  groups: {
    "quality-readers": {
      workspaceIds: ["workspace-a"],
      projectIds: ["project-a"],
      teamIds: ["quality-team"],
      allowedObjectTypes: ["quality.defect"],
      allowedPropertyIds: ["defect.status"],
      rowPolicyIds: ["quality-readonly"],
      sensitiveFieldPolicyIds: ["mask-reporter"],
    },
  },
});

const oidcEnv = { VIZION_AGENT_AUTH_MODE: "oidc" };
const oidcVerifierEnv = {
  ...oidcEnv,
  VIZION_OIDC_ISSUER: "https://issuer.example.test",
  VIZION_OIDC_AUDIENCE: "vizion-agent",
  VIZION_OIDC_JWKS_URI: "https://issuer.example.test/.well-known/jwks.json",
};

describe("request actor authentication", () => {
  it("allows duplicate/context auxiliary routes only for the trusted internal principal", async () => {
    await expect(resolveInternalAuxiliaryActor(
      { headers: {} },
      { env: { VIZION_AGENT_AUTH_MODE: "internal" } },
    )).resolves.toMatchObject({ scopeHash: expect.stringMatching(/^internal-/) });

    await expect(resolveInternalAuxiliaryActor(
      { headers: { authorization: "Bearer verified-token" } },
      {
        env: oidcEnv,
        verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"] }),
        scopePolicy: qualityReaderPolicy,
      },
    )).rejects.toMatchObject({ code: "AUXILIARY_ROUTE_SCOPE_DENIED", statusCode: 403 });
  });
  it("reuses one OIDC resolver for the same validated server configuration", () => {
    const createRemoteJWKSet = vi.fn(() => ({ resolver: "shared" }));
    const verifierCache = new Map();
    const dependencies = {
      createRemoteJWKSet,
      jwtVerify: vi.fn(),
      verifierCache,
    };

    const firstVerifier = createOidcTokenVerifier(oidcVerifierEnv, dependencies);
    const secondVerifier = createOidcTokenVerifier({ ...oidcVerifierEnv }, dependencies);

    expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
    expect(firstVerifier).toBe(secondVerifier);
  });

  it("isolates a shared OIDC verifier cache by validated configuration", () => {
    const createRemoteJWKSet = vi.fn((jwksUrl) => ({ jwksUrl: jwksUrl.href }));
    const verifierCache = new Map();
    const dependencies = {
      createRemoteJWKSet,
      jwtVerify: vi.fn(),
      verifierCache,
    };
    const secondOidcVerifierEnv = {
      ...oidcVerifierEnv,
      VIZION_OIDC_ISSUER: "https://issuer-two.example.test",
      VIZION_OIDC_AUDIENCE: "vizion-agent-two",
      VIZION_OIDC_JWKS_URI: "https://issuer-two.example.test/.well-known/jwks.json",
    };

    const firstVerifier = createOidcTokenVerifier(oidcVerifierEnv, dependencies);
    const secondVerifier = createOidcTokenVerifier(secondOidcVerifierEnv, dependencies);
    const reusedFirstVerifier = createOidcTokenVerifier({ ...oidcVerifierEnv }, dependencies);
    const reusedSecondVerifier = createOidcTokenVerifier({ ...secondOidcVerifierEnv }, dependencies);

    expect(createRemoteJWKSet).toHaveBeenCalledTimes(2);
    expect(createRemoteJWKSet.mock.calls.map(([jwksUrl]) => jwksUrl.href)).toEqual([
      oidcVerifierEnv.VIZION_OIDC_JWKS_URI,
      secondOidcVerifierEnv.VIZION_OIDC_JWKS_URI,
    ]);
    expect(firstVerifier).not.toBe(secondVerifier);
    expect(reusedFirstVerifier).toBe(firstVerifier);
    expect(reusedSecondVerifier).toBe(secondVerifier);
  });

  it("requires subject and expiry claims during OIDC verification", async () => {
    const jwks = { resolver: "claims-required" };
    const jwtVerify = vi.fn(async () => ({
      payload: { sub: "alice", exp: 1_800_000_000 },
    }));
    const verifier = createOidcTokenVerifier(oidcVerifierEnv, {
      createRemoteJWKSet: vi.fn(() => jwks),
      jwtVerify,
      verifierCache: new Map(),
    });

    await expect(verifier("verified-token")).resolves.toEqual({
      sub: "alice",
      exp: 1_800_000_000,
    });
    expect(jwtVerify).toHaveBeenCalledWith(
      "verified-token",
      jwks,
      {
        issuer: oidcVerifierEnv.VIZION_OIDC_ISSUER,
        audience: oidcVerifierEnv.VIZION_OIDC_AUDIENCE,
        requiredClaims: ["sub", "exp"],
      },
    );
  });

  it("rejects non-HTTPS JWKS configuration before creating a remote resolver", () => {
    const createRemoteJWKSet = vi.fn();
    let error;

    try {
      createOidcTokenVerifier(
        { ...oidcVerifierEnv, VIZION_OIDC_JWKS_URI: "http://issuer.example.test/jwks.json" },
        { createRemoteJWKSet, verifierCache: new Map() },
      );
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toMatchObject({ code: "AGENT_AUTH_CONFIGURATION_INVALID", statusCode: 503 });
    expect(toSafeAgentAuthResponse(error)).toEqual({
      statusCode: 503,
      payload: { success: false, error: "AGENT_AUTH_CONFIGURATION_INVALID" },
    });
    expect(createRemoteJWKSet).not.toHaveBeenCalled();
  });

  it.each([
    ["missing issuer", { VIZION_OIDC_ISSUER: "" }],
    ["malformed issuer", { VIZION_OIDC_ISSUER: "not-a-url" }],
    ["missing audience", { VIZION_OIDC_AUDIENCE: "" }],
    ["malformed JWKS URL", { VIZION_OIDC_JWKS_URI: "not-a-url" }],
  ])("reports %s as a safe OIDC server configuration error", (_description, overrides) => {
    const createRemoteJWKSet = vi.fn();
    let error;

    try {
      createOidcTokenVerifier(
        { ...oidcVerifierEnv, ...overrides },
        { createRemoteJWKSet, verifierCache: new Map() },
      );
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toMatchObject({ code: "AGENT_AUTH_CONFIGURATION_INVALID", statusCode: 503 });
    expect(toSafeAgentAuthResponse(error)).toEqual({
      statusCode: 503,
      payload: { success: false, error: "AGENT_AUTH_CONFIGURATION_INVALID" },
    });
    expect(createRemoteJWKSet).not.toHaveBeenCalled();
  });

  it("reports an invalid OIDC scope policy as safe server configuration", async () => {
    await expect(
      resolveRequestActor(
        { headers: { authorization: "Bearer verified-token" } },
        {
          env: { ...oidcEnv, VIZION_AGENT_OIDC_SCOPE_POLICY_JSON: "not-json" },
          verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"] }),
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_AUTH_CONFIGURATION_INVALID", statusCode: 503 });
  });

  it("reports an invalid OIDC scope policy structure as safe server configuration", async () => {
    await expect(
      resolveRequestActor(
        { headers: { authorization: "Bearer verified-token" } },
        {
          env: {
            ...oidcEnv,
            VIZION_AGENT_OIDC_SCOPE_POLICY_JSON: JSON.stringify({ groups: ["quality-readers"] }),
          },
          verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"] }),
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_AUTH_CONFIGURATION_INVALID", statusCode: 503 });
  });

  it.each([
    [
      "an unknown grant key",
      {
        groups: {
          "quality-readers": {
            projectId: ["project-a"],
            allowedObjectTypes: ["quality.defect"],
          },
        },
      },
    ],
    [
      "a scalar project restriction",
      {
        groups: {
          "quality-readers": {
            projectIds: "project-a",
            allowedObjectTypes: ["quality.defect"],
          },
        },
      },
    ],
    [
      "a missing allowed-object-type restriction",
      {
        groups: {
          "quality-readers": {
            projectIds: ["project-a"],
          },
        },
      },
    ],
    [
      "a scalar allowed-object-type restriction",
      {
        groups: {
          "quality-readers": {
            allowedObjectTypes: "quality.defect",
          },
        },
      },
    ],
    [
      "an empty allowed-object-type restriction",
      {
        groups: {
          "quality-readers": {
            allowedObjectTypes: [],
          },
        },
      },
    ],
    [
      "an unexpected matcher section",
      {
        groups: {
          "quality-readers": {
            allowedObjectTypes: ["quality.defect"],
          },
        },
        roles: {
          "quality-readers": {
            allowedObjectTypes: ["quality.defect"],
          },
        },
      },
    ],
  ])("rejects %s as safe OIDC server configuration", async (_description, policyConfig) => {
    let error;

    try {
      await resolveRequestActor(
        { headers: { authorization: "Bearer verified-token" } },
        {
          env: {
            ...oidcEnv,
            VIZION_AGENT_OIDC_SCOPE_POLICY_JSON: JSON.stringify(policyConfig),
          },
          verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"] }),
        },
      );
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toMatchObject({ code: "AGENT_AUTH_CONFIGURATION_INVALID", statusCode: 503 });
    expect(toSafeAgentAuthResponse(error)).toEqual({
      statusCode: 503,
      payload: { success: false, error: "AGENT_AUTH_CONFIGURATION_INVALID" },
    });
  });

  it("retains a valid policy grant after strict configuration validation", async () => {
    const actor = await resolveRequestActor(
      { headers: { authorization: "Bearer verified-token" } },
      {
        env: {
          ...oidcEnv,
          VIZION_AGENT_OIDC_SCOPE_POLICY_JSON: JSON.stringify({
            subjects: {
              alice: {
                projectIds: ["project-a"],
                allowedObjectTypes: ["quality.defect"],
              },
            },
          }),
        },
        verifyToken: async () => ({ sub: "alice" }),
      },
    );

    expect(actor.scopes).toEqual({
      projectIds: ["project-a"],
      allowedObjectTypes: ["quality.defect"],
    });
  });

  it("keeps an invalid JWT verification result as a credential failure", async () => {
    const invalidJwtError = Object.assign(new Error("signature verification failed"), {
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });

    await expect(
      resolveRequestActor(
        { headers: { authorization: "Bearer invalid-token" } },
        {
          env: oidcEnv,
          verifyToken: async () => { throw invalidJwtError; },
          scopePolicy: qualityReaderPolicy,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATED_ACTOR_REQUIRED", statusCode: 401 });
  });

  it("treats an unsupported critical JWT header as a credential failure", async () => {
    const unsupportedCriticalHeaderError = new errors.JOSENotSupported("unsupported critical header");
    let error;

    try {
      await resolveRequestActor(
        { headers: { authorization: "Bearer invalid-token" } },
        {
          env: oidcEnv,
          verifyToken: async () => { throw unsupportedCriticalHeaderError; },
          scopePolicy: qualityReaderPolicy,
        },
      );
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).not.toBe(unsupportedCriticalHeaderError);
    expect(error).toMatchObject({ code: "AUTHENTICATED_ACTOR_REQUIRED", statusCode: 401 });
    expect(toSafeAgentAuthResponse(error)).toEqual({
      statusCode: 401,
      payload: { success: false, error: "AUTHENTICATED_ACTOR_REQUIRED" },
    });
  });

  it("reports JWKS provider failures as a safe verifier-unavailable response", async () => {
    const providerError = Object.assign(new Error("JWKS request timed out"), { code: "ERR_JWKS_TIMEOUT" });
    let error;

    try {
      await resolveRequestActor(
        { headers: { authorization: "Bearer verified-token" } },
        {
          env: oidcEnv,
          verifyToken: async () => { throw providerError; },
          scopePolicy: qualityReaderPolicy,
        },
      );
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toMatchObject({ code: "AGENT_AUTH_VERIFIER_UNAVAILABLE", statusCode: 503 });
    expect(toSafeAgentAuthResponse(error)).toEqual({
      statusCode: 503,
      payload: { success: false, error: "AGENT_AUTH_VERIFIER_UNAVAILABLE" },
    });
  });

  it.each([
    ["a missing bearer token", { headers: {} }, {}, 401, "AUTHENTICATED_ACTOR_REQUIRED"],
    [
      "an invalid OIDC server configuration",
      { headers: { authorization: "Bearer verified-token" } },
      oidcEnv,
      503,
      "AGENT_AUTH_CONFIGURATION_INVALID",
    ],
  ])("stops before chat runtime work for %s", async (_description, request, env, statusCode, errorCode) => {
    const runChat = vi.fn();
    const readBody = vi.fn();
    const sendAuthResponse = vi.fn();
    const runAuthenticatedChatRequest = agentAuth.runAuthenticatedChatRequest;
    const result = typeof runAuthenticatedChatRequest === "function"
      ? await runAuthenticatedChatRequest(
        request,
        { env, readBody, runChat, sendAuthResponse },
      )
      : undefined;

    expect(runAuthenticatedChatRequest).toBeTypeOf("function");
    expect(result).toBeUndefined();
    expect(sendAuthResponse).toHaveBeenCalledWith({
      statusCode,
      payload: { success: false, error: errorCode },
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(runChat).not.toHaveBeenCalled();
  });

  it("authenticates headers before attempting to parse an unauthenticated malformed chat body", async () => {
    const readBody = vi.fn(async () => { throw new SyntaxError("Unexpected token"); });
    const runChat = vi.fn();
    const sendAuthResponse = vi.fn();

    const result = await agentAuth.runAuthenticatedChatRequest(
      { headers: {} },
      { env: oidcEnv, readBody, runChat, sendAuthResponse },
    );

    expect(result).toBeUndefined();
    expect(sendAuthResponse).toHaveBeenCalledWith({
      statusCode: 401,
      payload: { success: false, error: "AUTHENTICATED_ACTOR_REQUIRED" },
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(runChat).not.toHaveBeenCalled();
  });

  it("consumes a standard Headers bearer value when resolving the request actor", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "alice", groups: ["quality-readers"] });

    const actor = await resolveRequestActor(
      { headers: new Headers({ Authorization: "Bearer browser-session-token" }) },
      { env: oidcEnv, verifyToken, scopePolicy: qualityReaderPolicy },
    );

    expect(verifyToken).toHaveBeenCalledWith("browser-session-token");
    expect(actor).toMatchObject({
      actorId: "alice",
      scopes: { allowedObjectTypes: ["quality.defect"] },
    });
  });

  it("returns a safe bad request after authenticated chat-body parsing fails", async () => {
    const readBody = vi.fn(async () => { throw new SyntaxError("Unexpected token"); });
    const runChat = vi.fn();
    const sendBadRequestResponse = vi.fn();

    const result = await agentAuth.runAuthenticatedChatRequest(
      { headers: { authorization: "Bearer verified-token" } },
      {
        env: oidcEnv,
        verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"] }),
        scopePolicy: qualityReaderPolicy,
        readBody,
        runChat,
        sendBadRequestResponse,
      },
    );

    expect(result).toBeUndefined();
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(sendBadRequestResponse).toHaveBeenCalledWith({
      statusCode: 400,
      payload: { success: false, error: "INVALID_CHAT_REQUEST_BODY" },
    });
    expect(runChat).not.toHaveBeenCalled();
  });

  it("preserves a bounded body parser's 413 response after authentication", async () => {
    const bodyError = Object.assign(new Error("request body too large"), {
      code: "REQUEST_BODY_TOO_LARGE",
      statusCode: 413,
    });
    const readBody = vi.fn(async () => { throw bodyError; });
    const runChat = vi.fn();
    const sendBadRequestResponse = vi.fn();

    await agentAuth.runAuthenticatedChatRequest(
      { headers: { authorization: "Bearer verified-token" } },
      {
        env: oidcEnv,
        verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"] }),
        scopePolicy: qualityReaderPolicy,
        readBody,
        runChat,
        sendBadRequestResponse,
      },
    );

    expect(sendBadRequestResponse).toHaveBeenCalledWith({
      statusCode: 413,
      payload: { success: false, error: "REQUEST_BODY_TOO_LARGE" },
    });
    expect(runChat).not.toHaveBeenCalled();
  });

  it("runs another authenticated AI route with a server-derived actor and no client actor fields", async () => {
    const runRequest = vi.fn((body) => body);
    const clientBody = {
      audio: "encoded-audio",
      actor: { actorId: "browser-admin" },
      actorScope: { allowedObjectTypes: ["*"] },
      actorId: "browser-admin",
      userId: "browser-admin",
    };

    const result = await agentAuth.runAuthenticatedAgentRequest(
      { headers: { authorization: "Bearer verified-token" } },
      {
        env: oidcEnv,
        verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"] }),
        scopePolicy: qualityReaderPolicy,
        readBody: async () => clientBody,
        runRequest,
        invalidBodyError: "INVALID_TRANSCRIBE_REQUEST_BODY",
      },
    );

    expect(agentAuth.runAuthenticatedAgentRequest).toBeTypeOf("function");
    expect(runRequest).toHaveBeenCalledWith({
      audio: "encoded-audio",
      actor: expect.objectContaining({
        actorId: "alice",
        scopes: expect.objectContaining({ allowedObjectTypes: ["quality.defect"] }),
      }),
    });
    expect(result).toEqual(runRequest.mock.results[0].value);
  });

  it("defaults to fail-closed OIDC when no identity is supplied", async () => {
    const verifyToken = vi.fn();

    await expect(
      resolveRequestActor(
        { headers: {} },
        { env: {}, verifyToken, scopePolicy: qualityReaderPolicy },
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATED_ACTOR_REQUIRED", statusCode: 401 });

    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("rejects malformed bearer credentials before token verification", async () => {
    const verifyToken = vi.fn();

    await expect(
      resolveRequestActor(
        { headers: { authorization: "Token not-a-bearer-token" } },
        { env: oidcEnv, verifyToken, scopePolicy: qualityReaderPolicy },
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATED_ACTOR_REQUIRED", statusCode: 401 });

    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("maps verified claims through the server policy and discards browser actor fields", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      sub: "alice",
      groups: ["quality-readers"],
      scope: "admin everything",
      allowedObjectTypes: ["*"],
    });

    const body = await resolveAuthenticatedChatBody(
      {
        messages: [{ role: "user", content: "show defects" }],
        actor: { actorId: "browser-admin", scopeHash: "browser-scope", scopes: { allowedObjectTypes: ["*"] } },
        actorScope: { allowedObjectTypes: ["*"] },
        actorId: "browser-admin",
        scopeHash: "browser-scope",
        scopes: { allowedObjectTypes: ["*"] },
        userId: "browser-admin",
      },
      { headers: { authorization: "Bearer verified-token" } },
      { env: oidcEnv, verifyToken, scopePolicy: qualityReaderPolicy },
    );

    expect(verifyToken).toHaveBeenCalledWith("verified-token");
    expect(body).toEqual({
      messages: [{ role: "user", content: "show defects" }],
      actor: {
        actorId: "alice",
        scopeHash: expect.stringMatching(/^oidc-[a-f0-9]{16}$/),
        scopes: {
          workspaceIds: ["workspace-a"],
          projectIds: ["project-a"],
          teamIds: ["quality-team"],
          allowedObjectTypes: ["quality.defect"],
          allowedPropertyIds: ["defect.status"],
          rowPolicyIds: ["quality-readonly"],
          sensitiveFieldPolicyIds: ["mask-reporter"],
        },
      },
    });
  });

  it("derives the OIDC scope hash from the mapped policy rather than token scopes", async () => {
    const actorWithNarrowClaim = await resolveRequestActor(
      { headers: { authorization: "Bearer token-a" } },
      {
        env: oidcEnv,
        verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"], scope: "read" }),
        scopePolicy: qualityReaderPolicy,
      },
    );
    const actorWithBroadClaim = await resolveRequestActor(
      { headers: { authorization: "Bearer token-b" } },
      {
        env: oidcEnv,
        verifyToken: async () => ({ sub: "alice", groups: ["quality-readers"], scope: "admin everything" }),
        scopePolicy: qualityReaderPolicy,
      },
    );

    expect(actorWithBroadClaim.scopes).toEqual(actorWithNarrowClaim.scopes);
    expect(actorWithBroadClaim.scopeHash).toBe(actorWithNarrowClaim.scopeHash);
  });

  it("rejects distinct matching group grants instead of returning a combined actor", () => {
    const scopePolicy = createOidcScopePolicy({
      groups: {
        "defect-readers": {
          projectIds: ["project-defect"],
          teamIds: ["quality-team"],
          allowedObjectTypes: ["quality.defect"],
          allowedPropertyIds: ["defect.status"],
          sensitiveFieldPolicyIds: ["mask-reporter"],
        },
        "test-readers": {
          projectIds: ["project-test"],
          teamIds: ["testing-team"],
          allowedObjectTypes: ["testing.test_run"],
          allowedPropertyIds: ["test_run.status"],
          sensitiveFieldPolicyIds: ["mask-executor"],
        },
      },
    });
    let actor;
    let error;

    try {
      actor = scopePolicy.actorFromClaims({
        sub: "alice",
        groups: ["defect-readers", "test-readers"],
      });
    } catch (caughtError) {
      error = caughtError;
    }

    expect(actor).toBeUndefined();
    expect(error).toMatchObject({ code: "AUTHENTICATED_ACTOR_REQUIRED", statusCode: 403 });
  });

  it("accepts duplicate equivalent group grants with a stable canonical actor", () => {
    const scopePolicy = createOidcScopePolicy({
      groups: {
        "quality-readers-a": {
          projectIds: ["project-a"],
          teamIds: ["quality-team"],
          allowedObjectTypes: ["quality.defect"],
          allowedPropertyIds: ["defect.priority", "defect.status"],
          sensitiveFieldPolicyIds: ["mask-reporter"],
        },
        "quality-readers-b": {
          projectIds: ["project-a", "project-a"],
          teamIds: ["quality-team"],
          allowedObjectTypes: ["quality.defect"],
          allowedPropertyIds: ["defect.status", "defect.priority"],
          sensitiveFieldPolicyIds: ["mask-reporter"],
        },
      },
    });

    const actor = scopePolicy.actorFromClaims({
      sub: "alice",
      groups: ["quality-readers-a", "quality-readers-b"],
    });
    const reorderedActor = scopePolicy.actorFromClaims({
      sub: "alice",
      groups: ["quality-readers-b", "quality-readers-a"],
    });

    expect(actor).toMatchObject({
      actorId: "alice",
      scopes: {
        projectIds: ["project-a"],
        teamIds: ["quality-team"],
        allowedObjectTypes: ["quality.defect"],
        allowedPropertyIds: ["defect.priority", "defect.status"],
        sensitiveFieldPolicyIds: ["mask-reporter"],
      },
    });
    expect(reorderedActor).toEqual(actor);
  });

  it("loads fixed OIDC scope policy from server environment configuration", async () => {
    const actor = await resolveRequestActor(
      { headers: { authorization: "Bearer verified-token" } },
      {
        env: {
          ...oidcEnv,
          VIZION_AGENT_OIDC_SCOPE_POLICY_JSON: JSON.stringify({
            subjects: {
              alice: {
                workspaceIds: ["workspace-a"],
                allowedObjectTypes: ["quality.defect"],
              },
            },
          }),
        },
        verifyToken: async () => ({ sub: "alice", scope: "admin everything" }),
      },
    );

    expect(actor).toMatchObject({
      actorId: "alice",
      scopes: {
        workspaceIds: ["workspace-a"],
        allowedObjectTypes: ["quality.defect"],
      },
    });
  });

  it("returns the existing internal actor only when internal mode is explicit", async () => {
    const env = {
      VIZION_AGENT_AUTH_MODE: "internal",
      VIZION_INTERNAL_ACTOR_ID: "local-cli",
      VIZION_INTERNAL_ALLOWED_OBJECT_TYPES: "quality.defect",
    };

    await expect(resolveRequestActor({ headers: {} }, { env })).resolves.toEqual(resolveInternalActorScope(env));
  });

  it("maps an unsupported configured authentication mode to a safe unavailable response", async () => {
    const runChat = vi.fn();
    const readBody = vi.fn();
    const sendAuthResponse = vi.fn();

    const result = await agentAuth.runAuthenticatedChatRequest(
      { headers: {} },
      {
        env: { VIZION_AGENT_AUTH_MODE: "permissive" },
        readBody,
        runChat,
        sendAuthResponse,
      },
    );

    expect(result).toBeUndefined();
    expect(sendAuthResponse).toHaveBeenCalledWith({
      statusCode: 503,
      payload: { success: false, error: "AGENT_AUTH_MODE_INVALID" },
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(runChat).not.toHaveBeenCalled();
  });

  it("formats authentication failures without exposing verifier details", async () => {
    let error;
    try {
      await resolveRequestActor({ headers: {} }, { env: {}, scopePolicy: qualityReaderPolicy });
    } catch (caughtError) {
      error = caughtError;
    }

    expect(toSafeAgentAuthResponse(error)).toEqual({
      statusCode: 401,
      payload: { success: false, error: "AUTHENTICATED_ACTOR_REQUIRED" },
    });
    expect(toSafeAgentAuthResponse(new Error("token verification failed"))).toBeNull();
  });

  it("denies verified identities without an authorized object-type policy", async () => {
    await expect(
      resolveRequestActor(
        { headers: { authorization: "Bearer verified-token" } },
        {
          env: oidcEnv,
          verifyToken: async () => ({ sub: "alice", groups: ["unassigned"] }),
          scopePolicy: qualityReaderPolicy,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATED_ACTOR_REQUIRED", statusCode: 403 });
  });
});
