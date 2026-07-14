import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const EVENT_PROTOCOL_VERSION = "1.0";
export const GRAPH_DEFINITION_VERSION = "main-agent-v1";
export const EVENT_TYPES = Object.freeze([
  "run.started",
  "input.prepared",
  "intent.resolved",
  "ontology.resolved",
  "clarification.required",
  "plan.updated",
  "plan.validated",
  "model.fallback",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "evidence.added",
  "claims.validated",
  "approval.required",
  "interaction.expired",
  "run.resumed",
  "answer.delta",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

const MiB = 1024 * 1024;
const LEGACY_TEXT_LIMIT = MiB;
const LEGACY_DATA_URL_LIMIT = 8 * MiB;
const LEGACY_DATA_URL_TOTAL_LIMIT = 20 * MiB;
const DATA_URL_RE = /^data:([^,]*),(.*)$/is;

const string = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0 };
const dateTime = { type: "string", format: "date-time" };
const stringArray = { type: "array", items: string };
const anyValue = {};
const record = { type: "object", additionalProperties: true };

const objectSchema = (properties, required = Object.keys(properties), extra = {}) => {
  const schema = { type: "object", properties, additionalProperties: false, ...extra };
  if (required.length > 0) schema.required = required;
  return schema;
};

const sourceRevisionSchema = objectSchema({
  sourceId: string,
  revisionId: string,
  status: { enum: ["pinned", "unpinned", "unknown"] },
  asOf: dateTime,
  ingestionWatermark: string,
}, ["sourceId", "status"]);

const timeScopeSchema = objectSchema({
  role: { enum: ["primary", "baseline", "comparison"] },
  fieldId: string,
  start: string,
  end: string,
  timezone: { const: "Asia/Shanghai" },
  relativeText: string,
  anchorAt: string,
}, ["role", "fieldId", "start", "end", "timezone"]);

const payloadSchemas = {
  "run.started": objectSchema({
    threadVersion: integer,
    runtimeMode: { enum: ["legacy", "shadow", "langgraph"] },
    requestedModelId: string,
    actualModelId: string,
  }),
  "input.prepared": objectSchema({ artifactRefs: stringArray, warnings: stringArray }),
  "intent.resolved": objectSchema({
    intent: string,
    confidence: { type: "number", minimum: 0, maximum: 1 },
  }, ["intent"]),
  "ontology.resolved": objectSchema({
    semanticFrameRef: objectSchema({
      ontologyVersion: string,
      schemaFingerprint: string,
      requestAnchorAt: string,
    }),
    mode: { enum: ["legacy_provisional", "ontology_verified"] },
    ambiguityCodes: stringArray,
  }),
  "clarification.required": objectSchema({
    interactionId: string,
    threadVersion: integer,
    question: string,
    responseSchemaRef: string,
    expiresAt: dateTime,
  }),
  "plan.updated": objectSchema({ planId: string, version: integer, stepIds: stringArray }),
  "plan.validated": objectSchema({ planId: string, toolNames: stringArray, warnings: stringArray }),
  "model.fallback": objectSchema({ fromModelId: string, toModelId: string, reasonCode: string }),
  "tool.started": objectSchema({
    attemptId: string,
    stepId: string,
    toolName: string,
    redactedCanonicalArgs: record,
  }),
  "tool.progress": objectSchema({
    attemptId: string,
    message: string,
    percent: { type: "number", minimum: 0, maximum: 100 },
  }, ["attemptId", "message"]),
  "tool.completed": objectSchema({
    attemptId: string,
    status: { enum: ["succeeded", "partial"] },
    evidenceIds: stringArray,
    durationMs: integer,
  }),
  "tool.failed": objectSchema({
    attemptId: string,
    status: { enum: ["denied", "failed", "timeout", "cancelled"] },
    code: string,
    retryable: { type: "boolean" },
    safeMessage: string,
  }),
  "evidence.added": objectSchema({
    evidenceIds: stringArray,
    groundingStatus: { enum: ["grounded", "legacy_equivalence", "insufficient_evidence"] },
  }),
  "claims.validated": objectSchema({
    validationRef: string,
    acceptedClaimIds: stringArray,
    rejectedClaimIds: stringArray,
  }),
  "approval.required": objectSchema({
    interactionId: string,
    approvalId: string,
    threadVersion: integer,
    riskLevel: { enum: ["R2", "R3"] },
    actionDigest: string,
    actionPreviewRef: string,
    expiresAt: dateTime,
  }),
  "interaction.expired": objectSchema({
    interactionId: string,
    kind: { enum: ["clarification", "approval"] },
    threadVersion: integer,
  }),
  "run.resumed": objectSchema({ interactionId: string, threadVersion: integer }),
  "answer.delta": objectSchema({ answerId: string, contentHash: string, offset: integer, text: { type: "string" } }),
  "run.completed": objectSchema({ answerId: string, threadVersion: integer, durationMs: integer }),
  "run.failed": objectSchema({ code: string, safeMessage: string, retryable: { type: "boolean" }, threadVersion: integer }),
  "run.cancelled": objectSchema({ reasonCode: string, threadVersion: integer }),
};

const runRequestSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  messageId: string,
  threadId: string,
  threadVersion: integer,
  branch: objectSchema({ parentRunId: string, parentCheckpointId: string }),
  message: objectSchema({
    role: { const: "user" },
    text: string,
    artifactRefs: { type: "array", maxItems: 5, items: string },
  }),
  selectedModel: string,
  pageContext: objectSchema({ moduleKey: string, moduleLabel: string }),
  useDefectContext: { type: "boolean" },
  useAnalyticsContext: { type: "boolean" },
  eventProtocolVersion: { const: "1.0" },
}, ["schemaVersion", "messageId", "threadVersion", "message", "selectedModel", "useDefectContext", "useAnalyticsContext", "eventProtocolVersion"], {
  if: { properties: { threadId: string }, required: ["threadId"] },
  else: { properties: { threadVersion: { const: 0 } } },
});

const resumeRequestSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  interactionId: string,
  threadVersion: integer,
  value: anyValue,
});

const cancelRequestSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  threadVersion: integer,
  reasonCode: string,
});

const legacyMessageSchema = objectSchema({
  clientMessageId: string,
  role: { enum: ["user", "assistant"] },
  text: { type: "string", maxLength: LEGACY_TEXT_LIMIT },
  artifactRefs: { type: "array", maxItems: 5, items: string },
  createdAt: dateTime,
  metadata: record,
}, ["clientMessageId", "role", "text", "artifactRefs", "createdAt"]);

const legacyImportSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  clientConversationId: string,
  messages: { type: "array", items: legacyMessageSchema },
});

const forkRequestSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  threadVersion: integer,
  parentRunId: string,
  parentCheckpointId: string,
  supersedesMessageId: string,
}, ["schemaVersion", "threadVersion", "parentRunId", "parentCheckpointId"]);

const threadPatchSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  threadVersion: integer,
  title: string,
  pinned: { type: "boolean" },
  archived: { type: "boolean" },
  deleted: { type: "boolean" },
}, ["schemaVersion", "threadVersion"], {
  anyOf: [
    { properties: { title: string }, required: ["title"] },
    { properties: { pinned: { type: "boolean" } }, required: ["pinned"] },
    { properties: { archived: { type: "boolean" } }, required: ["archived"] },
    { properties: { deleted: { type: "boolean" } }, required: ["deleted"] },
  ],
});

const modelResponseSchema = objectSchema({
  text: { type: "string" },
  toolCalls: {
    type: "array",
    items: objectSchema({ toolCallId: string, name: string, argumentsText: { type: "string" } }),
  },
  finishReason: { enum: ["stop", "tool_calls", "length", "content_filter", "cancelled", "error"] },
  usage: objectSchema({ inputTokens: integer, outputTokens: integer }),
  providerRequestId: string,
}, ["text", "toolCalls", "finishReason"]);

const evidenceSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  evidenceId: string,
  ontologyVersion: string,
  schemaFingerprint: string,
  evidenceType: { enum: ["metric", "records", "relationship", "similarity", "document", "user_input", "artifact"] },
  source: objectSchema({
    system: { enum: ["octane", "analytics", "duplicate-search", "ontology", "user-input", "attachment"] },
    endpoint: string,
    toolName: string,
    toolVersion: string,
    attemptId: string,
    queryFingerprint: string,
    canonicalArgsHash: string,
    canonicalArgsRef: string,
  }, ["system", "queryFingerprint"]),
  sourceRevision: sourceRevisionSchema,
  scope: objectSchema({
    objectType: string,
    filters: record,
    timeScopes: { type: "array", items: timeScopeSchema },
    grain: string,
  }, ["objectType", "timeScopes"]),
  metric: objectSchema({
    metricId: string,
    definitionVersion: string,
    unit: string,
    numerator: { type: "number" },
    denominator: { type: "number" },
    missingDataPolicy: string,
  }, ["metricId", "definitionVersion", "unit", "missingDataPolicy"]),
  dataRef: string,
  contentHash: string,
  preview: anyValue,
  quality: objectSchema({
    groundingStatus: { enum: ["grounded", "legacy_equivalence", "insufficient_evidence"] },
    completeness: { enum: ["complete", "partial", "unknown"] },
    truncation: objectSchema({
      truncated: { type: "boolean" },
      returnedCount: integer,
      totalCount: integer,
    }, ["truncated"]),
    missingness: { enum: ["zero", "missing", "unknown", "not_applicable"] },
    warnings: stringArray,
  }),
  authorization: objectSchema({
    actorScopeHash: string,
    redactionStatus: { enum: ["not_required", "applied", "denied"] },
  }),
  retrievedAt: dateTime,
}, ["schemaVersion", "evidenceId", "ontologyVersion", "schemaFingerprint", "evidenceType", "source", "sourceRevision", "scope", "preview", "quality", "authorization", "retrievedAt"]);

const claimValidationSchema = objectSchema({
  validationId: string,
  status: { enum: ["valid", "repair", "rejected"] },
  acceptedClaimIds: stringArray,
  rejected: {
    type: "array",
    items: objectSchema({ claimId: string, reason: string }),
  },
  warnings: stringArray,
});

const answerEnvelopeSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  answerId: string,
  text: { type: "string" },
  contentHash: string,
  acceptedClaimIds: stringArray,
  citations: {
    type: "array",
    items: objectSchema({ citationId: string, label: string, claimIds: stringArray, evidenceIds: stringArray }),
  },
  assumptions: stringArray,
  limitations: stringArray,
  groundingStatus: { enum: ["grounded", "legacy_equivalence", "insufficient_evidence"] },
  sourceRevisionSet: { type: "object", additionalProperties: sourceRevisionSchema },
});

function eventEnvelopeSchema(type) {
  return objectSchema({
    schemaVersion: { const: "1.0" },
    eventId: string,
    runId: string,
    threadId: string,
    stateVersion: integer,
    sequence: { type: "integer", minimum: 1 },
    timestamp: dateTime,
    type: { const: type },
    payload: payloadSchemas[type],
  });
}

function formatAjvErrors(ajv, errors) {
  const text = ajv.errorsText(errors, { separator: "; " });
  const details = (errors || [])
    .map((error) => error.params?.additionalProperty || error.params?.missingProperty || "")
    .filter(Boolean);
  return details.length > 0 ? `${text}; ${details.join("; ")}` : text;
}

function compileOrThrow(ajv, schema, label) {
  const validate = ajv.compile(schema);
  return (value) => {
    if (!validate(value)) {
      throw new Error(`${label}: ${formatAjvErrors(ajv, validate.errors)}`);
    }
    return value;
  };
}

function decodedDataUrlSize(ref) {
  const match = DATA_URL_RE.exec(String(ref));
  if (!match) return null;
  const metadata = match[1].toLowerCase();
  const data = match[2];
  if (metadata.split(";").includes("base64")) {
    const normalized = data.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
      throw new Error("LEGACY_IMPORT_DATA_URL_INVALID_BASE64");
    }
    return Buffer.from(normalized, "base64").length;
  }
  try {
    return Buffer.byteLength(decodeURIComponent(data), "utf8");
  } catch {
    throw new Error("LEGACY_IMPORT_DATA_URL_INVALID_ENCODING");
  }
}

