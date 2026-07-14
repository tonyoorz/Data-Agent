# Duplicate Search Agent Technical Sharing Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and verify a 16-slide editable PowerPoint that explains the Duplicate Search Agent to test, product, engineering, and management audiences in a 30-minute internal technical sharing session.

**Architecture:** Build the deck from scratch with `@oai/artifact-tool` in an external scratch workspace. Capture the existing React UI with synthetic duplicate-search responses, embed those screenshots as concrete assets, and construct only the requested explanatory diagrams as editable PowerPoint shapes. Export the PPTX, render every slide, run structural and content checks, complete a fresh-eye visual review, fix issues, and re-verify.

**Tech Stack:** JavaScript ES modules, `@oai/artifact-tool`, Playwright, Vite, PowerPoint/PPTX, LibreOffice/Poppler rendering helpers, MarkItDown, project Python and JavaScript source files.

---

## File Structure

**Repository deliverables**

- Create: `outputs/Duplicate_Search_Agent_Technical_Sharing.pptx` — final editable deck.
- Existing source of truth: `docs/superpowers/specs/2026-07-14-duplicate-search-agent-tech-share-deck-design.md` — approved narrative and visual specification.
- Existing implementation evidence: `backend/duplicate_issue_finder.py`, `backend/progressive_reranker.py`, `backend/feedback_store.py`, `scripts/duplicate_search_bridge.py`, `server/duplicateBridgeRuntime.cjs`, `server/duplicateSummary.mjs`, `server/index.mjs`, `src/components/dashboard/pages/AIChat.tsx`, `src/components/dashboard/chat/DuplicateSearchResults.tsx`.

**External scratch workspace**

- Create: `$TMP_DIR/source-notes.txt` — claim-to-source ledger and current/future status.
- Create: `$TMP_DIR/slide-plan.txt` — 16-slide content, visuals, and speaker-note matrix.
- Create: `$TMP_DIR/capture-ui.mjs` — Playwright screenshot script with synthetic responses.
- Create: `$ASSET_DIR/ui-input.png` — actual project UI in duplicate-search input state.
- Create: `$ASSET_DIR/ui-results.png` — actual project UI with synthetic candidate results.
- Create: `$ASSET_DIR/ui-feedback.png` — actual project UI after synthetic positive feedback.
- Create: `$TMP_DIR/build-deck.mjs` — artifact-tool deck source.
- Create: `$PREVIEW_DIR/slide-01.png` through `$PREVIEW_DIR/slide-16.png` — first-pass slide previews.
- Create: `$LAYOUT_DIR/slide-01.layout.json` through `$LAYOUT_DIR/slide-16.layout.json` — structural layout evidence.
- Create: `$QA_DIR/content.txt` — extracted deck text.
- Create: `$QA_DIR/issues-pass-1.txt` and `$QA_DIR/issues-pass-2.txt` — visual QA ledger.

## Task 1: Verify Current Implementation Facts And Prepare The Workspace

**Files:**

- Read: `docs/superpowers/specs/2026-07-14-duplicate-search-agent-tech-share-deck-design.md`
- Read: the implementation evidence files listed above.
- Create: `$TMP_DIR/source-notes.txt`
- Create: `$TMP_DIR/slide-plan.txt`

- [ ] **Step 1: Resolve the external scratch and output paths**

Run:

```bash
NODE=/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
SCRATCH_ROOT="$($NODE -p "require('node:os').tmpdir()")"
THREAD_ID="${CODEX_THREAD_ID:-manual-20260714-dupsearch-deck}"
WORKSPACE="$SCRATCH_ROOT/codex-presentations/$THREAD_ID/duplicate-search-tech-share"
TMP_DIR="$WORKSPACE/tmp"
ASSET_DIR="$TMP_DIR/assets"
PREVIEW_DIR="$TMP_DIR/preview"
LAYOUT_DIR="$TMP_DIR/layout"
QA_DIR="$TMP_DIR/qa"
FINAL_PPTX=/Users/tonyorz/Data-Agent/outputs/Duplicate_Search_Agent_Technical_Sharing.pptx
mkdir -p "$ASSET_DIR" "$PREVIEW_DIR" "$LAYOUT_DIR" "$QA_DIR" "$(dirname "$FINAL_PPTX")"
```

Expected: all scratch directories exist outside `/Users/tonyorz/Data-Agent`; only `outputs/` is created in the repository.

