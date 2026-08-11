import { canonicalize } from "./fingerprint.mjs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const string = { type: "string", minLength: 1 };
const stringArray = { type: "array", items: string, uniqueItems: true };

export const semanticQuerySchema = Object.freeze({
  type: "object",
  required: ["schemaVersion", "ontologyVersion", "schemaFingerprint", "intent", "entityIds", "metricIds", "dimensionIds", "filters", "timeScopes", "comparison", "sort", "limit"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "1.0" },
    ontologyVersion: string,
    schemaFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    intent: { enum: ["aggregate", "trend", "compare", "rank", "list", "drilldown", "trace"] },
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
          dimensionId: string,
          operator: { enum: ["in", "not_in", "eq", "neq", "contains"] },
          values: { type: "array", minItems: 1, items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
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
          fieldId: string,
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
            dimensionId: string,
            groups: { type: "array", minItems: 2, items: string },
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
        properties: { fieldId: string, direction: { enum: ["asc", "desc"] } },
      },
    },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    inferredJoinPaths: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      ],
    },
  },
});

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(semanticQuerySchema);

export function validateSemanticQuery(query) {
  if (!validate(query)) throw new Error(`SEMANTIC_QUERY_INVALID:${ajv.errorsText(validate.errors)}`);
  return query;
}

export function compileSemanticQuery(frame) {
  if (frame.ambiguities.length) throw new Error(`SEMANTIC_QUERY_REQUIRES_CLARIFICATION:${frame.ambiguities[0].code}`);
  return validateSemanticQuery(canonicalize({
    schemaVersion: "1.0",
    ontologyVersion: frame.ontologyVersion,
    schemaFingerprint: frame.schemaFingerprint,
    intent: frame.intent,
    entityIds: frame.entityIds,
    metricIds: frame.metricIds,
    dimensionIds: frame.dimensionIds,
    filters: frame.filters,
    timeScopes: frame.timeScopes,
    comparison: frame.comparison,
    sort: frame.sort,
    limit: frame.limit,
    ...(frame.inferredJoinPaths ? { inferredJoinPaths: frame.inferredJoinPaths } : {}),
  }));
}
