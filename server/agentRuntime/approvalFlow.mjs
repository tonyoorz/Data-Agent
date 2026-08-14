/**
 * P0-3: interrupt/resume approval flow.
 * Dry-run / external-write intents suspend the run with a durable
 * approval/request + approval/decision session event pair. The runtime
 * resumes from the stored handoff state instead of blocking or losing
 * the request.
 */

import { createSessionEventLog } from "./sessionEventLog.mjs";

const PENDING_TTL_MS = 15 * 60 * 1000;

function nowDefault() {
  return new Date();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createApprovalFlow({
  eventLog,
  now = nowDefault,
  ttlMs = PENDING_TTL_MS,
} = {}) {
  const log = eventLog || createSessionEventLog({ now });
  const pending = new Map(); // approvalId -> { request, handoffState, createdAt }

  function expired(entry, at) {
    return at.getTime() - entry.createdAt.getTime() > ttlMs;
  }

  return {
    /**
     * Suspend a run: persist the approval request plus the handoff state
     * (anything the runtime needs to resume), emit durable events.
     */
    async request({ sessionId, kind = "dry_run", summary, toolCall, handoffState }) {
      if (!isRecord(toolCall)) throw new Error("APPROVAL_INVALID: toolCall required");
      const approvalId = `apr_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const request = {
        approvalId,
        sessionId,
        kind,
        summary: String(summary || ""),
        toolCall,
        createdAt: now().toISOString(),
      };
      pending.set(approvalId, { request, handoffState: handoffState ?? null, createdAt: now() });
      await log.append({
        type: "approval/request",
        sessionId,
        payload: {
          approvalId,
          kind,
          summary: request.summary,
          toolName: toolCall.name ?? "",
          arguments: toolCall.arguments ?? {},
        },
      });
      return request;
    },

    /**
     * Resolve a pending approval. Emits approval/decision and returns the
     * handoff state so the runtime resumes exactly where it stopped.
     */
    async decide({ approvalId, decision, decidedBy = "user" }) {
      if (!["approved", "rejected", "expired"].includes(decision)) {
        throw new Error(`APPROVAL_INVALID: unknown decision ${decision}`);
      }
      const entry = pending.get(approvalId);
      if (!entry) return { status: "not_found" };
      pending.delete(approvalId);
      await log.append({
        type: "approval/decision",
        sessionId: entry.request.sessionId,
        payload: {
          approvalId,
          decision,
          decidedBy,
          toolName: entry.request.toolCall.name ?? "",
        },
      });
      return {
        status: "ok",
        decision,
        request: entry.request,
        handoffState: entry.handoffState,
      };
    },

    /** Auto-expire stale approvals; returns expired ids. */
    async expireStale() {
      const at = now();
      const expiredIds = [];
      for (const [approvalId, entry] of pending) {
        if (expired(entry, at)) {
          expiredIds.push(approvalId);
          await this.decide({ approvalId, decision: "expired", decidedBy: "system" });
        }
      }
      return expiredIds;
    },

    listPending(sessionId) {
      const out = [];
      for (const entry of pending.values()) {
        if (!sessionId || entry.request.sessionId === sessionId) {
          out.push({ ...entry.request, expiresInMs: Math.max(0, ttlMs - (now() - entry.createdAt)) });
        }
      }
      return out;
    },
  };
}
