"""
SEM (Smart Error Management) Accuracy Analysis  — corrected version
====================================================================

Evaluate the accuracy of SEM's *initial* defect judgment (set during Phase
01/02 pre-analysis) against the *final* value (after Phase 03 development
analysis), comparing two cohorts split by the SEM auto-takeover of QGate
(2026-06-29):

  - "Before takeover (manual)"   : first matrix tag set <  2026-06-29
  - "After takeover (automated)" : first matrix tag set >= 2026-06-29

IMPORTANT data-reconstruction note (data-driven correction)
-----------------------------------------------------------
History events for user_tags and assign_report_class_udf record ONLY adds
(old_value is always empty); removes are not captured as old->new pairs.
For the AFTER cohort, the current raw_json snapshot has NO user_tags at all
(0% populated) and reporting_class is mostly empty, so the current snapshot
cannot be used as the "final value". Therefore BOTH the initial and final
values are reconstructed from history events (one consistent source):

  - Matrix tag : initial = FIRST matrix add event; final = LAST matrix add event
                 -> changed iff first != last (SEM re-rated the matrix).
  - BI level   : problem_severity_udf single-value field.
                 initial = newest event with ts <= initial matrix time;
                 final   = newest event overall (== current raw_json, 100% populated).
  - Showstopper: reporting_class add events carry Showstopper_Candidate /
                 No_Showstopper_Candidate etc.
                 initial SH state derived from class adds up to init time;
                 final   SH state derived from class adds up to latest event.
                 changed iff the SH-candidate membership flipped.

Domain model (confirmed with stakeholder)
  - Matrix tag  : user_tags "Matrix-XY" = Category(1-4) x Occurrence(E-A)
                  (first digit = severity Category, NOT a phase)
  - Defect class: reporting_class_udf (Showstopper_Candidate/Confirmed/No_*/...)
  - BI level    : problem_severity_udf "NN-..." (01 worst .. 07 mildest)
  - Phase       : Octane phase 2-digit code (01-New, 02-In Pre-Analysis,
                  03-In Analysis ...). SEM tags in Phase 01/02; dev analysis in 03.

Sample definition note
  Stakeholder asked for "defects carrying an SEM tag" (IuK_AI_SmartErrorMan).
  That legacy tag is NOT applied after the 2026-06-29 takeover (0 in after
  cohort), so SEM processing is proxied by "defects that received a Matrix-*
  tag" (the artifact SEM produces in Phase 01/02). This keeps both cohorts
  non-empty and comparable.

Reproducible: reads database/source/qgate_raw.db only.
Run:  .venv/Scripts/python.exe scripts/sem_accuracy_analysis.py
"""

from __future__ import annotations

import io
import json
import math
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Force UTF-8 stdout so CJK + unicode print on Windows cp1252 consoles.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

# --------------------------------------------------------------------------- #
REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "database" / "source" / "qgate_raw.db"
TAKEOVER_BOUNDARY = "2026-06-29"  # SEM auto-takeover of QGate (inclusive on/after)
REPORT_JSON = REPO_ROOT / "scripts" / "sem_accuracy_detail.json"

WORD_NUM = re.compile(r"^\D*(\d{2})")


def two_digit_code(name: object) -> str | None:
    s = str(name or "").strip()
    if not s:
        return None
    m = WORD_NUM.match(s)
    return m.group(1) if m else None


