# Duplicate Search Comment Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, high-signal comment-derived evidence to duplicate search so retrieval can use curated comment text and summaries can cite short analytical evidence instead of relying only on title and description snippets.

**Architecture:** Keep the current duplicate-search bridge, index, reranker, and summary flow intact, but introduce two derived comment views: `search_comments` for retrieval-safe indexing and `evidence_snippets` for explanation. Build these views in the Python bridge with lightweight rules, thread them through candidate metadata and payloads, then update the summary and AI-context prompts to consume short evidence lists without exposing raw noisy comments.

**Tech Stack:** Python 3.11, pandas, SQLite, pytest, Node.js, TypeScript, Vitest, server-side ESM modules

---

## File Structure Map

- Modify: `scripts/duplicate_search_bridge.py`
  - Add comment segmentation, rule-based classification/scoring, derived comment views, and candidate payload support for `evidenceSnippets`.
- Modify: `backend/duplicate_issue_finder.py`
  - Add `search_comments` to the indexed text path, persist `evidence_snippets` in candidate metadata, and prefer evidence-backed snippets when descriptions are weak.
- Modify: `backend/progressive_reranker.py`
  - Switch overlap features from raw `comments` to `search_comments` while preserving the feature shape.
- Modify: `backend/tests/test_duplicate_search_comments.py`
  - Cover comment view derivation, retrieval fallback behavior, snippet fallback order, and reranker overlap with curated comment text.
- Modify: `src/components/dashboard/chat/duplicateSearchTypes.ts`
  - Extend duplicate search candidate types with `evidenceSnippets`.
- Modify: `server/duplicateSummary.mjs`
  - Include bounded evidence snippets in the summary prompt and fallback summary behavior.
- Modify: `server/aiContext.mjs`
  - Include candidate evidence in generated AI defect context while keeping the context compact.
- Modify: `src/test/server/aiContext.test.ts`
  - Verify evidence snippets are preserved in cached duplicate-search context output.
- Create: `src/test/server/duplicateSummary.test.ts`
  - Verify summary prompt construction includes at most two bounded evidence snippets per candidate.

### Task 1: Derive curated comment views in the bridge

**Files:**
- Modify: `scripts/duplicate_search_bridge.py`
- Modify: `backend/tests/test_duplicate_search_comments.py`

- [ ] **Step 1: Write failing bridge tests for comment segmentation, filtering, and evidence extraction**

```python
def test_build_comment_views_prefers_analysis_and_drops_workflow_noise():
    bridge = _load_duplicate_search_bridge_module()

    search_comments, evidence_snippets = bridge._build_comment_views(
        """
        Status changed to In Analysis by workflow bot.
        Root cause is likely HU wake timeout after KL15 on.
        Need CAN trace around HU-H5 wake sequence.
        Assigned to team for follow-up.
        """
    )

    assert "workflow bot" not in search_comments.lower()
    assert "assigned to team" not in search_comments.lower()
    assert "root cause is likely hu wake timeout" in search_comments.lower()
    assert evidence_snippets
    assert len(evidence_snippets) <= 2


def test_rows_from_octane_defects_adds_search_comments_and_evidence_snippets(tmp_path):
    bridge = _load_duplicate_search_bridge_module()
    db_path = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT,
                name TEXT,
                description TEXT,
                project TEXT,
                pu TEXT,
                software_version TEXT,
                status_phase TEXT,
                assigned_ecu TEXT,
                lead_model TEXT,
                detected_in_release TEXT,
                comments TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "1",
                "Wake issue",
                "General wake instability.",
                "IDCEVO",
                "27-07",
                "27-07",
                "03-In Analysis",
                "HU-H5",
                "G60",
                "EES27",
                json.dumps([
                    {"text": "Status changed by workflow."},
                    {"text": "Root cause points to HU wake timeout after KL15 on."},
                ]),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    rows = bridge._rows_from_octane_defects(db_path)

    assert rows[0]["search_comments"]
    assert "workflow" not in rows[0]["search_comments"].lower()
    assert rows[0]["evidence_snippets"]
    assert len(rows[0]["evidence_snippets"]) <= 2
```

