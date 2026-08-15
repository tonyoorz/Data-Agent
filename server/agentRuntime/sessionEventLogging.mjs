/**
 * Shared session-event append helper.
 * Session logging is observability: failures never break the chat path.
 */

export function safeAppendSessionEvent(log, event) {
  if (!log || typeof log.append !== "function") return Promise.resolve(null);
  return Promise.resolve(log.append(event)).then((stored) => stored, () => null);
}