# --------------------------------------------------------------------------- #
def build_maps(conn: sqlite3.Connection) -> dict:
    phase_l2n: dict[str, str] = {}
    phase_l2code: dict[str, str] = {}
    rc_l2n: dict[str, str] = {}
    ps_l2n: dict[str, str] = {}
    ps_l2bi: dict[str, str] = {}
    tag_id2n: dict[str, str] = {}
    n = 0
    for (raw,) in conn.execute("SELECT raw_json FROM octane_defects WHERE raw_json IS NOT NULL"):
        try:
            d = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(d, dict):
            continue
        n += 1
        ph = d.get("phase")
        if isinstance(ph, dict):
            ln = str(ph.get("logical_name") or ph.get("id") or "")
            nm = str(ph.get("name") or "")
            if ln and nm:
                phase_l2n[ln] = nm
                c = two_digit_code(nm)
                if c:
                    phase_l2code[ln] = c
        rc = d.get("reporting_class_udf")
        if isinstance(rc, dict) and isinstance(rc.get("data"), list):
            for x in rc["data"]:
                if isinstance(x, dict):
                    ln = str(x.get("logical_name") or x.get("id") or "")
                    nm = str(x.get("name") or "")
                    if ln and nm:
                        rc_l2n[ln] = nm
        ps = d.get("problem_severity_udf")
        if isinstance(ps, dict):
            ln = str(ps.get("logical_name") or ps.get("id") or "")
            nm = str(ps.get("name") or "")
            if ln and nm:
                ps_l2n[ln] = nm
                b = two_digit_code(nm)
                if b:
                    ps_l2bi[ln] = b
        ut = d.get("user_tags")
        if isinstance(ut, dict) and isinstance(ut.get("data"), list):
            for x in ut["data"]:
                if isinstance(x, dict):
                    tid = str(x.get("id") or "")
                    nm = str(x.get("name") or "")
                    if tid and nm:
                        tag_id2n[tid] = nm
    matrix_ids = {tid: nm for tid, nm in tag_id2n.items() if nm.startswith("Matrix-")}
    sem_ids = {tid: nm for tid, nm in tag_id2n.items() if "SmartErrorMan" in nm}
    return dict(defects_scanned=n, phase_l2n=phase_l2n, phase_l2code=phase_l2code,
                rc_l2n=rc_l2n, ps_l2n=ps_l2n, ps_l2bi=ps_l2bi,
                tag_id2n=tag_id2n, matrix_ids=matrix_ids, sem_ids=sem_ids)


def load_dimensions(conn: sqlite3.Connection) -> dict:
    """defect_id -> breakdown dimensions (problem_category, severity, solution_cluster, phase, created)."""
    out: dict[str, dict] = {}
    for (raw,) in conn.execute("SELECT raw_json FROM octane_defects WHERE raw_json IS NOT NULL"):
        try:
            d = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(d, dict):
            continue
        did = str(d.get("id") or "").strip()
        if not did:
            continue
        def nm(field):
            v = d.get(field)
            return str(v.get("name") or "").strip() if isinstance(v, dict) else ""
        ph = d.get("phase")
        ph_name = str(ph.get("name") or "").strip() if isinstance(ph, dict) else ""
        ps = d.get("problem_severity_udf")
        bi_name = str(ps.get("name") or "").strip() if isinstance(ps, dict) else ""
        out[did] = dict(
            prob_cat=nm("problem_category_udf"), severity=nm("severity"),
            sol_cluster=nm("solution_cluster_udf"), phase_name=ph_name,
            phase_code=two_digit_code(ph_name) or "",
            created=str(d.get("creation_time") or "").strip(),
            bi_name_final=bi_name, bi_code_final=two_digit_code(bi_name) or "",
        )
    return out


