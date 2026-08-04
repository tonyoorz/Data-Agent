import { createHash } from "node:crypto";

export function normalizeSourceQuery(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function composeSourceQuery(query, clarificationText = "") {
  return normalizeSourceQuery([query, clarificationText].filter((value) => String(value ?? "").trim()).join(" "));
}

export function fingerprintSourceQuery(value) {
  return createHash("sha256").update(normalizeSourceQuery(value)).digest("hex");
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function fingerprintOntology(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
