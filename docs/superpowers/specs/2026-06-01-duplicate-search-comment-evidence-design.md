# Duplicate Search Comment Evidence Design

## Context

The current duplicate search flow already uses defect comments during retrieval, but it treats comments as a single raw text field. This helps recall, yet it does not reliably improve the final user-facing summary because noisy comment content mixes together:

- root-cause analysis
- symptom and log evidence
- workflow chatter and state transitions
- generic reminders and meeting notes

The primary goal is not to maximize raw recall. The primary goal is to make the final duplicate-search summary sound like it has seen the historical analysis process, while keeping retrieval stable and avoiding large latency regressions.

## Goals

- Improve summary quality by exposing concise analytical evidence from comments.
- Keep retrieval robust by filtering noisy comment content before it influences ranking.
- Preserve current behavior when the new derived fields are absent.
- Keep the first iteration simple, rule-based, and easy to validate.

## Non-Goals

- No separate comment-level vector index in the first iteration.
- No LLM-based preprocessing of comments in the first iteration.
- No rewrite of the full reranker training strategy in the first iteration.
- No full raw comment dump into prompts or retrieval text.

## Current State

The current flow is:

1. Bridge loads defects and flattens comment payloads.
2. Duplicate search builds a document from defect fields.
3. Ranking and reranking operate on that combined document.
4. Summary and AI context consume only compact candidate snippets.

This means comments can affect retrieval, but they are not curated for either of these separate purposes:

- stable retrieval signals
- concise evidence for final explanation

## Recommendation

Adopt a dual-view comment strategy.

Each defect should expose two derived representations from raw comments:

- `search_comments`: short, filtered, retrieval-safe comment text
- `evidence_snippets`: up to two short evidence fragments for summary generation

This separates retrieval from explanation.

## Proposed Data Flow

1. Load raw comment payloads from SQLite or JSON.
2. Flatten HTML and structured comment payloads into plain text.
3. Split comments into segments.
4. Classify and score each segment with lightweight rules.
5. Build `search_comments` from the highest-value segments.
6. Build `evidence_snippets` from the strongest explanatory segments.
7. Feed `search_comments` into duplicate retrieval and reranking.
8. Feed `evidence_snippets` only into summary and AI context prompts.

## Segment Processing Rules

### Segment Types

Each segment should be classified into one of four buckets.

1. `analysis`
Contains cause hypotheses, component ownership, diagnosis, conclusions, or root-cause statements.

2. `symptom_log`
Contains reproduction clues, error signatures, stack fragments, signal names, error codes, or short diagnostic observations.

3. `workflow_admin`
Contains assignment churn, status updates, reminders, notifications, or generic coordination text.

4. `action_next_step`
Contains validation requests, pending experiments, or follow-up actions.

### Scoring Heuristics

Each segment receives a simple additive score.

- `+3` for `analysis`
- `+2` for `symptom_log`
- `+1` when the segment contains concrete technical anchors such as ECU names, signal names, versions, or error codes
- `+1` when the segment overlaps with title or description keywords
- `-3` for `workflow_admin`
- `-2` for time-stamp heavy, header-like, or attachment-only text
- `-2` for large raw log blocks dominated by symbols and numbers
- `-1` for vague text without technical meaning

The exact keywords can start small and expand using real bad cases.

## Derived Fields

### search_comments

Purpose: retrieval and reranking.

Rules:

- Choose the top 2 to 3 highest-scoring segments.
- Prefer `analysis`, then `symptom_log`, then selected `action_next_step`.
- Exclude `workflow_admin` by default.
- Limit total output to roughly 300 to 600 Chinese characters or equivalent short text budget.

### evidence_snippets

Purpose: summary explanation only.

Rules:

- Choose the top 1 to 2 segments that best explain why the historical defect is relevant.
- Keep wording close to the original comment after cleanup.
- Limit each snippet to roughly 120 to 200 characters.
- Do not include large raw logs or long procedural chatter.

## Integration Plan

### Bridge Layer

Update `scripts/duplicate_search_bridge.py` to derive comment views after `_flatten_comments`.

Add small internal helpers:

- `_split_comment_segments`
- `_classify_comment_segment`
- `_score_comment_segment`
- `_build_comment_views`

Each defect row should then carry:

- `comments` as the current flattened fallback field
- `search_comments`
- `evidence_snippets`

### Retrieval Layer

Update `backend/duplicate_issue_finder.py`.

First iteration behavior:

- Add `search_comments` to the indexed text fields.
- Keep `comments` as a compatibility fallback.
- Prefer `search_comments` over raw `comments` in document construction.
- Prefer `evidence_snippets[0]` as snippet fallback when description is weak or empty.

This allows a staged rollout without breaking old data.

### Reranker Layer

Update `backend/progressive_reranker.py`.

First iteration behavior:

- Replace raw comment overlap dependence with `search_comments`.
- Keep the feature shape simple and backwards-compatible.
- Do not retrain a new model architecture in the first iteration.

### Summary Layer

Update `server/duplicateSummary.mjs` and `server/aiContext.mjs`.

Candidate payloads should include:

- title
- current snippet
- up to two `evidenceSnippets`

Prompt rules should state:

- lead with conclusion
- cite evidence briefly only when explaining why a candidate is relevant
- do not paste long raw comment text
- say evidence is insufficient when comment support is weak

## Performance Expectations

Expected impact is limited if raw comments are not indexed directly.

- Index build time will increase slightly because extra derived text is generated.
- Online retrieval latency should change only modestly because `search_comments` is length-limited.
- Summary latency may increase slightly due to a few additional prompt tokens.
- The main regression risk comes from indexing full raw comments, which this design avoids.

## Rollout Strategy

### Phase 1

Generate `search_comments` and `evidence_snippets`, but only use `evidence_snippets` in summaries.

### Phase 2

Add `search_comments` into duplicate search indexing and reranking.

### Phase 3

Tune heuristics using real false-positive and false-negative cases.

## Testing Strategy

Add or extend tests around the duplicate search comment path.

Required coverage:

1. Segment filtering keeps analysis text and drops workflow noise.
2. Long logs are truncated or excluded from derived fields.
3. Retrieval uses `search_comments` when present and falls back safely when absent.
4. Summary payload contains bounded `evidenceSnippets` and avoids large prompt expansion.

## Acceptance Criteria

The first iteration is successful when:

- summaries more often contain concrete reasoning instead of title restatement
- evidence references are short and relevant
- duplicate retrieval quality does not regress materially
- response latency remains within an acceptable range

## Risks

- Over-aggressive filtering may hide useful technical evidence.
- Under-aggressive filtering may reintroduce workflow noise.
- Some teams may embed analysis in templates that initially look administrative.

The mitigation is to keep the first rule set small, observable, and easy to adjust with test fixtures.

## Recommended First Iteration Scope

Implement only the following:

1. Rule-based comment segmentation and scoring in the bridge.
2. `evidence_snippets` added to candidate payloads for summary.
3. `search_comments` added conservatively to retrieval text.
4. Minimal test coverage for noisy and high-value comment cases.

This scope is intentionally narrow so the team can validate value before investing in deeper retrieval changes.