- [ ] **Step 2: Run the focused backend comment test file and verify the new tests fail**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_duplicate_search_comments.py -q`
Expected: FAIL with `AttributeError` for `_build_comment_views` or missing `search_comments` / `evidence_snippets` fields.

- [ ] **Step 3: Implement comment segmentation, scoring, and derived fields in the bridge**

```python
# scripts/duplicate_search_bridge.py
_WORKFLOW_PATTERNS = (
    r"\bstatus changed\b",
    r"\bassigned to\b",
    r"\bworkflow\b",
    r"\bfyi\b",
)
_ANALYSIS_PATTERNS = (
    r"\broot cause\b",
    r"\blikely\b",
    r"\banalysis\b",
    r"\b定位\b",
    r"\b原因\b",
)
_SYMPTOM_PATTERNS = (
    r"\btimeout\b",
    r"\berror\b",
    r"\btrace\b",
    r"\blog\b",
    r"\bexception\b",
)


def _split_comment_segments(text: str) -> List[str]:
    raw_parts = re.split(r"(?:\n{2,}|[\r\n]+|(?<=[。！？.!?])\s+)", text or "")
    segments = []
    for part in raw_parts:
        clean = _strip_html(str(part or "")).strip()
        if clean:
            segments.append(clean)
    return segments


def _classify_comment_segment(segment: str) -> str:
    lowered = segment.lower()
    if any(re.search(pattern, lowered) for pattern in _WORKFLOW_PATTERNS):
        return "workflow_admin"
    if any(re.search(pattern, lowered) for pattern in _ANALYSIS_PATTERNS):
        return "analysis"
    if any(re.search(pattern, lowered) for pattern in _SYMPTOM_PATTERNS):
        return "symptom_log"
    return "action_next_step"


