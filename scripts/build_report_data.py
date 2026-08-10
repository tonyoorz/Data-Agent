"""Aggregate all analysis data into one JSON for the HTML report."""
from __future__ import annotations
import io, json, re, sqlite3, sys
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
REPO = Path(__file__).resolve().parent.parent
DB = REPO / "database" / "source" / "qgate_raw.db"
TAKEOVER = "2026-06-29"

detail = json.load(open(REPO/"scripts"/"sem_accuracy_detail.json", encoding="utf-8"))
speech_data = json.load(open(REPO/"scripts"/"speech_analysis_intermediate.json", encoding="utf-8"))
speech = {d["did"]: d for d in speech_data["speech"]}

conn = sqlite3.connect(DB)
def comments(did):
    r = conn.execute("SELECT comments_json FROM octane_defect_comment_refresh_state WHERE defect_id=?", (did,)).fetchone()
    if not r or not r[0]: return []
    try: return json.loads(r[0])
    except: return []
def clean(t): return re.sub(r"<[^>]+>", " ", str(t or "")).replace("&nbsp;", " ").replace("&amp;","&").replace("&gt;",">").replace("&lt;","<").strip()
def defect_meta(did):
    r = conn.execute("SELECT raw_json FROM octane_defects WHERE defect_id=?", (did,)).fetchone()
    if not r: return {}
    try: d = json.loads(r[0])
    except: return {}
    def nm(f):
        v=d.get(f); return str(v.get("name","")) if isinstance(v,dict) else ""
    return dict(name=d.get("name",""), team=d.get("team","") or nm("problem_finder_team_udf"),
                prob_cat=nm("problem_category_udf"), sev=nm("severity"), sol_cluster=nm("solution_cluster_udf"),
                created=str(d.get("creation_time",""))[:10], phase=nm("phase"),
                software=nm("software_version_udf") or (d.get("software_version_udf") if isinstance(d.get("software_version_udf"),str) else ""))

out = {}

# ---- overall ----
def cohort_stats(rs):
    n=len(rs)
    chg=sum(1 for d in rs if d["any_changed"])
    def rate(k): return round(sum(1 for d in rs if d[k])/n*100,1) if n else 0
    return dict(n=n, change_rate=round(chg/n*100,1), accuracy=round(100-chg/n*100,1),
                matrix_re=rate("matrix_changed"), bi_change=rate("bi_changed"), rc_change=rate("rc_changed"),
                sh_flip=rate("sh_changed"),
                bi_under=sum(1 for d in rs if d["bi_dir"].startswith("upgraded")),
                bi_over=sum(1 for d in rs if d["bi_dir"].startswith("downgraded")),
                sh_under=sum(1 for d in rs if d["sh_added"]), sh_over=sum(1 for d in rs if d["sh_removed"]))
before=[d for d in detail if d["group"]=="before"]
after=[d for d in detail if d["group"]=="after"]
out["overall"]=dict(before=cohort_stats(before), after=cohort_stats(after),
                    total=len(detail), takeover=TAKEOVER)

# ---- breakdowns ----
def breakdown(key, topk=8):
    cats=Counter(d[key] for d in detail)
    res=[]
    for c,_ in cats.most_common(topk):
        b=[d for d in before if d[key]==c]; a=[d for d in after if d[key]==c]
        res.append(dict(cat=c or "(empty)", b=cohort_stats(b), a=cohort_stats(a)))
    return res
out["breakdowns"]=dict(prob_cat=breakdown("prob_cat"), severity=breakdown("severity"), sol_cluster=breakdown("sol_cluster"))

# matrix category breakdown
def mcat(d):
    m=d["init_matrix"]; i=m.find("-")
    return m[i+1] if i>=0 and i+1<len(m) and m[i+1].isdigit() else "?"
def mocc(d):
    m=d["init_matrix"]; i=m.find("-")
    return m[i+2] if i>=0 and i+2<len(m) else "?"
mc=[]
for c in "1234":
    b=[d for d in before if mcat(d)==c]; a=[d for d in after if mcat(d)==c]
    mc.append(dict(cat=c,b=cohort_stats(b),a=cohort_stats(a)))