- [ ] **Step 2: Verify the code paths used for visible claims**

Run:

```bash
rg -n '_DEFAULT_EMBEDDING_MODEL_ID|_retrieval_weights_for_query|TfidfVectorizer|_RRF_K|_fuse_ranked_lists_rrf|extract_hints|calibrate_duplicate_confidence' backend/duplicate_issue_finder.py
rg -n 'FEATURE_THRESHOLD|ADAPTER_THRESHOLD|MAX_ABS_BOOST|ModelSafetyGuard|LogisticRegression|ContrastiveAdapter' backend/progressive_reranker.py backend/feedback_store.py
rg -n '_build_comment_views|search_comments|evidence_snippets|prepared_index_manifest_hit|action == .warmup.|action == .feedback.' scripts/duplicate_search_bridge.py
rg -n 'runDuplicateBridge|searchRequestTimeoutMs|summarizeDuplicateResults|/api/duplicate-search|/api/duplicate-feedback' server/duplicateBridgeRuntime.cjs server/duplicateSummary.mjs server/index.mjs
```

Expected: output confirms BGE-small-zh-v1.5, char n-gram TF-IDF, weighted RRF, hard/soft hints, calibrated confidence, 0/50/200 feedback phases, comment curation, warmup/cache behavior, constant Python bridge, and separate LLM summarization.

- [ ] **Step 3: Confirm the Python source files parse**

Run:

```bash
python3 -m py_compile backend/duplicate_issue_finder.py backend/progressive_reranker.py backend/feedback_store.py scripts/duplicate_search_bridge.py
```

Expected: exit code 0 and no syntax errors.

- [ ] **Step 4: Write the source ledger**

Create `$TMP_DIR/source-notes.txt` with these exact sections and classifications:

```text
CURRENT IMPLEMENTATION
- BGE-small-zh-v1.5 is the default local semantic embedding model; local loading is preferred and remote download is opt-in.
- Sparse retrieval is character-level TF-IDF with char_wb 3-5 grams and up to 200,000 features.
- Dense and sparse ranked lists are combined with weighted RRF using k=60; identifier-heavy queries shift weights from 1.0/1.0 to 0.75/2.0.
- Project and PU hints filter candidates; Project, PU, ECU, and Lead Model can add bounded score boosts.
- Candidate confidence is a deterministic calibrated score, not a probability.
- Feedback phases are click_boost below 50, feature at 50+, and adapter at 200+; feature training uses logistic regression and the safety guard limits nDCG regression to 0.05.
- Comments are classified and scored so workflow noise is excluded while analysis/evidence snippets are surfaced.
- Node keeps a JSON-line Python child process alive, retries selected bridge failures, and uses longer timeouts for search/warmup.
- The LLM writes a short evidence-grounded summary after retrieval and reranking; it does not generate the candidate list.

PROJECT MATERIAL ESTIMATE
- Approximately 16,000 active defects; label this as an approximate existing-project-material figure, not live telemetry.

FUTURE ROADMAP, NOT CURRENT
- Build a 100-300 pair labeled evaluation set and record Recall@10, nDCG@10, and MRR baselines.
- Validate query normalization and a local cross-encoder for cold-start reranking.
- Evaluate BM25 or BGE-M3 sparse and a BGE-M3 embedding upgrade only after baseline measurement.
- Revisit ANN/vector-database infrastructure only when scale and latency measurements justify it.
```

- [ ] **Step 5: Write the 16-slide content matrix**

Create `$TMP_DIR/slide-plan.txt` with one block per slide containing `TITLE`, `VISIBLE COPY`, `PRIMARY VISUAL`, `CASE THREAD`, `CURRENT/FUTURE`, and `SPEAKER NOTES`. Use the exact 16 titles from the approved design. Keep visible body copy under 55 Chinese characters per slide except architecture labels, and allocate speaker-note timing that totals approximately 30 minutes.

## Task 2: Capture Real Project UI With Synthetic Data

**Files:**

- Create: `$TMP_DIR/capture-ui.mjs`
- Create: `$ASSET_DIR/ui-input.png`
- Create: `$ASSET_DIR/ui-results.png`
- Create: `$ASSET_DIR/ui-feedback.png`

- [ ] **Step 1: Start only the Vite client**

Run in a persistent terminal session:

```bash
npm run dev:client -- --host 127.0.0.1
```

Expected: Vite serves the existing app at `http://127.0.0.1:8080` without modifying project files.

