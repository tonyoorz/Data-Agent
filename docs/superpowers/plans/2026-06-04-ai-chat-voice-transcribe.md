# AI Chat Voice Transcribe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local voice-input flow to AI Chat that records audio in the browser, posts it to a new local `/api/ai/transcribe` endpoint, and fills the returned transcript back into the existing input box without auto-sending.

**Architecture:** Keep the current `/api/ai/chat` and duplicate-search flows unchanged. Add an isolated server-side transcription module plus one new route in the local Node server, then add a microphone control in the existing AI Chat composer that uses `MediaRecorder` and only appends recognized text to the input.

**Tech Stack:** React, Vitest, Node HTTP server, existing local `/api` proxy, browser `MediaRecorder`

---

### Task 1: Add server-side transcription contract tests

**Files:**
- Create: `src/test/server/transcribe.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { transcribeAudio } from "../../../server/transcribe.mjs";

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DUPSEARCH_TRANSCRIBE_URL;
    delete process.env.DUPSEARCH_TRANSCRIBE_API_KEY;
  });

  it("rejects when no transcription provider is configured", async () => {
    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).rejects.toThrow(/not configured/i);
  });

  it("posts the audio payload to the configured provider and returns trimmed text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "  test transcript  " }),
        text: async () => "",
      }),
    );

    process.env.DUPSEARCH_TRANSCRIBE_URL = "https://example.test/transcribe";
    process.env.DUPSEARCH_TRANSCRIBE_API_KEY = "test-key";

    await expect(
      transcribeAudio({ audioBase64: "Zm9v", mimeType: "audio/webm" }),
    ).resolves.toEqual({ text: "test transcript" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/server/transcribe.test.ts`
Expected: FAIL because `server/transcribe.mjs` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function transcribeAudio({ audioBase64, mimeType }) {
  // read env, validate configuration, POST to configured upstream, normalize result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/test/server/transcribe.test.ts`
Expected: PASS

### Task 2: Wire the local `/api/ai/transcribe` endpoint

**Files:**
- Modify: `server/index.mjs`
- Test: `src/test/server/transcribe.test.ts`

- [ ] **Step 1: Extend the failing test with a request-shape expectation if needed**

```ts
expect(fetch).toHaveBeenCalledWith(
  "https://example.test/transcribe",
  expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ audio: "Zm9v", mime: "audio/webm" }),
  }),
);
```

- [ ] **Step 2: Run the server test to verify the new expectation fails**

Run: `npm test -- src/test/server/transcribe.test.ts`
Expected: FAIL on missing request shape or route wiring support.

- [ ] **Step 3: Add the route in `server/index.mjs`**

```ts
if (request.method === "POST" && url.pathname === "/api/ai/transcribe") {
  const body = await readJsonBody(request);
  const result = await transcribeAudio({
    audioBase64: String(body?.audio ?? ""),
    mimeType: String(body?.mime ?? "audio/webm"),
  });
  sendJson(response, 200, { success: true, text: result.text });
  return;
}
```

- [ ] **Step 4: Run the server test again**

Run: `npm test -- src/test/server/transcribe.test.ts`
Expected: PASS

### Task 3: Add AI Chat voice-input UI tests

**Files:**
- Modify: `src/test/ai-chat/AIChat.test.tsx`

- [ ] **Step 1: Write the failing UI tests**

```ts
it("transcribes recorded audio and fills the input without auto-sending", async () => {
  // mock navigator.mediaDevices.getUserMedia
  // mock MediaRecorder lifecycle
  // mock fetch /api/ai/transcribe response
  // click mic -> click stop -> expect textbox value to contain transcript
  // expect /api/ai/chat not called
});

it("shows a short error when transcription fails", async () => {
  // mock recording success and transcription failure
  // expect error text in composer area
});
```

- [ ] **Step 2: Run the AI Chat test file to verify the new tests fail**

Run: `npm test -- src/test/ai-chat/AIChat.test.tsx`
Expected: FAIL because the microphone control and transcription behavior do not exist yet.

- [ ] **Step 3: Implement the smallest UI change in `src/components/dashboard/pages/AIChat.tsx`**

```ts
// add recording / transcribing / transcriptError state
// start MediaRecorder on mic click
// stop recorder on second click
// POST to /api/ai/transcribe
// append transcript to input
```

- [ ] **Step 4: Run the AI Chat test file again**

Run: `npm test -- src/test/ai-chat/AIChat.test.tsx`
Expected: PASS

### Task 4: Run focused regression verification

**Files:**
- Test: `src/test/server/transcribe.test.ts`
- Test: `src/test/ai-chat/AIChat.test.tsx`

- [ ] **Step 1: Run both touched test files together**

Run: `npm test -- src/test/server/transcribe.test.ts src/test/ai-chat/AIChat.test.tsx`
Expected: PASS

- [ ] **Step 2: Run a narrow lint or type-safe check if needed**

Run: `npm test -- src/test/server/companyChat.test.ts`
Expected: PASS to confirm the existing chat server path still behaves as before.