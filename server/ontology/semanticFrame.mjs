import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const nonEmptyString = { type: "string", minLength: 1 };
const stringArray = { type: "array", items: nonEmptyString };

export const semanticFrameSchema = Object.freeze({
  $id: "https://vizion-lab.local/ontology/semantic-frame.schema.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: [
    "schemaVersion",
    "ontologyVersion",
    "schemaFingerprint",
    "requestAnchorAt",
    "sourceQueryFingerprint",
    "intent",
    "entityIds",
    "metricIds",
    "dimensionIds",
    "filters",
    "timeScopes",
    "comparison",
    "sort",
    "limit",
    "ambiguities",
    "assumptions",
    "confidence",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "1.0" },
    ontologyVersion: nonEmptyString,
    schemaFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    requestAnchorAt: { type: "string", format: "date-time" },
    sourceQueryFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    intent: { enum: ["aggregate", "trend", "compare", "rank", "list", "drilldown", "trace", "similarity"] },
    entityIds: stringArray,
    metricIds: stringArray,
    dimensionIds: stringArray,
    filters: {
      type: "array",
      items: {
        type: "object",
        required: ["dimensionId", "operator", "values", "source"],
        additionalProperties: false,
        properties: {
          dimensionId: nonEmptyString,
          operator: { enum: ["in", "not_in", "eq", "neq", "contains"] },
          values: {
            type: "array",
            minItems: 1,
            items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
          },
          source: { enum: ["user", "context", "policy"] },
        },
      },
    },
    timeScopes: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "fieldId", "start", "end", "timezone", "anchorAt"],
        additionalProperties: false,
        properties: {
          role: { enum: ["primary", "baseline", "comparison"] },
          fieldId: nonEmptyString,
          start: { type: "string", format: "date" },
          end: { type: "string", format: "date" },
          timezone: { const: "Asia/Shanghai" },
          relativeText: { type: "string" },
          anchorAt: { type: "string", format: "date-time" },
        },
      },
    },
    comparison: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          required: ["kind", "dimensionId", "groups"],
          additionalProperties: false,
          properties: {
            kind: { enum: ["dimension_values", "time_periods"] },
            dimensionId: nonEmptyString,
            groups: { type: "array", minItems: 2, items: nonEmptyString },
          },
        },
      ],
    },
    sort: {
      type: "array",
      items: {
        type: "object",
        required: ["fieldId", "direction"],
        additionalProperties: false,
        properties: {
          fieldId: nonEmptyString,
          direction: { enum: ["asc", "desc"] },
        },
      },
    },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    ambiguities: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "kind", "message", "options"],
        additionalProperties: false,
        properties: {
          code: nonEmptyString,
          kind: { enum: ["metric_definition", "dimension", "time", "scope", "intent"] },
          message: nonEmptyString,
          metricId: nonEmptyString,
          dimensionId: nonEmptyString,
          options: stringArray,
        },
      },
    },
    assumptions: stringArray,
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(semanticFrameSchema);

export function validateSemanticFrame(frame) {
  if (!validate(frame)) {
    throw new Error(`SEMANTIC_FRAME_INVALID:${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
  return frame;
}

export function buildFocusedClarification(frame) {
  const ambiguity = frame.ambiguities[0];
  if (!ambiguity) return null;
  return Object.freeze({
    reasonCode: ambiguity.code,
    question: ambiguity.message,
    options: ambiguity.options,
    responseSchema: {
      type: "object",
      additionalProperties: false,
      required: ["selection"],
      properties: {
        selection: { type: "string", enum: ambiguity.options },
        text: { type: "string", minLength: 1, maxLength: 1000 },
      },
      allOf: [{
        if: { properties: { selection: { const: "补充其他明确口径" } }, required: ["selection"] },
        then: { properties: { text: { type: "string", minLength: 1, maxLength: 1000 } }, required: ["text"] },
      }],
    },
  });
}