- [ ] **Step 2: Create the Playwright capture script**

Create `$TMP_DIR/capture-ui.mjs` that:

1. launches Chromium at a 1600×1000 viewport;
2. intercepts `/api/duplicate-search/warmup`, `/api/duplicate-search`, and `/api/duplicate-feedback`;
3. opens the current app, clicks the AI Chat navigation item, and selects Duplicate Search;
4. captures the input state;
5. submits `IDCEVO 蓝牙断开后无法重连，DTC B1234，handshake timeout`;
6. returns exactly two synthetic candidates with ticket IDs `DEF-2048` and `DEF-1027`, confidence, similarity, evidence snippets, and Dense/Sparse ranking signals;
7. captures the result state;
8. clicks the positive-feedback button for `DEF-2048` and captures the feedback state.

Use this response payload:

```js
const duplicateResult = {
  success: true,
  result: {
    searchId: "demo-duplicate-search",
    queryText: "IDCEVO 蓝牙断开后无法重连，DTC B1234，handshake timeout",
    summaryText: "最可能重复票：DEF-2048（高置信度）。\n依据：触发路径、DTC 与 handshake timeout 一致。\n下一步：打开原票核对软件版本与时间戳。",
    modelPhase: "click_boost",
    feedbackCount: 18,
    dataset_size: 16000,
    candidates: [
      {
        ticketId: "DEF-2048",
        name: "BT pairing failed after ACP disconnect",
        confidenceScore1to10: 8,
        confidenceLabel: "high",
        score1to10: 7,
        similarity: 0.72,
        project: "IDCEVO",
        pu: "24-07",
        statusPhase: "03-Analysis",
        reviewFocus: "触发路径与日志症状高度一致，优先核对软件版本和时间戳。",
        evidenceSnippets: ["After ACP disconnect, handshake timeout reproduced on HU-MGU."],
        rankingSignals: { denseRank: 2, sparseRank: 1, denseWeight: 0.75, sparseWeight: 2.0 }
      },
      {
        ticketId: "DEF-1027",
        name: "Bluetooth reconnection takes longer than expected",
        confidenceScore1to10: 6,
        confidenceLabel: "medium",
        score1to10: 6,
        similarity: 0.61,
        project: "IDCEVO",
        pu: "24-07",
        statusPhase: "02-Open",
        reviewFocus: "现象接近，但缺少相同 DTC；需要核对 ECU 和触发路径。",
        evidenceSnippets: ["Reconnect delay observed without the B1234 DTC."],
        rankingSignals: { denseRank: 1, sparseRank: 6, denseWeight: 0.75, sparseWeight: 2.0 }
      }
    ]
  }
};
```

- [ ] **Step 3: Run the capture script**

Run:

```bash
NODE_PATH=/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node "$TMP_DIR/capture-ui.mjs"
```

Expected: the three PNG files exist in `$ASSET_DIR`, each is at least 1200 pixels wide, and only synthetic ticket information is visible.

- [ ] **Step 4: Inspect the screenshots**

Open all three images at original detail and verify: Duplicate Search mode is active, the text is readable, candidate order is correct, evidence is visible, and the feedback state is visible. If the full-page capture is too dense, recapture the `main` element or the candidate result container instead of cropping with Python.

## Task 3: Initialize Artifact Tool And Implement The Deck

**Files:**

- Create: `$TMP_DIR/build-deck.mjs`
- Read: the approved design spec and `$TMP_DIR/slide-plan.txt`

- [ ] **Step 1: Initialize the artifact-tool workspace**

Run:

```bash
SLIDE_SKILL=/Users/tonyorz/.codex/plugins/cache/openai-primary-runtime/presentations/26.709.11516/skills/presentations
NODE=/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
$NODE "$SLIDE_SKILL/container_tools/setup_artifact_tool_workspace.mjs" --workspace "$TMP_DIR"
```

Expected: `$TMP_DIR/node_modules/@oai/artifact-tool` resolves from plain Node ESM.

- [ ] **Step 2: Implement shared deck helpers**

In `$TMP_DIR/build-deck.mjs`, import `fs/promises`, `Presentation`, and `PresentationFile`; create a 1280×720 presentation; define the approved palette `paper=#F4F0E8`, `ink=#26333A`, `muted=#687274`, `teal=#147D78`, `tealSoft=#DCEAE6`, `orange=#E8732A`, `orangeSoft=#F2DDC7`, and `white=#FFFFFF`.