def _score_comment_segment(segment: str, title: str = "", description: str = "") -> int:
    bucket = _classify_comment_segment(segment)
    score = {"analysis": 3, "symptom_log": 2, "action_next_step": 1, "workflow_admin": -3}[bucket]
    lowered = segment.lower()
    if re.search(r"\b([a-z]{2,6}-[a-z0-9]{1,8}|\d{2}-\d{2}|dtc|ecu|trace|timeout)\b", lowered):
        score += 1
    overlap_tokens = set(re.findall(r"[a-z0-9_./-]{3,}", (title + " " + description).lower()))
    if overlap_tokens.intersection(re.findall(r"[a-z0-9_./-]{3,}", lowered)):
        score += 1
    if sum(ch.isdigit() for ch in segment) > max(8, len(segment) // 3):
        score -= 2
    return score


def _build_comment_views(text: Any, title: str = "", description: str = "") -> tuple[str, List[str]]:
    flattened = _flatten_comments(text)
    segments = _split_comment_segments(flattened)
    ranked = sorted(
        ((segment, _classify_comment_segment(segment), _score_comment_segment(segment, title=title, description=description)) for segment in segments),
        key=lambda item: item[2],
        reverse=True,
    )
    search_segments = [segment for segment, bucket, score in ranked if score > 0 and bucket != "workflow_admin"][:3]
    evidence_snippets = [segment[:180] for segment, bucket, score in ranked if score > 0 and bucket in {"analysis", "symptom_log"}][:2]
    search_comments = "\n".join(search_segments)[:600].strip()
    return search_comments, evidence_snippets


# in _rows_from_octane_defects / _rows_from_defect_file
comments = _flatten_comments(raw.get("comments"))
search_comments, evidence_snippets = _build_comment_views(comments, title=title, description=description)

rows.append(
    {
        "id": str(raw.get("defect_id") or "").strip(),
        "name": title,
        "description": description,
        "comments": comments,
        "search_comments": search_comments,
        "evidence_snippets": evidence_snippets,
        # existing metadata fields unchanged
    }
)
```

- [ ] **Step 4: Run the focused backend comment tests and verify the bridge behavior passes**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_duplicate_search_comments.py -q`
Expected: PASS for the new bridge derivation tests and the existing comment-flattening tests.

- [ ] **Step 5: Commit the bridge changes**

```bash
git add scripts/duplicate_search_bridge.py backend/tests/test_duplicate_search_comments.py
git commit -m "feat: derive duplicate search comment evidence"
```

### Task 2: Use curated comment text in retrieval and snippet fallback

**Files:**
- Modify: `backend/duplicate_issue_finder.py`
- Modify: `backend/progressive_reranker.py`
- Modify: `backend/tests/test_duplicate_search_comments.py`

- [ ] **Step 1: Extend backend tests for `search_comments` indexing and evidence-backed snippet fallback**

```python
def test_build_from_df_prefers_search_comments_for_retrieval():
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Wake issue",
                "description": "",
                "comments": "workflow assignment only",
                "search_comments": "Root cause points to HU wake timeout after KL15 on.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Other issue",
                "description": "irrelevant",
                "comments": "",
                "search_comments": "",
                "status_phase": "03-In Analysis",
            },
        ]
    )

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search("HU wake timeout after KL15 on", top_k=2)

    assert candidates[0].ticket_id == "1"


def test_search_candidate_snippet_prefers_evidence_snippet_before_raw_comments():
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Wake trace issue",
                "description": "",
                "comments": "workflow assignment only",
                "evidence_snippets": [["Root cause points to HU wake timeout after KL15 on."]][0],
                "status_phase": "03-In Analysis",
            }
        ]
    )

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search("HU wake timeout after KL15 on", top_k=1)

    assert candidates[0].snippet.startswith("Root cause points to HU wake timeout")


def test_feature_reranker_overlap_uses_search_comments_text():
    reranker = FeatureReRanker(feedback_store=None)

    feature_row = reranker.build_feature_row(
        query_text="HU wake timeout after KL15 on",
        meta={
            "name": "Issue A",
            "description": "",
            "comments": "workflow assignment only",
            "search_comments": "Root cause points to HU wake timeout after KL15 on.",
            "project": "",
            "pu": "",
            "ecu": "",
            "lead_model": "",
        },
        base_similarity=0.5,
        popularity_stats=None,
        rank_pos=0,
    )

    assert feature_row[5] > 0.0
```

- [ ] **Step 2: Run the focused backend comment tests and verify the new retrieval tests fail**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_duplicate_search_comments.py -q`
Expected: FAIL because `search_comments` is not yet indexed and snippet fallback still uses raw `comments`.

- [ ] **Step 3: Update duplicate retrieval metadata, text fields, and reranker overlap to use curated comment views**

```python
# backend/duplicate_issue_finder.py
DEFAULT_TEXT_FIELDS = (
    "name",
    "description",
    "search_comments",
    "comments",
    "project",
    "pu",
    "ecu",
    "top_aida",
    "fv",
    "team",
    "fvp",
    "lead_model",
)


def _candidate_snippet(meta: Dict[str, Any]) -> str:
    evidence = meta.get("evidence_snippets") or []
    first_evidence = evidence[0] if isinstance(evidence, list) and evidence else ""
    return _safe_snippet(meta.get("description") or first_evidence or meta.get("search_comments") or meta.get("comments") or "")


# inside build_from_df metadata capture
"search_comments": _normalize_text(row.get("search_comments")) or "",
"evidence_snippets": list(row.get("evidence_snippets") or []),


# inside _keyword_fallback haystack
f"{meta.get('search_comments','')}\n"
```

```python
# backend/progressive_reranker.py
overlap = _token_overlap(
    query_text,
    "\n".join(
        str(meta.get(key) or "")
        for key in ("name", "description", "search_comments", "project", "pu", "ecu", "lead_model")
    ),
)
```

- [ ] **Step 4: Run the focused backend comment tests and verify retrieval/reranker behavior passes**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_duplicate_search_comments.py -q`
Expected: PASS, including retrieval via `search_comments`, evidence snippet fallback, and reranker overlap assertions.

- [ ] **Step 5: Commit the retrieval-layer changes**

```bash
git add backend/duplicate_issue_finder.py backend/progressive_reranker.py backend/tests/test_duplicate_search_comments.py
git commit -m "feat: use curated comment text in duplicate retrieval"
```

### Task 3: Thread evidence snippets through duplicate-search results and AI context

**Files:**
- Modify: `scripts/duplicate_search_bridge.py`
- Modify: `src/components/dashboard/chat/duplicateSearchTypes.ts`
- Modify: `server/aiContext.mjs`
- Modify: `src/test/server/aiContext.test.ts`

- [ ] **Step 1: Write failing tests for evidence snippets in duplicate-search result payloads and AI context**

```ts
it("includes evidence snippets in formatted AI defect context", async () => {
  const runDuplicateBridge = vi.fn().mockResolvedValue({
    success: true,
    result: {
      candidates: [
        {
          ticketId: "2686999",
          name: "导航黄屏 related defect",
          score1to10: 8,
          similarity: 0.88,
          project: "IDCEVO",
          pu: "26-07",
          statusPhase: "03-In Analysis_Medium",
          snippet: "与导航黑屏和黄屏相关的历史缺陷。",
          evidenceSnippets: ["分析结论：HU wake timeout after KL15 on."],
        },
      ],
      modelPhase: "click_boost",
      feedbackCount: 0,
      dataset_size: 34717,
      timings: { total_ms: 1, index_rebuilt: false },
    },
  });

  const resolved = await resolveAiDefectContext({
    runDuplicateBridge,
    messages: [{ role: "user", content: "请总结当前缺陷风险" }],
    topK: 5,
  });

  expect(resolved.contextText).toContain("证据: 分析结论：HU wake timeout after KL15 on.");
});
```

- [ ] **Step 2: Run the focused server-side AI context test and verify it fails**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/aiContext.test.ts`
Expected: FAIL because evidence snippets are not present in candidate types or AI context formatting.

- [ ] **Step 3: Add `evidenceSnippets` to candidate payloads and AI context formatting**

```python
# scripts/duplicate_search_bridge.py inside result_items.append(...)
"evidenceSnippets": list(getattr(candidate, "evidence_snippets", []) or []),
```

```python
# backend/duplicate_issue_finder.py
@dataclass(frozen=True)
class DuplicateCandidate:
    score_1_10: int
    similarity: float
    ticket_id: Optional[str]
    name: str
    project: Optional[str]
    pu: Optional[str]
    status_phase: Optional[str]
    snippet: str
    evidence_snippets: Tuple[str, ...] = ()


# in _ranked_to_candidates(...)
evidence = meta.get("evidence_snippets") or []
DuplicateCandidate(
    ...,
    snippet=_candidate_snippet(meta),
    evidence_snippets=tuple(str(item) for item in evidence[:2] if str(item).strip()),
)
```

```ts
// src/components/dashboard/chat/duplicateSearchTypes.ts
export interface DuplicateSearchCandidate {
  score1to10: number;
  similarity: number;
  ticketId: string;
  name: string;
  project?: string;
  pu?: string;
  statusPhase?: string;
  snippet: string;
  evidenceSnippets?: string[];
}
```

```js
// server/aiContext.mjs inside candidate formatter
const evidence = Array.isArray(candidate.evidenceSnippets)
  ? candidate.evidenceSnippets.filter(Boolean).slice(0, 2)
  : [];

return [
  `${index + 1}. Ticket ${candidate.ticketId || "N/A"}`,
  `标题: ${normalizeTitle(candidate.name) || "Untitled"}`,
  `评分: ${candidate.score1to10}/10`,
  `元信息: ${meta}`,
  `摘要: ${normalizeSnippet(candidate.snippet) || "无"}`,
  ...(evidence.length ? [`证据: ${evidence.map((item) => normalizeSnippet(item)).join(" | ")}`] : []),
].join("\n");
```

- [ ] **Step 4: Run the focused AI context test and verify evidence is present and cached safely**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/aiContext.test.ts`
Expected: PASS with evidence shown once in formatted context and preserved on cache hits.

- [ ] **Step 5: Commit the payload and AI context changes**

```bash
git add scripts/duplicate_search_bridge.py backend/duplicate_issue_finder.py src/components/dashboard/chat/duplicateSearchTypes.ts server/aiContext.mjs src/test/server/aiContext.test.ts
git commit -m "feat: surface duplicate search evidence snippets"
```

### Task 4: Update duplicate summary prompting to cite bounded evidence

**Files:**
- Modify: `server/duplicateSummary.mjs`
- Create: `src/test/server/duplicateSummary.test.ts`

- [ ] **Step 1: Write a failing summary test that asserts evidence snippets are included and bounded**

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../server/chatModelConfig.mjs", () => ({
  resolveChatModelConfig: () => ({ model: "test-model", credential: "token" }),
  buildChatCompletionRequest: ({ messages }: { messages: Array<{ role: string; content: string }> }) => ({
    url: "https://example.invalid",
    headers: {},
    body: { messages },
  }),
}));

