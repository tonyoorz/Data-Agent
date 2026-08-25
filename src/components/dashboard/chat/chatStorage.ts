export const LEGACY_CHAT_STORAGE_KEY = "dtsv.chat.v2";

const CHAT_STORAGE_NAMESPACE = "dtsv.chat.v3";
const CHAT_STORAGE_DOMAIN = "vizion-ai-chat-actor-storage-v1";

type AuthenticatedSessionLike = {
  user?: {
    id?: unknown;
  } | null;
} | null;

function actorIdFromSession(session: AuthenticatedSessionLike) {
  return typeof session?.user?.id === "string" ? session.user.id.trim() : "";
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function actorScopedChatStorageKey(session: AuthenticatedSessionLike): Promise<string | null> {
  const actorId = actorIdFromSession(session);
  const subtle = globalThis.crypto?.subtle;
  if (!actorId || !subtle || typeof subtle.digest !== "function") {
    return null;
  }
  const material = new TextEncoder().encode(`${CHAT_STORAGE_DOMAIN}\u0000${actorId}`);
  const digest = await subtle.digest("SHA-256", material);
  return `${CHAT_STORAGE_NAMESPACE}.${hex(new Uint8Array(digest))}`;
}
