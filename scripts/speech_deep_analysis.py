"""
SEM accuracy deep-dive for SPEECH-related defects.
Verifies the claim 'SEM over-rates speech defect levels' and mines comment feedback.
Reads scripts/sem_accuracy_detail.json (from sem_accuracy_analysis.py) + qgate_raw.db.
"""
from __future__ import annotations
import io, json, re, sqlite3, sys
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "database" / "source" / "qgate_raw.db"
TAKEOVER = "2026-06-29"

SPEECH_CAT_RE = re.compile(r"speech|voice|nlp|asr|tts|语音", re.I)
SPEECH_SC_RE = re.compile(r"speech|ipa|voice", re.I)  # solution_cluster

def is_speech(prob_cat, sol_cluster):
    if SPEECH_CAT_RE.search(str(prob_cat or "")):
        return True
    if SPEECH_SC_RE.search(str(sol_cluster or "")):
        return True
    return False

def main():
    detail = json.load(open(REPO_ROOT / "scripts" / "sem_accuracy_detail.json", encoding="utf-8"))
    # speech subset
    speech = [d for d in detail if is_speech(d.get("prob_cat"), d.get("sol_cluster"))]
    print(f"# SPEECH deep-dive  | total matrix-tagged defects: {len(detail)} | speech-related: {len(speech)}\n")

    # breakdown of which categories
    cat = Counter(d.get("prob_cat","") for d in speech)
    sc = Counter(d.get("sol_cluster","") for d in speech)
    print("speech defect problem_category distribution:")
    for k,v in cat.most_common(12): print(f"   {v:5d}  {k}")
    print("\nspeech defect solution_cluster distribution:")
    for k,v in sc.most_common(12): print(f"   {v:5d}  {k}")

    before = [d for d in speech if d["group"]=="before"]
    after = [d for d in speech if d["group"]=="after"]
    print(f"\nspeech sample: before={len(before)}  after={len(after)}")

    # ---- accuracy & direction ----
    print("\n" + "="*80)
    print("SEM ACCURACY ON SPEECH DEFECTS")
    print("="*80)
    def stats(rs, label):
        n=len(rs)
        if not n:
            print(f"  {label}: n=0"); return
        chg=sum(1 for d in rs if d["any_changed"])
        mchg=sum(1 for d in rs if d["matrix_changed"])
        bichg=sum(1 for d in rs if d["bi_changed"])
        shchg=sum(1 for d in rs if d["sh_changed"])
        sh_add=sum(1 for d in rs if d["sh_added"])   # under-judge
        sh_rem=sum(1 for d in rs if d["sh_removed"])  # over-judge
        bi_up=sum(1 for d in rs if d["bi_dir"].startswith("upgraded"))   # under-judge
        bi_dn=sum(1 for d in rs if d["bi_dir"].startswith("downgraded")) # over-judge
        print(f"  {label} (n={n}):")
        print(f"     change rate       {chg}/{n} = {chg/n*100:.1f}%   (acc={100-chg/n*100:.1f}%)")
        print(f"     matrix re-rated    {mchg/n*100:.1f}%")
        print(f"     BI changed         {bichg/n*100:.1f}%")
        print(f"     SH flipped         {shchg/n*100:.1f}%")
        print(f"     --- misjudgment direction ---")
        print(f"     BI upgraded (under-judge/漏判)  {bi_up}")
        print(f"     BI downgraded (over-judge/过判) {bi_dn}")
        print(f"     SH added (under-judge)   {sh_add}")
        print(f"     SH removed (over-judge)  {sh_rem}")
        # net over vs under (BI direction)
        return dict(n=n,chg=chg,bi_up=bi_up,bi_dn=bi_dn,sh_add=sh_add,sh_rem=sh_rem)
    sb=stats(before,"BEFORE takeover (manual)")
    sa=stats(after,"AFTER takeover (SEM auto)")

    # ---- matrix category distribution + re-rate pattern ----
    print("\n" + "="*80)
    print("MATRIX CATEGORY/OCCURRENCE ON SPEECH (after cohort = SEM auto)")
    print("="*80)
    def mcat(d):
        m=d["init_matrix"]; i=m.find("-")
        return m[i+1] if i>=0 and i+1<len(m) and m[i+1].isdigit() else "?"
    def mocc(d):
        m=d["init_matrix"]; i=m.find("-")
        return m[i+2] if i>=0 and i+2<len(m) else "?"
    for label, rs in (("before",before),("after",after)):
        print(f"\n  {label}: init matrix category x occurrence")
        grid=defaultdict(Counter)
        for d in rs:
            grid[mcat(d)][mocc(d)]+=1
        print("     "+"  ".join(f"{o:>5}" for o in "EDCBA"))
        for c in "1234":
            row=grid.get(c,Counter())
            print(f"  {c}  "+"  ".join(f"{row.get(o,0):>5}" for o in "EDCBA"))
    # over-judge pattern: which init matrix gets downgraded (over-judge)
    print("\n  over-judge (BI downgraded) by init matrix category (after cohort):")
    oc=Counter(mcat(d) for d in after if d["bi_dir"].startswith("downgraded"))
    for c in "1234": print(f"     Cat {c}: {oc.get(c,0)}")
    print("\n  over-judge (BI downgraded) by init matrix occurrence (after cohort):")
    oc2=Counter(mocc(d) for d in after if d["bi_dir"].startswith("downgraded"))
    for o in "EDCBA": print(f"     Occ {o}: {oc2.get(o,0)}")

    # ---- BI downgrade magnitude (speech, after) ----
    print("\n  BI downgrade magnitude (over-judge, speech, after):")
    mag=Counter()
    for d in after:
        if d["bi_dir"].startswith("downgraded"):
            try: mag[int(d["final_bi_code"])-int(d["init_bi_code"])]+=1
            except: pass
    for k,v in sorted(mag.items()): print(f"     +{k} BI levels: {v}")

    # ---- save speech defect ids for comment mining ----
    sp_ids=set(d["did"] for d in speech)
    over_ids=[d["did"] for d in after if d["bi_dir"].startswith("downgraded")]
    under_ids=[d["did"] for d in after if d["bi_dir"].startswith("upgraded")]
    json.dump({"speech_ids":list(sp_ids),"over_ids_after":over_ids,"under_ids_after":under_ids,
               "speech":speech},
              open(REPO_ROOT/"scripts"/"speech_analysis_intermediate.json","w",encoding="utf-8"),
              ensure_ascii=False,indent=2)
    print(f"\n  intermediate -> scripts/speech_analysis_intermediate.json")
    print(f"  over-judge(after) ids: {len(over_ids)}  under-judge(after) ids: {len(under_ids)}")

if __name__=="__main__":
    main()
