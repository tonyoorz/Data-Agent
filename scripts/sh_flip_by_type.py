"""
Showstopper-Candidate flip breakdown by defect type (problem_category).

Reads scripts/sem_accuracy_detail.json (per-defect reconstruction from
sem_accuracy_analysis.py) and aggregates, for each problem_category and
each cohort (before / after the 2026-06-29 SEM takeover):

  - n            : matrix-tagged defects in that category/cohort
  - sh_init      : defects that were Showstopper Candidate at init time
                   (SEM set SH in Phase 01/02)
  - sh_added     : SH added after Phase 03 dev = SEM under-judged (漏判)
                   (init_sh False -> final_sh True)
  - sh_removed   : SH removed after Phase 03 dev = SEM over-judged (过判)
                   (init_sh True  -> final_sh False)
  - sh_flipped   : sh_added | sh_removed  (init_sh != final_sh)
  - flip_rate    : sh_flipped / n

Also prints, restricted to defects that SEM *did* tag as SH candidate in
Phase 01/02 (init_sh=True), how many got reversed (sh_removed) after Phase 03.

Run: .venv/Scripts/python.exe scripts/sh_flip_by_type.py
"""
from __future__ import annotations

import io
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

REPO = Path(__file__).resolve().parent.parent
DETAIL = REPO / "scripts" / "sem_accuracy_detail.json"

data = json.loads(DETAIL.read_text(encoding="utf-8"))
print(f"# loaded {len(data)} defect records from {DETAIL.name}\n")

# overall, to sanity-check against the report
def overall(rows):
    n = len(rows)
    added = sum(1 for r in rows if r["sh_added"])
    removed = sum(1 for r in rows if r["sh_removed"])
    flipped = sum(1 for r in rows if r["sh_changed"])
    init = sum(1 for r in rows if r["init_sh"])
    return n, init, added, removed, flipped

for label in ("before", "after"):
    rows = [r for r in data if r["group"] == label]
    n, init, added, removed, flipped = overall(rows)
    print(f"OVERALL [{label}] n={n}  sh_init={init}  sh_added(漏判)={added} ({added/n*100:.1f}%)  "
          f"sh_removed(过判)={removed}  sh_flipped={flipped} ({flipped/n*100:.1f}%)")
print()

# ---- per problem_category, both cohorts ----
cats = defaultdict(lambda: {"before": [], "after": []})
for r in data:
    cats[r["prob_cat"] or "(empty)"][r["group"]].append(r)

# rank categories by total n (before+after)
ranked = sorted(cats.items(), key=lambda kv: len(kv[1]["before"]) + len(kv[1]["after"]), reverse=True)

print("=" * 110)
print("SH-CANDIDATE FLIP BY problem_category  (all matrix-tagged defects)")
print("=" * 110)
hdr = f"{'problem_category':<34}{'grp':<8}{'n':>7}{'sh_init':>9}{'sh_add(漏判)':>13}{'sh_rm(过判)':>13}{'sh_flip':>9}{'flip%':>8}"
print(hdr)
print("-" * 110)
for cat, groups in ranked[:12]:
    for grp in ("before", "after"):
        rows = groups[grp]
        n = len(rows)
        if n == 0:
            continue
        init = sum(1 for r in rows if r["init_sh"])
        added = sum(1 for r in rows if r["sh_added"])
        removed = sum(1 for r in rows if r["sh_removed"])
        flipped = sum(1 for r in rows if r["sh_changed"])
        pct = flipped / n * 100
        print(f"{cat[:33]:<34}{grp:<8}{n:>7}{init:>9}{added:>13}{removed:>13}{flipped:>9}{pct:>7.1f}%")
    print()

# ---- restricted view: among defects SEM tagged SH in Phase 01/02, how many reversed after Phase 03 ----
print("=" * 110)
print("AMONG DEFECTS SEM TAGGED AS SHOWSTOPPER CANDIDATE IN PHASE 01/02 (init_sh=True)")
print("  -> how many got the SH REVERSED (removed) after Phase 03  (= 过判 reversal)")
print("=" * 110)
hdr2 = f"{'problem_category':<34}{'grp':<8}{'sh_init':>9}{'reversed':>10}{'rev%':>8}"
print(hdr2)
print("-" * 110)
for cat, groups in ranked[:12]:
    for grp in ("before", "after"):
        rows = [r for r in groups[grp] if r["init_sh"]]
        n = len(rows)
        if n == 0:
            continue
        rev = sum(1 for r in rows if r["sh_removed"])
        pct = rev / n * 100
        print(f"{cat[:33]:<34}{grp:<8}{n:>9}{rev:>10}{pct:>7.1f}%")
    print()