Implement these focused helpers:

```js
addBase(slide, section, pageNumber, dark = false)
addTitle(slide, title, subtitle)
addTextBox(slide, text, position, style)
addRoundedRect(slide, position, fill, line, radius)
addImage(slide, imagePath, position, alt, fit = "cover")
connect(slide, fromShape, toShape, options)
setNotes(slide, lines)
writeBlob(filePath, blob)
exportEvidence(presentation)
```

`addBase` must use equal 64px side margins, a small section label, and a quiet page number. `setNotes` must call `slide.speakerNotes.textFrame.setText(lines)` and mark notes visible. `exportEvidence` must write every slide PNG, every layout JSON, a montage WebP, and the final PPTX.

- [ ] **Step 3: Implement slides 1–4 — problem and business flow**

Create:

1. Minimal dark title slide with one promise and no agenda.
2. Anonymous two-ticket visual showing semantically equivalent wording and a small counterexample showing similar wording but different context.
3. A visual search burden showing the anonymous Bluetooth case against an approximate 16k record field and a `16k → 50 → 8` funnel.
4. Four-lane business swimlane: Test Engineer, Vizion, Search Engine, Octane/Data. Use connectors behind nodes and keep labels to short verbs.

Add speaker notes covering approximately five minutes total.

- [ ] **Step 4: Implement slides 5–10 — retrieval principles**

Create:

5. Semantic-space illustration with three Bluetooth phrases clustered together and unrelated defect phrases separated; include a short BGE-small-zh-v1.5 selection rationale.
6. Character n-gram visual that breaks `DTC B1234 / handshake timeout / 24-07` into overlapping fragments and shows why exact entities survive.
7. Two ranking ladders for Dense and Sparse flowing into a weighted-RRF result list; show `k=60` and the identifier-heavy `0.75 / 2.0` weight shift in a small annotation.
8. Hard/soft hint visual: Project/PU filter gate, ECU/Lead Model bounded boost; reuse the Bluetooth case.
9. Before/after comment-cleaning visual with workflow noise crossed out and analysis/evidence retained.
10. Cache and warmup data flow: raw defects → curated documents → embedding cache / sparse index → snapshot → warm search, with local/remote/sparse fallback annotations.

Keep each slide to one conclusion and add approximately 13 minutes of notes across slides 4–10.

- [ ] **Step 5: Implement slides 11–13 — agent architecture, learning, and UI/UX**

Create:

11. Four-layer architecture: UI, Node orchestration, Python retrieval/learning, data/cache. Show the constant JSON-line process and LLM summary as separate roles.
12. Feedback staircase with thresholds `0`, `50`, and `200`; show Click Boost, Logistic Regression features, and Contrastive Adapter. Add a safety rail labeled `rate limit + nDCG guard`.
13. Embed `$ASSET_DIR/ui-results.png` as the primary visual and place four short callouts for confidence, evidence, ranking signals, and feedback. Add a smaller inset from `$ASSET_DIR/ui-feedback.png` without reusing the same image elsewhere.

Add approximately six minutes of notes across slides 11–13.

- [ ] **Step 6: Implement slides 14–16 — tradeoffs, limits, and action**

Create:

14. Scale/complexity decision visual comparing current matrix search and a future ANN/vector database; mark the current state as `万级 / 简单 / 可控`, not as a universal benchmark claim.
15. Evaluation gap visual with three empty gauges: Recall@10, nDCG@10, MRR. Explain that the missing baseline, not the lack of a larger model, is the immediate bottleneck.
16. Three-step roadmap: labeled set and baseline → controlled experiments → measured upgrade. End with four compact role actions for Test, Product, Engineering, and Management; do not end with a generic thank-you slide.

Add approximately six minutes of notes across slides 14–16, including a transition into the 10-minute Q&A.

- [ ] **Step 7: Export the first pass**

Run:

```bash
$NODE "$TMP_DIR/build-deck.mjs"
```

Expected: 16 slide PNGs, 16 layout JSON files, one montage, and `/Users/tonyorz/Data-Agent/outputs/Duplicate_Search_Agent_Technical_Sharing.pptx`.

## Task 4: Run Structural And Content QA

**Files:**

- Read: `$LAYOUT_DIR/*.layout.json`
- Create: `$QA_DIR/content.txt`
- Create: `$QA_DIR/issues-pass-1.txt`