out["matrix_cat"]=mc

# ---- speech ----
sp_before=[d for d in speech.values() if d["group"]=="before"]
sp_after=[d for d in speech.values() if d["group"]=="after"]
out["speech"]=dict(before=cohort_stats(sp_before), after=cohort_stats(sp_after),
                   total=len(speech))
# speech over-judge matrix grid (after)
def grid(rs):
    g=defaultdict(Counter)
    for d in rs:
        g[mcat(d)][mocc(d)]+=1
    return [{"cat":c,"vals":[{"occ":o,"n":g[c].get(o,0)} for o in "EDCBA"]} for c in "1234"]
out["speech"]["grid_after"]=grid(sp_after)
out["speech"]["grid_before"]=grid(sp_before)
# speech over-judge by cat/occ
out["speech"]["over_by_cat"]={c:sum(1 for d in sp_after if d["bi_dir"].startswith("downgraded") and mcat(d)==c) for c in "1234"}
out["speech"]["over_by_occ"]={o:sum(1 for d in sp_after if d["bi_dir"].startswith("downgraded") and mocc(d)==o) for o in "EDCBA"}
# speech over-judge matrix-change pattern
mc=Counter()
for d in sp_after:
    if d["bi_dir"].startswith("downgraded"):
        if d["init_matrix"]==d["final_matrix"]: mc["matrix unchanged (BI mapping over-strict)"]+=1
        elif d["final_matrix"]: mc["matrix re-rated"]+=1
        else: mc["matrix removed"]+=1
out["speech"]["over_pattern"]=dict(mc)

# ---- 02->01 ----
fb_before_ids=set(r[0] for r in conn.execute("SELECT DISTINCT defect_id FROM octane_defect_history_events WHERE field_name='phase' AND old_value_text='02-In Pre-Analysis' AND new_value_text='01-New' AND event_timestamp<'2026-06-29'"))
fb_after_ids=set(r[0] for r in conn.execute("SELECT DISTINCT defect_id FROM octane_defect_history_events WHERE field_name='phase' AND old_value_text='02-In Pre-Analysis' AND new_value_text='01-New' AND event_timestamp>='2026-06-29'"))
mc_month=Counter()
for (ts,) in conn.execute("SELECT event_timestamp FROM octane_defect_history_events WHERE field_name='phase' AND old_value_text='02-In Pre-Analysis' AND new_value_text='01-New' AND event_timestamp>='2025-01-01'"):
    mc_month[ts[:7]]+=1
# accuracy of fallback tickets in matrix sample
def fb_acc(ids):
    rs=[detail_dict[did] for did in ids if did in detail_dict]
    if not rs: return None
    return dict(n=len(rs), change_rate=round(sum(1 for d in rs if d["any_changed"])/len(rs)*100,1),
                bi_under=sum(1 for d in rs if d["bi_dir"].startswith("upgraded")),
                bi_over=sum(1 for d in rs if d["bi_dir"].startswith("downgraded")))
detail_dict={d["did"]:d for d in detail}
out["fallback"]=dict(
    monthly=[{"m":m,"n":mc_month[m]} for m in sorted(mc_month)],
    before_count=len(fb_before_ids), after_count=len(fb_after_ids),
    before_acc=fb_acc(fb_before_ids), after_acc=fb_acc(fb_after_ids))

