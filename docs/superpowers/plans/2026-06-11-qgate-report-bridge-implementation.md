# QGate Report Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vizion Lab-local `qgate` skill and bridge command that run the existing TPMDashboard KPI report generator from this repository.

**Architecture:** Keep all report-generation logic in the sibling TPMDashboard repository for now. Add a small Node bridge in Vizion Lab that resolves the source repo and Python executable, forwards CLI arguments, forces a stable `PYTHONPATH`, and writes outputs into Vizion Lab by default.

**Tech Stack:** Node.js ESM, Vitest, child-process spawning, workspace-local GitHub Copilot skill files

---

### Task 1: Add the bridge contract tests

**Files:**
- Create: `src/test/server/qgateKpiReportBridge.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import {
  buildQgateReportBridgeCommand,
  resolveQgateReportPython,
  resolveQgateReportSourceRepo,
} from "../../../scripts/qgateKpiReportBridge.mjs";
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- src/test/server/qgateKpiReportBridge.test.ts`
Expected: FAIL because `scripts/qgateKpiReportBridge.mjs` does not exist yet.

- [ ] **Step 3: Capture repo, Python, and output-root expectations**

```ts
expect(resolveQgateReportSourceRepo(...)).toBe(...);
expect(resolveQgateReportPython(...)).toBe(...);
expect(buildQgateReportBridgeCommand(...).args).toContain("--output-root");
```

- [ ] **Step 4: Re-run the focused test and keep it red until the helper module exists**

Run: `npm test -- src/test/server/qgateKpiReportBridge.test.ts`
Expected: FAIL with missing export or module error.

### Task 2: Implement the bridge helper and CLI

**Files:**
- Create: `scripts/qgateKpiReportBridge.mjs`
- Create: `scripts/generateQgateKpiReportsBridge.mjs`
- Modify: `package.json`

- [ ] **Step 1: Implement repo and Python resolution helpers**

```js
export function resolveQgateReportSourceRepo(options) {
  // prefer explicit override, then sibling candidates
}

export function resolveQgateReportPython(options) {
  // prefer explicit override, then sibling/local venv, then python
}
```

- [ ] **Step 2: Implement command construction and CLI spawning**

```js
export function buildQgateReportBridgeCommand(options) {
  // build python command, preserve explicit output-root, inject PYTHONPATH
}
```

```js
// scripts/generateQgateKpiReportsBridge.mjs
// parse passthrough args
// run child process with stdio inherited
```

- [ ] **Step 3: Add the package entrypoint**

```json
"report:qgate-kpi": "node ./scripts/generateQgateKpiReportsBridge.mjs"
```

- [ ] **Step 4: Run the focused bridge test**

Run: `npm test -- src/test/server/qgateKpiReportBridge.test.ts`
Expected: PASS

### Task 3: Add the workspace skill and usage docs

**Files:**
- Create: `.github/skills/qgate-kpi-report-generator/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Add the workspace-local skill instructions**

```md
Use when regenerating QGate KPI reports from Vizion Lab.
Run `npm run report:qgate-kpi`.
```

- [ ] **Step 2: Document the bridge command and environment overrides in README**

```md
- `VIZION_QGATE_REPORT_SOURCE_REPO`
- `VIZION_QGATE_REPORT_PYTHON`
- `npm run report:qgate-kpi -- --compare-bilingual`
```

- [ ] **Step 3: Re-run the focused bridge test and a command-level smoke check**

Run: `npm test -- src/test/server/qgateKpiReportBridge.test.ts`
Run: `node ./scripts/generateQgateKpiReportsBridge.mjs --help`
Expected: test PASS and help command exits `0`