import { summarizeDuplicateResults } from "../../../server/duplicateSummary.mjs";

it("includes short evidence snippets in the summary request", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "候选 1 最可能重复。" } }] }),
  });
  vi.stubGlobal("fetch", fetchMock);

  await summarizeDuplicateResults("导航黄屏", {
    candidates: [
      {
        ticketId: "2686999",
        name: "导航黄屏 related defect",
        score1to10: 8,
        project: "IDCEVO",
        pu: "26-07",
        statusPhase: "03-In Analysis",
        snippet: "与导航黑屏和黄屏相关的历史缺陷。",
        evidenceSnippets: [
          "分析结论：HU wake timeout after KL15 on.",
          "日志显示 wake sequence 中断。",
          "这条不应该进入 prompt。",
        ],
      },
    ],
    modelPhase: "click_boost",
    feedbackCount: 0,
  }, "mock-model");

  const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(requestBody.messages[1].content).toContain("证据1: 分析结论：HU wake timeout after KL15 on.");
  expect(requestBody.messages[1].content).toContain("证据2: 日志显示 wake sequence 中断。");
  expect(requestBody.messages[1].content).not.toContain("这条不应该进入 prompt");
});
```

- [ ] **Step 2: Run the focused duplicate summary test and verify it fails**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/duplicateSummary.test.ts`
Expected: FAIL because `summarizeDuplicateResults` does not yet include evidence snippets in the user prompt.