# ---- key example tickets (with full analysis + comments) ----
def ticket_card(did, tag):
    d=detail_dict.get(did)
    if not d: return None
    dm=defect_meta(did)
    cs=comments(did)
    # pick most relevant comments (matrix/sh/bi/reproduc discussion)
    RE_KW=re.compile(r"matrix|showstopper|occurrence|sporadic|reproduc|single event|not.*reproduc|bi-|downgrade|should not|shouldn|q-gate|category|customer|safety|core feature|main feature|tolerat|relevant", re.I)
    relevant=[]
    for c in cs:
        t=clean(c.get("text",""))
        if len(t)<15 or len(t)>900: continue
        au=c.get("author",{}).get("full_name","?")
        is_sem="Smart_Error" in au
        relevant.append(dict(text=t[:700], author=au, ts=str(c.get("creation_time",""))[:10], is_sem=is_sem, kw=bool(RE_KW.search(t))))
    # prioritize SEM comments + keyword comments
    relevant.sort(key=lambda x:(not x["is_sem"], not x["kw"]))
    return dict(did=did, tag=tag, name=dm.get("name","")[:120], team=dm.get("team",""),
                prob_cat=dm.get("prob_cat",""), severity=dm.get("sev",""), sol_cluster=dm.get("sol_cluster",""),
                created=dm.get("created",""), phase=dm.get("phase",""),
                init_matrix=d["init_matrix"], final_matrix=d["final_matrix"],
                init_bi=d["init_bi_code"], final_bi=d["final_bi_code"],
                init_bi_name=d.get("init_bi_name",""), final_bi_name=d.get("final_bi_name",""),
                init_rc=sorted(d["init_rc"]), final_rc=sorted(d["final_rc"]),
                init_sh=d["init_sh"], final_sh=d["final_sh"],
                bi_dir=d["bi_dir"], any_changed=d["any_changed"], group=d["group"],
                sh_added=d["sh_added"], sh_removed=d["sh_removed"], reached_03=d["reached_phase03"],
                comments=relevant[:6], n_comments=len(cs))

# select key examples across categories
examples=[]
# speech over-judge (after) - the headline finding
for did in [d["did"] for d in sp_after if d["bi_dir"].startswith("downgraded")][:4]:
    examples.append(ticket_card(did,"speech-overjudge"))
# speech under-judge (after)
for did in [d["did"] for d in sp_after if d["bi_dir"].startswith("upgraded")][:2]:
    examples.append(ticket_card(did,"speech-underjudge"))
# overall SH under-judge (before) representative
for did in [d["did"] for d in before if d["sh_added"]][:2]:
    examples.append(ticket_card(did,"SH-underjudge-before"))
# 02->01 fallback ticket
fb_in_sample=[d for d in after if d["did"] in fb_after_ids]
for did in [d["did"] for d in fb_in_sample[:2]]:
    examples.append(ticket_card(did,"02-01-fallback-after"))
out["examples"]=[e for e in examples if e]

# ---- sample SEM raw comment (output format reference) ----
sem_sample=None
for d in sp_after:
    for c in comments(d["did"]):
        au=str(c.get("author",{}).get("full_name",""))
        if "Smart_Error" in au:
            t=clean(c.get("text",""))
            if "Matrix" in t and len(t)>150:
                sem_sample=dict(did=d["did"], text=t[:1000]); break
    if sem_sample: break
out["sem_sample"]=sem_sample

# ---- comment keyword stats (sh under-judge) ----
KW=["matrix","q-gate","reproduc","occurrence","sporadic","customer","should be","wrong","severity","showstopper","category","safety","core feature","main feature","relevant","not relevant","tolerated","manual","disagree","upgrade","downgrade","single event","not reproducible"]
def kw_scan(ids, nmax=8000):
    c=Counter(); have=0
    for did in ids[:nmax]:
        cs=comments(did)
        if not cs: continue
        have+=1
        blob=" ".join(clean(x.get("text","")) for x in cs).casefold()
        for k in KW:
            if k in blob: c[k]+=1
    return dict(total=len(ids), with_comments=have, top=[{"k":k,"n":v} for k,v in c.most_common(22)])
sh_under_ids=[d["did"] for d in detail if d["sh_added"]]
over_ids_all=[d["did"] for d in detail if d["bi_dir"].startswith("downgraded")]
out["comment_kw"]=dict(sh_under=kw_scan(sh_under_ids), over=kw_scan(over_ids_all),
                      speech_over=kw_scan(speech_data["over_ids_after"]))

json.dump(out, open(REPO/"scripts"/"report_data.json","w",encoding="utf-8"), ensure_ascii=False, separators=(",",":"))
print("report_data.json written. examples:",len(out["examples"]))
conn.close()