function validateLegacyImportBounds(value) {
  let dataUrlCount = 0;
  let dataUrlTotalBytes = 0;
  for (const message of value.messages) {
    if (Buffer.byteLength(message.text, "utf8") > LEGACY_TEXT_LIMIT) {
      throw new Error("LEGACY_IMPORT_TEXT_TOO_LARGE");
    }
    if (message.metadata && Buffer.byteLength(JSON.stringify(message.metadata), "utf8") > LEGACY_TEXT_LIMIT) {
      throw new Error("LEGACY_IMPORT_METADATA_TOO_LARGE");
    }
    for (const ref of message.artifactRefs) {
      const decodedBytes = decodedDataUrlSize(ref);
      if (decodedBytes === null) continue;
      dataUrlCount += 1;
      dataUrlTotalBytes += decodedBytes;
      if (dataUrlCount > 5) throw new Error("LEGACY_IMPORT_TOO_MANY_DATA_URLS");
      if (decodedBytes > LEGACY_DATA_URL_LIMIT) throw new Error("LEGACY_IMPORT_DATA_URL_TOO_LARGE");
      if (dataUrlTotalBytes > LEGACY_DATA_URL_TOTAL_LIMIT) throw new Error("LEGACY_IMPORT_DATA_URL_TOTAL_TOO_LARGE");
    }
  }
}

export function createContractRegistry() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, removeAdditional: false });
  addFormats(ajv);

  const validateRunRequest = compileOrThrow(ajv, runRequestSchema, "INVALID_RUN_REQUEST");
  const validateResumeRequest = compileOrThrow(ajv, resumeRequestSchema, "INVALID_RESUME_REQUEST");
  const validateCancelRequest = compileOrThrow(ajv, cancelRequestSchema, "INVALID_CANCEL_REQUEST");
  const validateForkRequest = compileOrThrow(ajv, forkRequestSchema, "INVALID_FORK_REQUEST");
  const validateThreadPatch = compileOrThrow(ajv, threadPatchSchema, "INVALID_THREAD_PATCH");
  const validateModelResponse = compileOrThrow(ajv, modelResponseSchema, "INVALID_MODEL_RESPONSE");
  const validateEvidence = compileOrThrow(ajv, evidenceSchema, "INVALID_EVIDENCE");
  const validateClaimValidation = compileOrThrow(ajv, claimValidationSchema, "INVALID_CLAIM_VALIDATION");
  const validateAnswerEnvelope = compileOrThrow(ajv, answerEnvelopeSchema, "INVALID_ANSWER_ENVELOPE");
  const validateLegacyImportSchema = compileOrThrow(ajv, legacyImportSchema, "INVALID_LEGACY_IMPORT");
  for (const type of EVENT_TYPES) {
    if (!payloadSchemas[type]) throw new Error(`INVALID_AGENT_EVENT_SCHEMA:${type}`);
  }
  const eventValidators = Object.fromEntries(
    EVENT_TYPES.map((type) => [type, compileOrThrow(ajv, eventEnvelopeSchema(type), `INVALID_AGENT_EVENT:${type}`)]),
  );

  return Object.freeze({
    validateRunRequest,
    validateResumeRequest,
    validateCancelRequest,
    validateForkRequest,
    validateThreadPatch,
    validateModelResponse,
    validateEvidence,
    validateClaimValidation,
    validateAnswerEnvelope,
    validateLegacyImport(value) {
      const validated = validateLegacyImportSchema(value);
      validateLegacyImportBounds(validated);
      return validated;
    },
    validateAgentEvent(value) {
      const type = String(value?.type || "");
      const validate = eventValidators[type];
      if (!validate) throw new Error(`INVALID_AGENT_EVENT:type:${type || "missing"}`);
      return validate(value);
    },
    compileToolSchema(schema, label = "TOOL_SCHEMA") {
      try {
        return ajv.compile(schema);
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}