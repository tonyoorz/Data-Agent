# Copilot Usage History Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Node-based generator that scans all retained Copilot chat session history and writes a static HTML usage report to `docs/copilot-usage-history.html`.

**Architecture:** Keep the generator fully offline and independent from the Vite app. Put parsing, aggregation, and HTML rendering in a small testable module under `scripts/`, then add a thin CLI wrapper that discovers session files, writes the report, and prints a concise summary.

**Tech Stack:** Node.js ESM, Vitest, local filesystem access, static HTML

---

### Task 1: Add parser and aggregation contract tests

**Files:**
- Create: `src/test/server/copilotUsageReport.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import {
  aggregateUsageRecords,
  parseChatSessionPatchLog,
  renderUsageReportHtml,
} from "../../../scripts/copilotUsageReport.mjs";

describe("parseChatSessionPatchLog", () => {
  it("reconstructs request usage from the stored patch log", () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { sessionId: "s-1", creationDate: 1710000000000, inputState: { selectedModel: { identifier: "copilot/gpt-5.4", metadata: { inputCost: 250, outputCost: 1500 } } }, requests: [] } }),
      JSON.stringify({ kind: 2, k: ["requests"], v: [{ requestId: "r-1", timestamp: 1710000100000 }] }),
      JSON.stringify({ kind: 1, k: ["requests", 0, "result"], v: { metadata: { promptTokens: 1200, outputTokens: 300 } } }),
      JSON.stringify({ kind: 1, k: ["requests", 0, "completionTokens"], v: 320 }),
      JSON.stringify({ kind: 1, k: ["requests", 0, "elapsedMs"], v: 4500 }),
    ];

    expect(parseChatSessionPatchLog(lines)).toMatchObject({
      sessionId: "s-1",
      selectedModel: "copilot/gpt-5.4",
      requestCount: 1,
      promptTokens: 1200,
      outputTokens: 300,
      completionTokens: 320,
      elapsedMs: 4500,
    });
  });
});

describe("aggregateUsageRecords", () => {
  it("groups totals by model and by day and estimates cost", () => {
    const summary = aggregateUsageRecords([
      {
        sessionId: "s-1",
        title: "Session one",
        selectedModel: "copilot/gpt-5.4",
        startedAt: "2026-06-08T10:00:00.000Z",
        updatedAt: "2026-06-08T10:05:00.000Z",
        requestCount: 1,
        promptTokens: 1200,
        outputTokens: 300,
        completionTokens: 320,
        elapsedMs: 4500,
        pricing: { inputCost: 250, outputCost: 1500 },
      },
    ]);

    expect(summary.totals.estimatedCost).toBeCloseTo(0.75, 5);
    expect(summary.byModel[0]).toMatchObject({
      model: "copilot/gpt-5.4",
      requestCount: 1,
      promptTokens: 1200,
      outputTokens: 300,
    });
    expect(summary.byDay[0]).toMatchObject({
      day: "2026-06-08",
      requestCount: 1,
    });
  });
});

describe("renderUsageReportHtml", () => {
  it("renders summary sections into standalone html", () => {
    const html = renderUsageReportHtml({
      generatedAt: "2026-06-09T00:00:00.000Z",
      totals: { sessionCount: 1, requestCount: 1, promptTokens: 1200, outputTokens: 300, completionTokens: 320, elapsedMs: 4500, estimatedCost: 0.75 },
      byModel: [{ model: "copilot/gpt-5.4", sessionCount: 1, requestCount: 1, promptTokens: 1200, outputTokens: 300, completionTokens: 320, elapsedMs: 4500, estimatedCost: 0.75 }],
      byDay: [{ day: "2026-06-08", sessionCount: 1, requestCount: 1, promptTokens: 1200, outputTokens: 300, completionTokens: 320, elapsedMs: 4500, estimatedCost: 0.75 }],
      topSessions: [{ sessionId: "s-1", title: "Session one", model: "copilot/gpt-5.4", startedAt: "2026-06-08T10:00:00.000Z", updatedAt: "2026-06-08T10:05:00.000Z", requestCount: 1, promptTokens: 1200, outputTokens: 300, completionTokens: 320, elapsedMs: 4500, estimatedCost: 0.75 }],
      warnings: [],
    });

    expect(html).toContain("Copilot Usage History");
    expect(html).toContain("Estimated Cost");
    expect(html).toContain("copilot/gpt-5.4");
    expect(html).toContain("2026-06-08");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/server/copilotUsageReport.test.ts`
Expected: FAIL because `scripts/copilotUsageReport.mjs` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function parseChatSessionPatchLog(lines) {
  // reconstruct final session state and derive request totals
}

export function aggregateUsageRecords(records) {
  // compute totals, model summary, day summary, top sessions
}

export function renderUsageReportHtml(summary) {
  // return standalone html string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/test/server/copilotUsageReport.test.ts`
Expected: PASS

### Task 2: Add the CLI generator

**Files:**
- Create: `scripts/generateCopilotUsageReport.mjs`
- Modify: `package.json`
- Test: `src/test/server/copilotUsageReport.test.ts`

- [ ] **Step 1: Extend coverage with a file-discovery or write-path assertion if needed**

```ts
expect(summary.totals.sessionCount).toBeGreaterThan(0);
```

- [ ] **Step 2: Run the focused test again to verify any new expectation fails first**

Run: `npm test -- src/test/server/copilotUsageReport.test.ts`
Expected: FAIL if the new discovery or formatting expectation is not yet implemented.

- [ ] **Step 3: Add the CLI wrapper and package script**

```ts
// scripts/generateCopilotUsageReport.mjs
// discover local chat session roots
// parse all .jsonl files
// render html and write docs/copilot-usage-history.html
// print output path and aggregate totals
```

```json
"scripts": {
  "report:copilot-usage": "node ./scripts/generateCopilotUsageReport.mjs"
}
```

- [ ] **Step 4: Run the focused test again**

Run: `npm test -- src/test/server/copilotUsageReport.test.ts`
Expected: PASS

### Task 3: Generate the real historical report

**Files:**
- Modify: `docs/copilot-usage-history.html`

- [ ] **Step 1: Run the generator against full local history**

Run: `npm run report:copilot-usage`
Expected: exit `0` and output `docs/copilot-usage-history.html`

- [ ] **Step 2: Spot-check the generated report summary**

Run: `Get-Item docs/copilot-usage-history.html | Select-Object Length, LastWriteTime`
Expected: the file exists, is non-empty, and has a fresh timestamp.

- [ ] **Step 3: Verify the HTML contains the expected headline sections**

Run: `Select-String 'Copilot Usage History|Estimated Cost|By Model|By Day|Top Sessions' docs/copilot-usage-history.html`
Expected: each section name is present.

### Task 4: Run final focused verification

**Files:**
- Test: `src/test/server/copilotUsageReport.test.ts`
- Output: `docs/copilot-usage-history.html`

- [ ] **Step 1: Re-run the focused unit test**

Run: `npm test -- src/test/server/copilotUsageReport.test.ts`
Expected: PASS

- [ ] **Step 2: Re-run the generator once more for a fresh final artifact**

Run: `npm run report:copilot-usage`
Expected: exit `0` and refreshed report output.