// Tolerant JSON extraction from chat-model replies: strips code fences, slices the
// outermost braces, and parses. Returns the parsed object or null (never throws).

const CODE_FENCE_RE = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/;

export function stripCodeFences(content) {
  const text = String(content || "").trim();
  const fenced = text.match(CODE_FENCE_RE);
  return (fenced ? fenced[1] : text).trim();
}

export function extractJsonObject(content) {
  const text = stripCodeFences(content);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseModelJson(content) {
  return extractJsonObject(content);
}
