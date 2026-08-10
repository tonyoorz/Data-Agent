# Agent API and event protocol 1.0

Main Agent V2 exposes a server-authoritative, actor-scoped API under `/api/agent`. Requests and events use `schemaVersion: "1.0"`; SSE responses use the `agent-v1` profile. Actor identity and scope come from the trusted server identity layer, never from request-body actor fields.

## Primary lifecycle

1. `POST /api/agent/threads` creates an empty thread and returns HTTP 201.
2. Attachments are uploaded with `POST /api/agent/artifacts` and `X-Agent-Thread-ID` before the Run, then referenced by artifact ID.
3. `POST /api/agent/runs` validates the thread version and returns HTTP 202 with `threadId`, `runId`, and `eventsUrl`.
4. `GET {eventsUrl}?follow=1` replays persisted events and follows until a terminal event. `Last-Event-ID` resumes without duplicating events.
5. `POST /api/agent/runs/{runId}/resume` resumes clarification or approval in the same Run. `POST /cancel` requests terminal cancellation.

Thread read/update, fork, legacy import, artifact, and config routes remain actor-authorized and version checked. `/api/agent/config` is the only browser rollout source; local storage or request parameters cannot enable V2.

## Clarification contract

`clarification.required` contains the interaction ID, thread version, focused question, selectable `options`, response-schema reference, and expiry. The UI submits the selected option back to `/resume`; choosing `补充其他明确口径` additionally requires non-empty `text`. A fallback metric or authorized trace overview can resume without free text, while any option containing `取消` terminally cancels the same Run. Responses that do not satisfy the stored interaction schema are rejected before the interaction is consumed.

## Completion contract

Successful answer events are persisted transactionally in this order:

```text
answer.delta (zero or more chunks)
answer.completed (exactly one metadata envelope)
run.completed (exactly one terminal event)
```

`answer.completed` contains the answer ID and content hash, accepted Claim IDs, citations, assumptions, limitations, grounding status, and source revision set. It deliberately does not repeat answer text. Text exists only in `answer.delta` chunks and the actor-authorized thread snapshot. A quantitative Claim is user-visible only when it is accepted and bound to cited Evidence.

Every Run has exactly one of `run.completed`, `run.failed`, or `run.cancelled`. The terminal transition, assistant message, answer metadata, thread-version increment, and outbox events share one SQLite transaction. Replaying the same idempotency key cannot create a second execution or terminal event.

## Safe observability

Status events may expose normalized intent, Ontology references, registered tool names, progress, Evidence IDs, Claim IDs, safe codes, and counts. They must not expose prompts, model candidates, arbitrary tool arguments, credentials, raw sensitive properties, provider errors, or chain-of-thought. `model.completed` reports only model ID, purpose, normalized finish reason, and token counts; `model.fallback` reports a safe reason code.

The legacy `/api/ai/chat` route is a compatibility adapter. When V2 is selected it invokes the same Runtime kernel and converts persisted events to the legacy stream shape; it does not own a second semantic planner.
