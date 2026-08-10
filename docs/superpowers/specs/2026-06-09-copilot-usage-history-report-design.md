# Copilot Usage History Report Design

## Goal

Generate a local offline HTML report from all retained VS Code Copilot chat session history on this machine so the user can inspect model usage, token volume, elapsed time, and estimated cost across the full retained history window.

## Current Behavior

- VS Code persists Copilot chat history under workspace and empty-window session storage as `.jsonl` files.
- These files contain enough state to recover the selected model, per-request token usage, and elapsed time.
- There is no existing repository tool that scans those session files and turns them into a human-readable report.
- The older lightweight debug log folders do not reliably contain request-level usage events for historical sessions, so they are not sufficient for this task.

## Desired Behavior

### Report inputs

The report generator should scan all retained local chat history files from:

- workspace chat sessions for the current VS Code workspace storage root
- empty-window chat sessions if present

The generator should treat missing folders as empty input rather than as a hard failure.

### Extracted metrics

For each retained session, derive at least:

- session id
- creation timestamp
- last activity timestamp
- session title when present
- selected model identifier
- input token count
- output token count
- completion token count when stored separately
- elapsed milliseconds
- estimated cost using the pricing metadata persisted with the selected model

The cost estimate should use the stored model metadata from the session file rather than any hard-coded pricing table.

### HTML output

Generate a standalone static HTML file at `docs/copilot-usage-history.html` containing:

- overall totals for sessions, requests, input tokens, output tokens, elapsed time, and estimated cost
- a model summary table showing request counts, session counts, token totals, and estimated cost by model
- a daily usage table showing totals by local calendar day
- a session table showing the heaviest sessions with model, time span, token totals, elapsed time, and estimated cost
- a short methodology section explaining that the result is a local estimate from retained chat session files, not an official GitHub billing export

The report should not require a running server, JavaScript framework, or external assets.

## Parsing Design

### Session reconstruction

Each chat session file is an append-only JSONL patch log.

The parser should:

1. read the first root snapshot line
2. apply subsequent patch lines onto in-memory state
3. reconstruct final request state for the session

Only the patch patterns needed for retained chat sessions need to be supported:

- root replacement records
- keyed value assignment records
- keyed replacement records for arrays or objects

This keeps the parser focused on the actual persisted format already observed locally.

### Usage aggregation

For each request, use:

- model identifier from the selected model in the session input state
- prompt tokens and output tokens from request result metadata when present
- completion tokens from direct request fields when present
- elapsed milliseconds from direct request fields when present

Aggregate request metrics into session totals, then aggregate session totals into model and day summaries.

### Cost estimation

Use the selected model metadata fields already persisted in the session file:

- `inputCost`
- `outputCost`
- `cacheCost` only if a cache token metric is later observed

For the current report, estimate cost using input and output tokens only. If a cost component cannot be computed because required fields are missing, treat that component as zero and surface the session as partially estimated rather than failing the whole report.

## Implementation Design

### Files

- `scripts/copilotUsageReport.mjs`: parsing, aggregation, and HTML rendering helpers
- `scripts/generateCopilotUsageReport.mjs`: CLI entry point that scans known session roots and writes the report file
- `src/test/server/copilotUsageReport.test.ts`: focused Vitest coverage for patch-log parsing, aggregation, and HTML rendering

### Execution flow

The CLI should:

1. discover session files under the known local storage roots
2. parse all readable `.jsonl` files
3. aggregate report metrics
4. render standalone HTML
5. write `docs/copilot-usage-history.html`
6. print a concise terminal summary including file count, session count, request count, and output path

## Edge Cases

- Session files with malformed JSON lines should be skipped with a warning count rather than aborting the whole report.
- Sessions without requests should still count as sessions but contribute zero usage.
- Sessions missing pricing metadata should still appear with zero estimated cost.
- Empty-window storage may exist but contain zero-byte files; these should be ignored safely.
- The same session id should only be counted once per file processed.

## Testing Strategy

Add focused tests that prove:

- the parser reconstructs final session state from root, set, and replace patch lines
- request metrics are extracted from the reconstructed state
- model and day aggregates compute totals correctly
- estimated cost uses persisted input and output pricing metadata
- rendered HTML contains the expected summary text and table sections

## Out of Scope

- Official GitHub Copilot billing reconciliation
- Live filtering or interactive charts in the generated HTML
- Pulling usage from remote GitHub APIs
- Auto-opening the report in a browser after generation