- [ ] **Step 1: Run the slide-boundary checker**

Run:

```bash
PY=/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
SLIDE_SKILL=/Users/tonyorz/.codex/plugins/cache/openai-primary-runtime/presentations/26.709.11516/skills/presentations
PATH=/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override:/Users/tonyorz/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
$PY "$SLIDE_SKILL/container_tools/slides_test.py" "$FINAL_PPTX"
```

Expected: no elements extend outside the 1280×720 slide canvas.

- [ ] **Step 2: Extract deck text**

Install MarkItDown into the external workspace only if it is missing:

```bash
$PY -m pip install --target "$WORKSPACE/python" "markitdown[pptx]" defusedxml
PYTHONPATH="$WORKSPACE/python" $PY -m markitdown "$FINAL_PPTX" > "$QA_DIR/content.txt"
```

Expected: all 16 titles occur in order; no `xxxx`, `lorem`, `ipsum`, production ticket IDs, VIN-like strings, credentials, code-level module names, or internal planning language appears.

- [ ] **Step 3: Scan for placeholders and sensitive terms**

Run:

```bash
rg -ni 'xxxx|lorem|ipsum|todo|tbd|placeholder|password|authorization|cookie|token|vin|duplicate_issue_finder|progressive_reranker|duplicate_search_bridge' "$QA_DIR/content.txt"
```

Expected: no matches. `DEF-2048` and `DEF-1027` are allowed synthetic IDs.

- [ ] **Step 4: Inspect the first-pass montage and full-size slides**

Open `$PREVIEW_DIR/deck-montage.webp`, then open each of the 16 slide PNGs at original detail. Record every issue in `$QA_DIR/issues-pass-1.txt`, including at least one improvement opportunity even if there are no hard failures.

## Task 5: Complete Fresh-Eye Review, Fix, And Re-Verify

**Files:**

- Modify: `$TMP_DIR/build-deck.mjs`
- Create: `$QA_DIR/issues-pass-2.txt`
- Update: final PPTX and previews.

- [ ] **Step 1: Request independent visual QA**

Give fresh reviewers the full-size slide PNGs with the required checklist: overlap, clipping, title wrapping, insufficient margins, weak contrast, broken connectors, uneven gaps, unreadable screenshots, repetitive layouts, and unsupported claims. Split slides 1–8 and 9–16 so each reviewer has a bounded set.

Expected: each reviewer returns concrete slide-numbered issues; reviewers do not edit files.

- [ ] **Step 2: Fix all unintended problems**

Update `$TMP_DIR/build-deck.mjs` only. Shorten copy or change layout before reducing font size. Keep titles at least 35pt, body at least 16pt, and margins at least 0.5 inches / 48px. Fix every unintended overlap or connector collision.

- [ ] **Step 3: Re-export and re-run all checks**

Run the deck generator, slide-boundary checker, MarkItDown extraction, placeholder/sensitive-term scan, montage review, and full-size review again. Write the results to `$QA_DIR/issues-pass-2.txt`.

Expected: no new hard issues; any accepted visual overlap is explicitly justified in the QA ledger; the fix-and-verify cycle is complete.

## Task 6: Final Verification And Delivery

**Files:**

- Verify: `outputs/Duplicate_Search_Agent_Technical_Sharing.pptx`

- [ ] **Step 1: Verify the final artifact metadata**

Run:

```bash
test -s "$FINAL_PPTX"
unzip -l "$FINAL_PPTX" | rg 'ppt/slides/slide[0-9]+\.xml' | wc -l
unzip -l "$FINAL_PPTX" | rg 'ppt/notesSlides/notesSlide[0-9]+\.xml' | wc -l
```

Expected: the file is non-empty, there are 16 slide XML files, and speaker-note XML exists for all 16 slides.

- [ ] **Step 2: Verify only intended repository output was added**

Run:

```bash
git status --short -- outputs/Duplicate_Search_Agent_Technical_Sharing.pptx
```

Expected: only the final PPTX appears for this command; scratch files remain outside the repository.

- [ ] **Step 3: Deliver the deck**

Return one standalone Markdown link to `/Users/tonyorz/Data-Agent/outputs/Duplicate_Search_Agent_Technical_Sharing.pptx`, mention that it contains 16 slides and speaker notes, and state that the content is grounded in current repository implementation plus synthetic UI data. Do not expose scratch files or QA internals unless requested.