# --------------------------------------------------------------------------- #
def load_history(conn, maps):
    """Reconstruct initial & final values from history for matrix-tagged defects."""
    matrix_ids = maps["matrix_ids"]
    if not matrix_ids:
        return {}
    placeholders = ",".join("?" for _ in matrix_ids)
    keys = tuple(matrix_ids.keys())

    # 1) ALL matrix add events per defect (sorted by ts)
    matrix_events: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for did, ts, nv in conn.execute(
        f"SELECT defect_id, event_timestamp, new_value FROM octane_defect_history_events "
        f"WHERE field_name='user_tags' AND new_value IN ({placeholders})", keys):
        nm = matrix_ids.get(nv)
        if nm:
            matrix_events[did].append((ts or "", nm))

    dids = tuple(matrix_events.keys())
    if not dids:
        return {}

    # 2) phase events (to know reached phase03 + phase at init)
    phase_events: dict[str, list[tuple[str, str]]] = defaultdict(list)  # (ts, new_code)
    code = maps["phase_l2code"]
    # 3) BI (problem_severity) events
    ps_events: dict[str, list[tuple[str, str, str]]] = defaultdict(list)  # (ts, bi_code, name)
    ps_l2bi = maps["ps_l2bi"]
    ps_l2n = maps["ps_l2n"]
    # 4) reporting_class add events
    rc_events: dict[str, list[tuple[str, str]]] = defaultdict(list)  # (ts, name)
    rc_l2n = maps["rc_l2n"]

    for start in range(0, len(dids), 900):
        batch = dids[start:start + 900]
        ph_place = ",".join("?" for _ in batch)
        for did, ts, newv in conn.execute(
            f"SELECT defect_id, event_timestamp, new_value FROM octane_defect_history_events "
            f"WHERE field_name='phase' AND new_value IS NOT NULL AND new_value!='' "
            f"AND defect_id IN ({ph_place})", batch):
            c = code.get(newv)
            if c:
                phase_events[did].append((ts or "", c))
        for did, ts, newv in conn.execute(
            f"SELECT defect_id, event_timestamp, new_value FROM octane_defect_history_events "
            f"WHERE field_name='problem_severity_udf' AND new_value IS NOT NULL AND new_value!='' "
            f"AND defect_id IN ({ph_place})", batch):
            ps_events[did].append((ts or "", ps_l2bi.get(newv) or "", ps_l2n.get(newv) or ""))
        for did, ts, newv in conn.execute(
            f"SELECT defect_id, event_timestamp, new_value FROM octane_defect_history_events "
            f"WHERE field_name IN ('assign_report_class_udf','reporting_class_udf') "
            f"AND new_value IS NOT NULL AND new_value!='' AND defect_id IN ({ph_place})", batch):
            nm = rc_l2n.get(newv) or ""
            if nm:
                rc_events[did].append((ts or "", nm))

    out: dict[str, dict] = {}
    for did, mlist in matrix_events.items():
        mlist.sort()
        init_ts, init_matrix = mlist[0]
        final_matrix = mlist[-1][1] if mlist else init_matrix
        matrix_changed = init_matrix != final_matrix if len(mlist) > 1 else False
        reached_03 = any(c >= "03" for _, c in phase_events.get(did, []))

        # initial phase at init time
        init_phase_code = ""
        for ts, c in phase_events.get(did, []):
            if ts <= init_ts:
                init_phase_code = c or init_phase_code

        # BI initial = newest ps event with ts<=init_ts; final = newest ps event overall
        init_bi_code = ""
        init_bi_name = ""
        for ts, bic, bnm in ps_events.get(did, []):
            if ts <= init_ts:
                init_bi_code = bic or init_bi_code
                init_bi_name = bnm or init_bi_name
        final_bi_code = ""
        final_bi_name = ""
        for ts, bic, bnm in ps_events.get(did, []):
            final_bi_code = bic or final_bi_code
            final_bi_name = bnm or final_bi_name
        bi_changed = bool(init_bi_code and final_bi_code and init_bi_code != final_bi_code)

        # SH-candidate state: derived from reporting_class adds.
        # An SH-candidate is "present" if any Showstopper_Candidate/Confirmed was added
        # and not yet contradicted by a No_Showstopper_* at that point.
        SH_POS = ("showstopper_candidate", "showstopper_confirmed")
        SH_NEG = ("no_showstopper_candidate", "no_showstopper_confirmed", "no_showstopper")
        def sh_state_at(cutoff):
            pos = False
            for ts, nm in rc_events.get(did, []):
                if ts > cutoff:
                    break
                low = nm.casefold()
                if any(t in low for t in SH_POS):
                    pos = True
                elif any(t in low for t in SH_NEG):
                    pos = False
            return pos
        init_sh = sh_state_at(init_ts)
        # final SH: apply all events up to last
        final_sh = sh_state_at("9999")
        sh_added = (not init_sh) and final_sh      # SEM missed -> became SH (under-judge)
        sh_removed = init_sh and (not final_sh)     # SEM over-set -> removed (over-judge)
        sh_changed = init_sh != final_sh

        # full class set changed (set of all class names added up to init vs up to final)
        def set_at(cutoff):
            s = set()
            for ts, nm in rc_events.get(did, []):
                if ts > cutoff:
                    break
                s.add(nm)
            return s
        init_rc = set_at(init_ts)
        final_rc = set_at("9999")
        rc_changed = init_rc != final_rc

        any_changed = matrix_changed or bi_changed or rc_changed

        # BI direction (smaller = more severe)
        bi_dir = ""
        if bi_changed:
            try:
                fi = int(final_bi_code); ii = int(init_bi_code)
                bi_dir = "upgraded(under-judge/漏判)" if fi < ii else "downgraded(over-judge/过判)"
            except ValueError:
                bi_dir = "changed"

        out[did] = dict(
            did=did, init_ts=init_ts,
            init_matrix=init_matrix, final_matrix=final_matrix, matrix_changed=matrix_changed,
            init_bi_code=init_bi_code, init_bi_name=init_bi_name,
            final_bi_code=final_bi_code, final_bi_name=final_bi_name,
            bi_changed=bi_changed, bi_dir=bi_dir,
            init_rc=init_rc, final_rc=final_rc, rc_changed=rc_changed,
            init_sh=init_sh, final_sh=final_sh, sh_changed=sh_changed,
            sh_added=sh_added, sh_removed=sh_removed,
            reached_phase03=reached_03, init_phase_code=init_phase_code,
            any_changed=any_changed,
        )
    return out


