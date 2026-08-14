import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class TestCaseProposalCapabilityError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function requiredText(value, code) {
  const text = String(value || "").trim();
  if (!text) throw new TestCaseProposalCapabilityError(code);
  return text;
}

function getProposalSecret(env = process.env) {
  const secret = String(env?.VIZION_TESTCASE_PROPOSAL_SECRET || env?.VIZION_AGENT_ACTOR_CAPABILITY_SECRET || "").trim();
  if (Buffer.byteLength(secret, "utf8") < 16) {
    throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_SECRET_INVALID", 503);
  }
  return secret;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function mutationDigest({ featureId, ownerId }) {
  return createHash("sha256").update(canonicalJson({ featureId, ownerId })).digest("hex");
}

function sign(payloadPart, secret) {
  return createHmac("sha256", secret).update(`v1.${payloadPart}`).digest();
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(payloadPart) {
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function verifyToken(token, secret, nowMs) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_CAPABILITY_INVALID", 401);
  }
  const payload = decodePayload(parts[1]);
  let received;
  try {
    received = Buffer.from(parts[2], "base64url");
  } catch {
    received = Buffer.alloc(0);
  }
  const expected = sign(parts[1], secret);
  if (!payload || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_CAPABILITY_INVALID", 401);
  }
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= nowMs) {
    throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_CAPABILITY_EXPIRED", 409);
  }
  return payload;
}

export function createTestCaseProposalRegistry({
  env = process.env,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  randomBytesImpl = randomBytes,
} = {}) {
  const entries = new Map();

  function purgeExpired(nowMs) {
    for (const [capability, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(capability);
    }
  }

  function issue({ actor, proposal }) {
    const nowMs = Number(now());
    purgeExpired(nowMs);
    const actorScopeHash = requiredText(actor?.scopeHash, "TESTCASE_PROPOSAL_ACTOR_REQUIRED");
    const proposalDigest = requiredText(proposal?.proposalDigest, "TESTCASE_PROPOSAL_DIGEST_REQUIRED");
    const lifetime = Math.max(1_000, Math.min(10 * 60 * 1000, Number(ttlMs) || DEFAULT_TTL_MS));
    const payload = {
      proposalDigest,
      actorScopeHash,
      issuedAt: nowMs,
      expiresAt: nowMs + lifetime,
      nonce: randomBytesImpl(18).toString("base64url"),
    };
    const payloadPart = encodePayload(payload);
    const capability = `v1.${payloadPart}.${sign(payloadPart, getProposalSecret(env)).toString("base64url")}`;
    entries.set(capability, {
      actorScopeHash,
      proposal: structuredClone(proposal),
      expiresAt: payload.expiresAt,
      state: "available",
      mutationDigest: "",
      result: null,
    });
    return { capability, expiresAt: payload.expiresAt };
  }

  async function commit({ capability, actor, featureId = "", ownerId = "", commitProposal }) {
    const nowMs = Number(now());
    const token = requiredText(capability, "TESTCASE_PROPOSAL_CAPABILITY_REQUIRED");
    const payload = verifyToken(token, getProposalSecret(env), nowMs);
    const actorScopeHash = requiredText(actor?.scopeHash, "TESTCASE_PROPOSAL_ACTOR_REQUIRED");
    if (payload.actorScopeHash !== actorScopeHash) {
      throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_ACTOR_MISMATCH", 403);
    }
    const entry = entries.get(token);
    if (!entry || entry.expiresAt <= nowMs || entry.proposal?.proposalDigest !== payload.proposalDigest) {
      entries.delete(token);
      throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_CAPABILITY_EXPIRED", 409);
    }
    const normalized = {
      featureId: String(featureId || "").trim(),
      ownerId: String(ownerId || "").trim(),
    };
    const requestedMutationDigest = mutationDigest(normalized);
    if (entry.state === "committed") {
      if (entry.mutationDigest !== requestedMutationDigest) {
        throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_CAPABILITY_ALREADY_USED", 409);
      }
      return { ...structuredClone(entry.result), idempotentReplay: true };
    }
    if (entry.state === "committing") {
      throw new TestCaseProposalCapabilityError("TESTCASE_PROPOSAL_COMMIT_IN_PROGRESS", 409);
    }
    if (typeof commitProposal !== "function") {
      throw new TestCaseProposalCapabilityError("TESTCASE_COMMIT_BRIDGE_UNAVAILABLE", 503);
    }
    entry.state = "committing";
    entry.mutationDigest = requestedMutationDigest;
    try {
      const result = await commitProposal({ proposal: structuredClone(entry.proposal), ...normalized });
      entry.state = "committed";
      entry.result = structuredClone(result);
      return { ...structuredClone(result), idempotentReplay: false };
    } catch (error) {
      entry.state = "available";
      entry.mutationDigest = "";
      throw error;
    }
  }

  return { issue, commit };
}

export function toSafeTestCaseProposalError(error) {
  if (!(error instanceof TestCaseProposalCapabilityError)) return null;
  return { statusCode: error.statusCode, payload: { success: false, error: error.code } };
}
