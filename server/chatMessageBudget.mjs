const DEFAULT_MAX_CHARS = Number(process.env.DUPSEARCH_CHAT_HISTORY_MAX_CHARS || 24000);
const DEFAULT_MAX_MESSAGE_CHARS = Number(process.env.DUPSEARCH_CHAT_MESSAGE_MAX_CHARS || 6000);

function contentLength(content) {
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + contentLength(part?.text ?? part), 0);
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content).length;
  }
  return 0;
}

function messageLength(message) {
  return contentLength(message?.content);
}

function truncateStringFromFront(value, maxMessageChars) {
  if (value.length <= maxMessageChars) {
    return value;
  }
  const marker = "[truncated]\n";
  return `${marker}${value.slice(-maxMessageChars)}`;
}

function truncateMessage(message, maxMessageChars) {
  if (typeof message?.content !== "string") {
    return message;
  }
  const truncatedContent = truncateStringFromFront(message.content, maxMessageChars);
  return truncatedContent === message.content ? message : { ...message, content: truncatedContent };
}

function hasToolCalls(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function isUsefulMessage(message) {
  if (!message || typeof message !== "object") {
    return false;
  }
  if (hasToolCalls(message)) {
    return true;
  }
  if (message.role === "tool") {
    return true;
  }
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  return message.content != null;
}

function buildMessageGroups(messages) {
  const groups = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant" && hasToolCalls(message)) {
      const toolCallIds = new Set(message.tool_calls.map((toolCall) => String(toolCall?.id || "")).filter(Boolean));
      const group = [message];
      let cursor = index + 1;
      while (
        cursor < messages.length &&
        messages[cursor]?.role === "tool" &&
        toolCallIds.has(String(messages[cursor]?.tool_call_id || ""))
      ) {
        group.push(messages[cursor]);
        cursor += 1;
      }
      groups.push(group);
      index = cursor - 1;
      continue;
    }
    groups.push([message]);
  }
  return groups;
}

function groupLength(group) {
  return group.reduce((total, message) => total + messageLength(message), 0);
}

export function compactChatMessages(messages, {
  maxChars = DEFAULT_MAX_CHARS,
  maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const normalizedMessages = messages
    .filter(isUsefulMessage)
    .map((message) => truncateMessage(message, maxMessageChars));
  const groups = buildMessageGroups(normalizedMessages);
  const compactedGroups = [];
  let totalChars = 0;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidateGroup = groups[index];
    const candidateLength = groupLength(candidateGroup);
    if (compactedGroups.length > 0 && totalChars + candidateLength > maxChars) {
      break;
    }
    compactedGroups.unshift(candidateGroup);
    totalChars += candidateLength;
  }

  return compactedGroups.flat();
}