- [ ] **Step 3: Update summary prompt construction and fallback summary wording to use bounded evidence**

```js
// server/duplicateSummary.mjs
function buildEvidenceLines(candidate) {
  const evidence = Array.isArray(candidate.evidenceSnippets)
    ? candidate.evidenceSnippets.filter(Boolean).slice(0, 2)
    : [];
  return evidence.map((item, index) => `证据${index + 1}: ${String(item).trim()}`);
}

function buildUserPrompt(query, result) {
  const candidates = result.candidates
    .slice(0, 5)
    .map((candidate, index) => {
      const meta = [candidate.project, candidate.pu, candidate.statusPhase].filter(Boolean).join(" / ") || "-";
      return [
        `${index + 1}. Ticket: ${candidate.ticketId || "N/A"}`,
        `标题: ${candidate.name || "Untitled"}`,
        `评分: ${candidate.score1to10}/10`,
        `元信息: ${meta}`,
        `摘要: ${candidate.snippet || "无"}`,
        ...buildEvidenceLines(candidate),
      ].join("\n");
    })
    .join("\n\n");

  return [
    `用户问题：${query}`,
    `检索阶段：${result.modelPhase}`,
    `反馈样本：${result.feedbackCount}`,
    "",
    "候选结果：",
    candidates || "无候选结果",
  ].join("\n");
}

// system prompt content
"你是缺陷重复检索助手。请基于候选结果给出简洁中文总结，先说明最可能的重复票，再用最多两条短证据解释判断依据，并给出下一步建议。若候选不足或证据不足，请明确指出。控制在6行内。"
```

- [ ] **Step 4: Run the focused summary test and verify prompt evidence is bounded**

Run: `& 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/duplicateSummary.test.ts`
Expected: PASS with only the first two evidence snippets present in the request body.

- [ ] **Step 5: Run the combined regression slice for backend and server tests**

Run: `& .\.venv\Scripts\python.exe -m pytest backend/tests/test_duplicate_search_comments.py -q ; & 'C:\nvm4w\nodejs\npm.cmd' test -- src/test/server/aiContext.test.ts src/test/server/duplicateSummary.test.ts`
Expected: PASS for all duplicate-search comment evidence tests.

- [ ] **Step 6: Commit the summary prompt changes**

```bash
git add server/duplicateSummary.mjs src/test/server/duplicateSummary.test.ts
git commit -m "feat: cite duplicate search evidence in summaries"
```

## Self-Review

### Spec Coverage

- Dual-view comment derivation is covered by Task 1.
- Conservative retrieval and reranker integration is covered by Task 2.
- Candidate payload plumbing and AI context exposure is covered by Task 3.
- Summary evidence prompting is covered by Task 4.
- Performance protection via bounded fields appears in Tasks 1, 3, and 4 through explicit truncation and `slice(0, 2)` limits.

### Placeholder Scan

- No `TODO`, `TBD`, or "implement later" placeholders remain.
- Each task includes explicit file paths, test code, commands, and expected outcomes.

### Type Consistency

- The plan uses `search_comments` in Python metadata and `evidenceSnippets` in the JS/TS payload shape consistently.
- `DuplicateCandidate.evidence_snippets` maps to serialized `evidenceSnippets` in the bridge payload.
- `DuplicateSearchCandidate` is the single TypeScript surface that receives `evidenceSnippets`.