const DIRECTIVE_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|system)\s+instructions?/i,
  /忽略(?:之前|以上|系统).{0,12}(?:指令|规则|权限)/i,
  /(?:call|invoke|execute|运行|调用).{0,20}(?:shell|bash|sql|tool|工具|命令)/i,
  /(?:disable|bypass|override|绕过|关闭|修改).{0,20}(?:policy|permission|scope|ontology|权限|策略|范围)/i,
];

const SENSITIVE_PATTERNS = [
  /\b[A-HJ-NPR-Z0-9]{17}\b/g,
  /https?:\/\/[^\s"'<>]+/gi,
  /(?:[A-Za-z]:\\|\/(?:home|Users|var|opt|workspace)\/)[^\s"'<>]+/g,
];

export function inspectUntrustedText(text) {
  const value = String(text || "");
  const warningCodes = [];
  if (DIRECTIVE_PATTERNS.some((pattern) => pattern.test(value))) warningCodes.push("UNTRUSTED_DIRECTIVE_QUARANTINED");
  if (SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  })) warningCodes.push("SENSITIVE_TEXT_REDACTED_FROM_RUNTIME_CONTEXT");
  return Object.freeze({
    classification: "untrusted_data",
    directiveLikeContent: warningCodes.includes("UNTRUSTED_DIRECTIVE_QUARANTINED"),
    warningCodes: Object.freeze(warningCodes),
  });
}