# --------------------------------------------------------------------------- #
def two_prop_z_test(x1, n1, x2, n2):
    if n1 == 0 or n2 == 0:
        return None, None
    p1 = x1 / n1
    p2 = x2 / n2
    ppool = (x1 + x2) / (n1 + n2)
    se = math.sqrt(ppool * (1 - ppool) * (1 / n1 + 1 / n2))
    if se == 0:
        return None, None
    z = (p1 - p2) / se
    p = math.erfc(abs(z) / math.sqrt(2))
    return z, p


def fmt_pct(x, n):
    return f"{x}/{n} ({x / n * 100:.1f}%)" if n else "0/0 (-)"


def print_table(title, header, rows):
    print("=" * 88)
    print(title)
    print("=" * 88)
    print(header)
    for r in rows:
        print(r)
    print()


# --------------------------------------------------------------------------- #
def main():
    print(f"# SEM Accuracy Analysis  | DB: {DB_PATH}")
    print(f"# Takeover boundary: on/after {TAKEOVER_BOUNDARY}")
    print(f"# Accuracy = initial SEM judgment (Phase 01/02) UNCHANGED after Phase 03 dev analysis\n")

    conn = sqlite3.connect(DB_PATH)
    print("Building maps ...")
    maps = build_maps(conn)
    print(f"  defects scanned: {maps['defects_scanned']}  matrix tags: {len(maps['matrix_ids'])}  "
          f"sem tags: {len(maps['sem_ids'])}  phase codes: {len(maps['phase_l2code'])}")
    print("Loading dimensions ...")
    dims = load_dimensions(conn)
    print("Reconstructing initial & final values from history ...\n")
    recs = load_history(conn, maps)
    conn.close()

    # attach dimensions
    for did, r in recs.items():
        dm = dims.get(did, {})
        for k in ("prob_cat", "severity", "sol_cluster", "phase_code", "phase_name", "created"):
            r[k] = dm.get(k, "")
        group = "after" if r["init_ts"] >= TAKEOVER_BOUNDARY else "before"
        r["group"] = group

    before = [r for r in recs.values() if r["group"] == "before"]
    after = [r for r in recs.values() if r["group"] == "after"]

    # ---- 1) sample split ----
    print_table(
        "1) SAMPLE SPLIT  (group by first matrix-tag add = SEM initial judgment time)",
        f"  {'Cohort':<28}{'n':>7}{'span_start':>14}{'span_end':>14}{'reached_03':>12}",
        [
            f"  {'Before takeover (manual)':<28}{len(before):>7}{(min((r['init_ts'] for r in before), default=''))[:10]:>14}{(max((r['init_ts'] for r in before), default=''))[:10]:>14}{sum(1 for r in before if r['reached_phase03']):>7}/{len(before)}",
            f"  {'After takeover (automated)':<28}{len(after):>7}{(min((r['init_ts'] for r in after), default=''))[:10]:>14}{(max((r['init_ts'] for r in after), default=''))[:10]:>14}{sum(1 for r in after if r['reached_phase03']):>7}/{len(after)}",
        ],
    )

    # ---- 2) overall accuracy ----
    bu = sum(1 for r in before if not r["any_changed"])
    bc = len(before) - bu
    au = sum(1 for r in after if not r["any_changed"])
    ac = len(after) - au
    z, p = two_prop_z_test(ac, len(after), bc, len(before))  # change-rate after vs before
    print_table(
        "2) OVERALL ACCURACY  (unchanged = accurate; changed = inaccurate)",
        f"  {'Metric':<34}{'Before(manual)':>20}{'After(auto)':>20}",
        [
            f"  {'Unchanged (accurate)':<34}{fmt_pct(bu, len(before)):>20}{fmt_pct(au, len(after)):>20}",
            f"  {'Changed (inaccurate)':<34}{fmt_pct(bc, len(before)):>20}{fmt_pct(ac, len(after)):>20}",
            f"  {'Accuracy rate':<34}{bu / len(before) * 100 if before else 0:>19.1f}%{au / len(after) * 100 if after else 0:>19.1f}%",
            f"  {'Change rate':<34}{bc / len(before) * 100 if before else 0:>19.1f}%{ac / len(after) * 100 if after else 0:>19.1f}%",
        ],
    )
    if z is not None:
        sig = "SIGNIFICANT (p<0.05)" if p < 0.05 else "not significant (p>=0.05)"
        print(f"  change-rate After vs Before: z={z:.2f}, p={p:.4g}  -> {sig}\n")

    # ---- 3) per-field change rates ----
    print_table(
        "3) PER-FIELD CHANGE RATES",
        f"  {'Field':<34}{'Before':>20}{'After':>20}",
        [
            f"  {'Matrix tag changed (re-rated)':<34}{fmt_pct(sum(1 for r in before if r['matrix_changed']), len(before)):>20}{fmt_pct(sum(1 for r in after if r['matrix_changed']), len(after)):>20}",
            f"  {'BI level changed':<34}{fmt_pct(sum(1 for r in before if r['bi_changed']), len(before)):>20}{fmt_pct(sum(1 for r in after if r['bi_changed']), len(after)):>20}",
            f"  {'Classification set changed':<34}{fmt_pct(sum(1 for r in before if r['rc_changed']), len(before)):>20}{fmt_pct(sum(1 for r in after if r['rc_changed']), len(after)):>20}",
            f"  {'SH-Candidate flipped':<34}{fmt_pct(sum(1 for r in before if r['sh_changed']), len(before)):>20}{fmt_pct(sum(1 for r in after if r['sh_changed']), len(after)):>20}",
        ],
    )

    # ---- 4) BI misjudgment direction ----
    print_table(
        "4) BI LEVEL MISJUDGMENT DIRECTION  (smaller BI = more severe)",
        f"  {'Direction':<46}{'Before':>14}{'After':>14}",
        [
            f"  {'upgraded (final<init) = under-judge / 漏判':<46}{sum(1 for r in before if r['bi_dir'].startswith('upgraded')):>14}{sum(1 for r in after if r['bi_dir'].startswith('upgraded')):>14}",
            f"  {'downgraded (final>init) = over-judge / 过判':<46}{sum(1 for r in before if r['bi_dir'].startswith('downgraded')):>14}{sum(1 for r in after if r['bi_dir'].startswith('downgraded')):>14}",
        ],
    )
    print("  BI shift magnitude (|final-init|) distribution:")
    for name, rs in (("Before", before), ("After", after)):
        deltas = Counter()
        for r in rs:
            if r["bi_changed"]:
                try:
                    deltas[abs(int(r["final_bi_code"]) - int(r["init_bi_code"]))] += 1
                except ValueError:
                    deltas[0] += 1
        parts = " ".join(f"{k}b:{v}" for k, v in sorted(deltas.items()))
        print(f"    {name:<8} {parts or '(none)'}")
    print()

    # ---- 5) SH candidate flips ----
    print_table(
        "5) SHOWSTOPPER CANDIDATE FLIPS",
        f"  {'Flip':<50}{'Before':>12}{'After':>12}",
        [
            f"  {'SH added after dev (SEM under-judged / 漏判)':<50}{sum(1 for r in before if r['sh_added']):>12}{sum(1 for r in after if r['sh_added']):>12}",
            f"  {'SH removed after dev (SEM over-judged / 过判)':<50}{sum(1 for r in before if r['sh_removed']):>12}{sum(1 for r in after if r['sh_removed']):>12}",
        ],
    )

    # ---- 6) breakdowns ----
    print("=" * 88)
    print("6) BREAKDOWNS BY DEFECT TYPE / SEVERITY / MATRIX CATEGORY")
    print("=" * 88)

    def breakdown(dim_key, title, topk=8):
        print(f"\n  --- {title} ---")
        cats = Counter(r[dim_key] for r in recs.values())
        top = [c for c, _ in cats.most_common(topk)]
        print(f"  {str(dim_key)[:30]:<32}{'n_bef':>7}{'acc%bef':>9}{'n_aft':>7}{'acc%aft':>9}")
        for c in top:
            b = [r for r in before if r[dim_key] == c]
            a = [r for r in after if r[dim_key] == c]
            ba = sum(1 for r in b if not r["any_changed"])
            aa = sum(1 for r in a if not r["any_changed"])
            label = str(c)[:30] if c else "(empty)"
            print(f"  {label:<32}{len(b):>7}{(ba / len(b) * 100 if b else 0):>8.1f}%{len(a):>7}{(aa / len(a) * 100 if a else 0):>8.1f}%")

    breakdown("prob_cat", "By problem_category (top 8)")
    breakdown("severity", "By severity")
    breakdown("sol_cluster", "By solution_cluster (top 8)")

    # by matrix category (first digit of "Matrix-Nx")
    def mcat(r):
        m = r["init_matrix"]
        # "Matrix-1A" -> category '1'
        idx = m.find("-")
        c = m[idx + 1] if idx >= 0 and idx + 1 < len(m) and m[idx + 1].isdigit() else "?"
        return c
    # occurrence (letter)
    def mocc(r):
        m = r["init_matrix"]
        idx = m.find("-")
        c = m[idx + 2] if idx >= 0 and idx + 2 < len(m) else "?"
        return c
    print("\n  --- By Matrix Category (first digit = severity Category 1-4) ---")
    print(f"  {'MatrixCat':<32}{'n_bef':>7}{'acc%bef':>9}{'n_aft':>7}{'acc%aft':>9}")
    for c in sorted(set(mcat(r) for r in recs.values())):
        b = [r for r in before if mcat(r) == c]
        a = [r for r in after if mcat(r) == c]
        ba = sum(1 for r in b if not r["any_changed"])
        aa = sum(1 for r in a if not r["any_changed"])
        print(f"  Cat {c:<28}{len(b):>7}{(ba / len(b) * 100 if b else 0):>8.1f}%{len(a):>7}{(aa / len(a) * 100 if a else 0):>8.1f}%")
    print()

    print("\n  --- By Matrix Occurrence (letter E-A) ---")
    print(f"  {'MatrixOcc':<32}{'n_bef':>7}{'acc%bef':>9}{'n_aft':>7}{'acc%aft':>9}")
    for c in sorted(set(mocc(r) for r in recs.values())):
        b = [r for r in before if mocc(r) == c]
        a = [r for r in after if mocc(r) == c]
        ba = sum(1 for r in b if not r["any_changed"])
        aa = sum(1 for r in a if not r["any_changed"])
        print(f"  Occ {c:<28}{len(b):>7}{(ba / len(b) * 100 if b else 0):>8.1f}%{len(a):>7}{(aa / len(a) * 100 if a else 0):>8.1f}%")
    print()

    # ---- dump detail ----
    detail = [
        {k: (sorted(v) if isinstance(v, set) else v) for k, v in r.items()}
        for r in recs.values()
    ]
    # also enrich with dimensions already present
    REPORT_JSON.write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  per-defect detail -> {REPORT_JSON}  ({len(detail)} rows)")


if __name__ == "__main__":
    main()
