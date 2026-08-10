#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pull verbatim human Q-Gate comments for over-judged (过判) speech defects.
Evidence extractor for the claim "SEM over-rates speech defect levels".

Reads:
  scripts/speech_analysis_intermediate.json  -> over_ids_after (53 BI-downgraded tickets)
  database/source/qgate_raw.db               -> octane_defect_comment_refresh_state.comments_json
Writes:
  scripts/speech_comment_evidence.json        -> per-ticket human comments + reconstruction context
  stdout: keyword tally + categorized evidence snippets
"""
from __future__ import annotations
import io, json, re, sqlite3, sys, html
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

REPO = Path(__file__).resolve().parent.parent
DB = REPO / "database" / "source" / "qgate_raw.db"

# keywords humans use when discussing the Matrix/occurrence/BI axes
KW = re.compile(
    r"matrix|q-gate|qgate|reproduc|occurrence|sporadic|single event|downgrade|"
    r"over.?rat|under.?rat|bi\s?\d|showstopper|shk|persistent|intermittent|not.?repro|"
    r"\bBI\b|severity|category|3c|3d|3e|2e|2d|conservative|relax|lower|raise", re.I)
SEM = re.compile(r"Smart_Error|AIgenerated|Powered by DE-6|#AIgenerated", re.I)
SEM_AUTHOR = re.compile(r"Smart_Error|SmartError", re.I)


def clean(t: str) -> str:
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def main():
    inter = json.load(open(REPO / "scripts" / "speech_analysis_intermediate.json", encoding="utf-8"))
    over_ids = inter["over_ids_after"]
    rec = {d["did"]: d for d in inter["speech"]}

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = con.cursor()
    qm = ",".join(["?"] * len(over_ids))
    cur.execute(
        f"SELECT defect_id, comments_json FROM octane_defect_comment_refresh_state WHERE defect_id IN ({qm})",
        over_ids,
    )
    rows = cur.fetchall()

    print(f"over-judge tickets: {len(over_ids)} | found in comment table: {len(rows)}")
    print(f"missing: {set(over_ids) - {r[0] for r in rows}}\n")

    author_counts = Counter()
    all_kw = Counter()
    out = []

    for did, cj in rows:
        try:
            cmts = json.loads(cj)
        except Exception:
            cmts = []
        if not isinstance(cmts, list):
            cmts = []
        r = rec.get(did, {})
        human = []
        for c in cmts:
            author = (c.get("author") or {}).get("full_name") or ""
            txt = clean(c.get("text", ""))
            if not txt:
                continue
            author_counts[author.split("(")[0].strip()] += 1
            is_sem = SEM_AUTHOR.search(author) or SEM.search(txt)
            # We want HUMAN reasoning. Keep SEM output only flagged, not as evidence.
            if is_sem:
                continue
            # keep human comments that touch the rating axes
            if not KW.search(txt):
                continue
            for m in set(KW.findall(txt.lower())):
                all_kw[m] += 1
            human.append({"author": author, "ts": c.get("creation_time", ""), "text": txt[:1200]})
        out.append({
            "did": did,
            "init_matrix": r.get("init_matrix"),
            "final_matrix": r.get("final_matrix"),
            "init_bi": r.get("init_bi_code"),
            "final_bi": r.get("final_bi_code"),
            "bi_dir": r.get("bi_dir"),
            "prob_cat": r.get("prob_cat"),
            "sol_cluster": r.get("sol_cluster"),
            "human_comments": human,
        })

    n_with = sum(1 for d in out if d["human_comments"])
    print(f"tickets with >=1 on-axis human comment: {n_with}/{len(out)}\n")

    print("=== keyword tally (human comments, over-judged tickets) ===")
    for k, n in all_kw.most_common(25):
        print(f"   {n:4d}  {k}")
    print("\n=== top comment authors ===")
    for a, n in author_counts.most_common(10):
        print(f"   {n:4d}  {a[:55]}")

    json.dump(out, open(REPO / "scripts" / "speech_comment_evidence.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("\nwrote scripts/speech_comment_evidence.json")

    # ---- print concrete evidence: tickets where humans explicitly cite the downgrade ----
    print("\n" + "=" * 90)
    print("CONCRETE EVIDENCE — human comments explicitly citing the rating correction")
    print("=" * 90)
    EXPLICIT = re.compile(r"BI should|change \d|downgrade|not (a )?showstopper|not SHK|not reproduc|"
                          r"single event|sporadic|occurrence|matrix.*\d[ABCDE]|should be BI|relax|conservative", re.I)
    shown = 0
    for d in sorted(out, key=lambda x: len(x["human_comments"]), reverse=True):
        for hc in d["human_comments"]:
            if EXPLICIT.search(hc["text"]):
                shown += 1
                print(f"\n[{d['did']}] {d['init_matrix']}→{d['final_matrix']}  BI {d['init_bi']}→{d['final_bi']}  "
                      f"({d['prob_cat']} / {d['sol_cluster']})")
                print(f"   — {hc['author'][:40]} ({hc['ts'][:10]}):")
                print(f"   “{hc['text'][:400]}”")
                if shown >= 22:
                    break
        if shown >= 22:
            break
    print(f"\n(showing {shown} explicit-evidence comments; full set in JSON)")


if __name__ == "__main__":
    main()
