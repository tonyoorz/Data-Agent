"""
Build a self-contained, defect-type-filterable HTML dashboard from the SEM
accuracy analysis results.

Reads the already-computed per-ticket results in `scripts/sem_accuracy_detail.json`
(produced by `sem_accuracy_analysis.py` — does NOT touch the 15 GB source DB)
and emits `scripts/sem_accuracy_dashboard.html`:

  - KPI cards + charts that ALL recompute client-side when you pick a defect
    type (problem_category) from the filter dropdown.
  - Reuses the Vizion Lab report's validated palette + light/dark theme.
  - Self-contained (one HTML file; only ECharts is loaded from a CDN).

Run:  .venv/Scripts/python.exe scripts/build_accuracy_dashboard.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DETAIL = REPO_ROOT / "scripts" / "sem_accuracy_detail.json"
OUT_HTML = REPO_ROOT / "scripts" / "sem_accuracy_dashboard.html"
TAKEOVER = "2026-06-29"

# ---- per-ticket slim record (only what the dashboard needs) -------------- #
# Only fields the dashboard needs (kept tight — embedded into the HTML).
SLIM_FIELDS = (
    "did", "group", "prob_cat", "severity",
    "matrix_changed", "bi_changed", "bi_dir",
    "init_bi_code", "final_bi_code",
    "sh_added", "sh_removed", "any_changed",
)


def bi_shift(rec):
    """Magnitude of BI change (0 if unchanged/unparseable)."""
    if not rec.get("bi_changed"):
        return 0
    try:
        return abs(int(rec["final_bi_code"]) - int(rec["init_bi_code"]))
    except (TypeError, ValueError):
        return 0


def matrix_cat(rec):
    m = rec.get("init_matrix", "")
    i = m.find("-")
    if i >= 0 and i + 1 < len(m) and m[i + 1].isdigit():
        return m[i + 1]
    return "?"


def matrix_occ(rec):
    m = rec.get("init_matrix", "")
    i = m.find("-")
    if i >= 0 and i + 2 < len(m):
        return m[i + 2]
    return "?"


def load_records():
    data = json.loads(DETAIL.read_text(encoding="utf-8"))
    out = []
    for r in data:
        out.append({
            "did": r.get("did", ""),
            "g": 1 if r.get("group") == "after" else 0,           # 1=after, 0=before
            "pc": r.get("prob_cat", "") or "(未分类)",
            "sev": r.get("severity", "") or "(未分类)",
            "mc": bool(r.get("matrix_changed")),
            "bc": bool(r.get("bi_changed")),
            "bd": (r.get("bi_dir", "") or "").split("(")[0].strip() or "none",  # upgraded/downgraded/none
            "bs": bi_shift(r),
            "sa": bool(r.get("sh_added")),
            "sr": bool(r.get("sh_removed")),
            "ac": bool(r.get("any_changed")),  # True = inaccurate (changed)
            "mcat": matrix_cat(r),
            "mocc": matrix_occ(r),
        })
    return out


def build_html(records, stats):
    rec_json = json.dumps(records, ensure_ascii=False, separators=(",", ":"))
    stats_json = json.dumps(stats, ensure_ascii=False, separators=(",", ":"))
    return HTML_TEMPLATE.replace("__RECORDS__", rec_json).replace("__STATS__", stats_json)


HTML_TEMPLATE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEM 准确性分析 · defect 类型筛选仪表盘 | Vizion Lab</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
:root{
  color-scheme:light;
  --surface-1:#fcfcfb; --page:#f9f9f7; --primary:#0b0b0b; --secondary:#52514e;
  --muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7; --delta-good:#006300;
  --border:rgba(11,11,11,0.10);
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4;
  --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --div-bad:#e34948; --div-neutral:#f0efec; --div-good:#2a78d6;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
  color-scheme:dark; --surface-1:#1a1a19; --page:#0d0d0d; --primary:#ffffff;
  --secondary:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --baseline:#383835;
  --delta-good:#0ca30c; --border:rgba(255,255,255,0.10);
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181;
  --s6:#008300; --s7:#9085e9; --s8:#e66767; --div-neutral:#383835;
}}
:root[data-theme="dark"]{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--primary:#ffffff;
  --secondary:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--baseline:#383835;--delta-good:#0ca30c;
  --border:rgba(255,255,255,0.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;
  --s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;--div-neutral:#383835;}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--primary);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.55;font-size:15px}
.wrap{max-width:1280px;margin:0 auto;padding:24px 20px 80px}
header.hero{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:28px 32px;margin-bottom:20px}
header.hero h1{margin:0 0 6px;font-size:26px;letter-spacing:-0.2px}
header.hero .sub{color:var(--secondary);font-size:14px}
.tog{float:right;display:flex;gap:6px;margin-top:-4px}
.tog button{background:var(--surface-1);border:1px solid var(--border);border-radius:8px;
  padding:5px 10px;cursor:pointer;color:var(--secondary);font-size:12px}
.tog button.on{color:var(--primary);border-color:var(--baseline)}
.note{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;
  padding:14px 18px;font-size:13px;color:var(--secondary);margin:16px 0}
.note b{color:var(--primary)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:20px 0}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:16px}
.card .lbl{color:var(--secondary);font-size:11px;text-transform:uppercase;letter-spacing:0.4px}
.card .val{font-size:27px;font-weight:700;margin:4px 0;font-variant-numeric:tabular-nums}
.card .delta{font-size:12px;font-variant-numeric:tabular-nums}
.card .delta.up{color:var(--delta-good)} .card .delta.down{color:var(--s8)}
section{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;
  padding:24px;margin:16px 0}
section h2{margin:0 0 4px;font-size:19px}
section .lede{color:var(--secondary);font-size:13px;margin:0 0 16px}
.chart{width:100%;height:360px}
.chart.sm{height:300px}
.chart.lg{height:440px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:760px){.row2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--grid)}
th{color:var(--secondary);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.3px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.filterbar{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px;align-items:center;position:sticky;top:0;
  background:var(--page);padding:10px 0;z-index:5}
.filterbar label{font-size:13px;color:var(--secondary);display:flex;align-items:center;gap:6px}
.filterbar select,.filterbar input{background:var(--surface-1);color:var(--primary);border:1px solid var(--border);
  border-radius:7px;padding:7px 10px;font-size:13px}
.filterbar select{max-width:300px}
.filterbar .cnt{color:var(--muted);font-size:12px;margin-left:auto}
.chip{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600}
.chip.over{background:rgba(227,73,72,0.14);color:var(--s8)}
.chip.under{background:rgba(42,120,214,0.14);color:var(--s1)}
.tlist{max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:10px}
.tlist table{font-size:12px}
.tlist th{position:sticky;top:0;background:var(--surface-1)}
</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <div class="tog">
    <button onclick="setTheme('light')" id="tb-light">Light</button>
    <button onclick="setTheme('dark')" id="tb-dark">Dark</button>
  </div>
  <h1>SEM 准确性分析 · 按 defect 类型筛选</h1>
  <div class="sub">Smart Error Management · 接管分界 __TAKEOVER__ · 数据源 qgate_raw.db (15GB SQLite, 105K defects) · __N__ 张打过 Matrix 标签的 defect · Vizion Lab</div>
</header>

<div class="note">准确率定义：初始判断（Phase 01/02 SEM 打标）在 Phase 03 开发分析后<b>未变更 = 准确</b>。下方所有 KPI 与图表随顶部 defect 类型筛选<b>实时重算</b>。数据来自 <code>sem_accuracy_detail.json</code>（首轮分析输出，无需重跑 15GB 库）。</div>

<div class="filterbar">
  <label>defect 类型
    <select id="flt-type" onchange="applyFilter()"></select>
  </label>
  <label>组别
    <select id="flt-group" onchange="applyFilter()">
      <option value="">全部</option>
      <option value="0">接管前（人工）</option>
      <option value="1">接管后（SEM 自动）</option>
    </select>
  </label>
  <span class="cnt" id="flt-cnt"></span>
</div>

<div class="cards" id="kpis"></div>

<section>
  <h2>1 · 总体准确性（接管前 vs 接管后）</h2>
  <p class="lede">未变更 = 准确，变更 = 不准确。选不同 defect 类型对比两组准确率。</p>
  <div id="c-acc" class="chart sm"></div>
</section>

<section>
  <h2>2 · 分字段变更率</h2>
  <p class="lede">Matrix 重新评级 / BI 等级变更 / 缺陷分类集合变更 / Showstopper Candidate 翻转。</p>
  <div id="c-field" class="chart sm"></div>
</section>

<section>
  <h2>3 · 误判方向：漏判 vs 过判</h2>
  <p class="lede">BI 升级（final&lt;init）= 漏判；BI 降级（final&gt;init）= 过判。Showstopper 仅统计"开发后新增"（漏判）。</p>
  <div class="row2"><div id="c-bidir" class="chart sm"></div><div id="c-sh" class="chart sm"></div></div>
</section>

<section>
  <h2>4 · BI 偏移幅度分布</h2>
  <p class="lede">|final−init| 的档位分布，多为 1 档微调。</p>
  <div id="c-bishift" class="chart sm"></div>
</section>

<section>
  <h2>5 · 子维度准确率（当前筛选范围内）</h2>
  <p class="lede">当前筛选集按 severity / Matrix Category / Matrix Occurrence 拆分的准确率。柱顶为百分比。</p>
  <div class="row2"><div id="c-sev" class="chart sm"></div><div id="c-mcat" class="chart sm"></div></div>
  <div id="c-mocc" class="chart sm"></div>
</section>

<section>
  <h2>6 · 明细 ticket（当前筛选）</h2>
  <p class="lede">点击列头排序。仅显示前 500 条；完整数据见 detail.json。</p>
  <div class="tlist"><table id="t-tickets">
    <thead><tr>
      <th>defect id</th><th>组别</th><th>defect 类型</th><th>severity</th>
      <th>Matrix Cat</th><th class="num">准确</th><th class="num">BI 偏移</th><th>误判方向</th><th>SH 漏判</th>
    </tr></thead>
    <tbody id="tb-tickets"></tbody>
  </table></div>
</section>
</div>

<script>
const RECORDS = __RECORDS__;
const STATS = __STATS__;
const CHARTS = {};   // echarts instances, keyed by element id
let CURRENT = null;  // currently-filtered record set

// ---- theme ----
function setTheme(t){
  document.documentElement.setAttribute('data-theme',t);
  document.getElementById('tb-light').classList.toggle('on',t==='light');
  document.getElementById('tb-dark').classList.toggle('on',t==='dark');
  // Repaint existing charts so they pick up the new CSS-variable palette.
  if (Object.keys(CHARTS).length && CURRENT) applyFilter();
}
(function initTheme(){
  const d=window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches;
  setTheme(d?'dark':'light');
})();

// ---- palette from CSS vars ----
function C(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function pal(){return {b:C('--s1'),o:C('--s2'),g:C('--s3'),y:C('--s4'),m:C('--s5'),
  gr:C('--s6'),v:C('--s7'),r:C('--s8'),good:C('--good'),bad:C('--s8'),
  surface:C('--surface-1'),primary:C('--primary'),secondary:C('--secondary'),
  muted:C('--muted'),grid:C('--grid'),baseline:C('--baseline'),
  divBad:C('--div-bad'),divNeutral:C('--div-neutral'),divGood:C('--div-good')};}
function tx(hex,a){ // hex + alpha -> rgba
  const h=hex.replace('#','');
  const r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---- defect type dropdown ----
(function buildTypeDropdown(){
  const cnt={};
  for(const r of RECORDS){cnt[r.pc]=(cnt[r.pc]||0)+1;}
  const types=Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a]);
  const sel=document.getElementById('flt-type');
  const optAll=document.createElement('option');optAll.value='';optAll.textContent='全部 defect 类型 ('+RECORDS.length+')';
  sel.appendChild(optAll);
  for(const t of types){
    const o=document.createElement('option');o.value=t;o.textContent=t+' ('+cnt[t]+')';sel.appendChild(o);
  }
})();

// ---- filtering ----
function filtered(){
  const t=document.getElementById('flt-type').value;
  const g=document.getElementById('flt-group').value;
  let out=RECORDS;
  if(t)out=out.filter(r=>r.pc===t);
  if(g!=='')out=out.filter(r=>String(r.g)===g);
  return out;
}

// ---- aggregation ----
function accOf(rs){ // {before,after} each {n, accurate}
  const b={n:0,acc:0},a={n:0,acc:0};
  for(const r of rs){if(r.g===0){b.n++;if(!r.ac)b.acc++;}else{a.n++;if(!r.ac)a.acc++;}}
  return {b,a};
}
function pct(x,n){return n?x/n*100:0;}
function fieldRates(rs){
  const b={n:0,m:0,bi:0,sh:0},a={n:0,m:0,bi:0,sh:0};
  for(const r of rs){
    const tgt=r.g===0?b:a;tgt.n++;
    if(r.mc)tgt.m++;if(r.bc)tgt.bi++;if(r.sa||r.sr)tgt.sh++;
  }
  return {b,a};
}
function biDir(rs){
  const b={up:0,dn:0},a={up:0,dn:0};
  for(const r of rs){
    const tgt=r.g===0?b:a;
    if(r.bd==='upgraded')tgt.up++;else if(r.bd==='downgraded')tgt.dn++;
  }
  return {b,a};
}
function shFlips(rs){const b={add:0},a={add:0};for(const r of rs){if(r.sa)(r.g===0?b:a).add++;}return {b,a};}
function biShiftDist(rs){
  const b={1:0,2:0,3:0},a={1:0,2:0,3:0};
  for(const r of rs){const s=r.bs;if(s<=0)continue;const k=s>=3?3:s;const tgt=r.g===0?b:a;tgt[k]++;}
  return {b,a};
}
function dimAcc(rs,key){
  const map={};
  for(const r of rs){
    const v=r[key];if(!map[v])map[v]={n:0,acc:0};map[v].n++;if(!r.ac)map[v].acc++;
  }
  return Object.entries(map).map(([k,v])=>({k,acc:pct(v.acc,v.n),n:v.n}))
    .sort((x,y)=>y.n-x.n);
}

// ---- KPI cards ----
function fmtDelta(afterPct,beforePct){
  if(beforePct==null||afterPct==null)return '';
  const d=afterPct-beforePct;
  if(Math.abs(d)<0.05)return '<span class="delta">±0.0pp</span>';
  const cls=d>0?'up':'down',sign=d>0?'+':'';
  return `<span class="delta ${cls}">${sign}${d.toFixed(1)}pp</span>`;
}
function renderKPIs(rs){
  const {b,a}=accOf(rs);
  const bAcc=pct(b.acc,b.n),aAcc=pct(a.acc,a.n);
  const bChg=100-bAcc,aChg=100-aAcc;
  const fr=fieldRates(rs),bd=biDir(rs),sh=shFlips(rs);
  const shB=pct(sh.b.add,b.n),shA=pct(sh.a.add,a.n);
  const cards=[
    {lbl:'样本量 · 接管前',val:b.n, delta:''},
    {lbl:'样本量 · 接管后',val:a.n, delta:''},
    {lbl:'准确率 · 接管前',val:bAcc.toFixed(1)+'%', delta:''},
    {lbl:'准确率 · 接管后',val:aAcc.toFixed(1)+'%', delta:fmtDelta(aAcc,bAcc)},
    {lbl:'变更率 · 接管前',val:bChg.toFixed(1)+'%', delta:''},
    {lbl:'变更率 · 接管后',val:aChg.toFixed(1)+'%', delta:fmtDelta(aChg,bChg)},
    {lbl:'SH 漏判率 · 接管前',val:shB.toFixed(1)+'%', delta:''},
    {lbl:'SH 漏判率 · 接管后',val:shA.toFixed(1)+'%', delta:fmtDelta(shA,shB)},
  ];
  document.getElementById('kpis').innerHTML=cards.map(c=>
    `<div class="card"><div class="lbl">${c.lbl}</div><div class="val">${c.val}</div>${c.delta}</div>`).join('');
}

// ---- charts ----
function ensureChart(id){if(!CHARTS[id]){const el=document.getElementById(id);if(el)CHARTS[id]=echarts.init(el);}return CHARTS[id];}
function baseGrid(){return {left:48,right:20,top:30,bottom:36};}
function axisStyle(p){return {axisLine:{lineStyle:{color:p.baseline}},axisLabel:{color:p.muted,fontSize:11},
  splitLine:{lineStyle:{color:p.grid}},axisTick:{show:false}};}

function renderAccChart(rs){
  const ch=ensureChart('c-acc');const p=pal();const {b,a}=accOf(rs);
  const opt={
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},textStyle:{fontSize:12},
      formatter:ps=>ps.map(x=>`${x.marker}${x.name}<br/>准确 <b>${x.value.toFixed(1)}%</b> (n=${x.data.n})`).join('<br/>')},
    legend:{data:['接管前（人工）','接管后（SEM 自动）'],textStyle:{color:p.secondary,fontSize:11},top:0},
    grid:baseGrid(),xAxis:{type:'category',data:['准确率','变更率'],...axisStyle(p)},
    yAxis:{type:'value',max:100,axisLabel:{formatter:'{value}%',color:p.muted,fontSize:11},
      splitLine:{lineStyle:{color:p.grid}},axisLine:{show:false},axisTick:{show:false}},
    series:[
      {name:'接管前（人工）',type:'bar',data:[{value:pct(b.acc,b.n),n:b.n},{value:100-pct(b.acc,b.n),n:b.n}],
        itemStyle:{color:p.b,borderRadius:[4,4,0,0]},barGap:'15%'},
      {name:'接管后（SEM 自动）',type:'bar',data:[{value:pct(a.acc,a.n),n:a.n},{value:100-pct(a.acc,a.n),n:a.n}],
        itemStyle:{color:p.o,borderRadius:[4,4,0,0]}}
    ]
  };
  ch.setOption(opt,true);
}

function renderFieldChart(rs){
  const ch=ensureChart('c-field');const p=pal();const fr=fieldRates(rs);
  // Classification-set change is not in the slim model; show the 3 fields we have.
  const catsR=['Matrix 重新评级','BI 等级变更','SH-Candidate 翻转'];
  const bR=[pct(fr.b.m,fr.b.n),pct(fr.b.bi,fr.b.n),pct(fr.b.sh,fr.b.n)];
  const aR=[pct(fr.a.m,fr.a.n),pct(fr.a.bi,fr.a.n),pct(fr.a.sh,fr.a.n)];
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:ps=>ps.map(x=>`${x.marker}${x.seriesName}<br/>${x.name}: <b>${x.value.toFixed(1)}%</b>`).join('<br/>')},
    legend:{data:['接管前','接管后'],textStyle:{color:p.secondary,fontSize:11},top:0},
    grid:baseGrid(),xAxis:{type:'category',data:catsR,...axisStyle(p)},
    yAxis:{type:'value',max:100,axisLabel:{formatter:'{value}%',color:p.muted,fontSize:11},splitLine:{lineStyle:{color:p.grid}},axisLine:{show:false},axisTick:{show:false}},
    series:[
      {name:'接管前',type:'bar',data:bR,itemStyle:{color:p.b,borderRadius:[4,4,0,0]},barGap:'15%'},
      {name:'接管后',type:'bar',data:aR,itemStyle:{color:p.o,borderRadius:[4,4,0,0]}}
    ]
  },true);
}

function renderDirCharts(rs){
  const p=pal();
  // BI direction
  const ch1=ensureChart('c-bidir');const bd=biDir(rs);
  ch1.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:ps=>ps.map(x=>`${x.marker}${x.seriesName}<br/>${x.name}: <b>${x.value}</b>`).join('<br/>')},
    legend:{data:['接管前','接管后'],textStyle:{color:p.secondary,fontSize:11},top:0},
    grid:baseGrid(),xAxis:{type:'category',data:['漏判 (升级)','过判 (降级)'],...axisStyle(p)},
    yAxis:{type:'value',axisLabel:{color:p.muted,fontSize:11},splitLine:{lineStyle:{color:p.grid}},axisLine:{show:false},axisTick:{show:false}},
    series:[
      {name:'接管前',type:'bar',data:[bd.b.up,bd.b.dn],itemStyle:{color:p.b,borderRadius:[4,4,0,0]},barGap:'15%'},
      {name:'接管后',type:'bar',data:[bd.a.up,bd.a.dn],itemStyle:{color:p.o,borderRadius:[4,4,0,0]}}
    ]
  },true);
  // SH flips
  const ch2=ensureChart('c-sh');const sh=shFlips(rs);
  ch2.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:ps=>ps.map(x=>`${x.marker}${x.seriesName}<br/>${x.name}: <b>${x.value}</b>`).join('<br/>')},
    legend:{data:['接管前','接管后'],textStyle:{color:p.secondary,fontSize:11},top:0},
    grid:baseGrid(),xAxis:{type:'category',data:['SH 漏判(开发后新增)'],...axisStyle(p)},
    yAxis:{type:'value',axisLabel:{color:p.muted,fontSize:11},splitLine:{lineStyle:{color:p.grid}},axisLine:{show:false},axisTick:{show:false}},
    series:[
      {name:'接管前',type:'bar',data:[sh.b.add],itemStyle:{color:p.b,borderRadius:[4,4,0,0]},barGap:'15%'},
      {name:'接管后',type:'bar',data:[sh.a.add],itemStyle:{color:p.o,borderRadius:[4,4,0,0]}}
    ]
  },true);
}

function renderBiShift(rs){
  const ch=ensureChart('c-bishift');const p=pal();const d=biShiftDist(rs);
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:ps=>ps.map(x=>`${x.marker}${x.seriesName}<br/>${x.name}: <b>${x.value}</b>`).join('<br/>')},
    legend:{data:['接管前','接管后'],textStyle:{color:p.secondary,fontSize:11},top:0},
    grid:baseGrid(),xAxis:{type:'category',data:['1 档','2 档','≥3 档'],...axisStyle(p)},
    yAxis:{type:'value',axisLabel:{color:p.muted,fontSize:11},splitLine:{lineStyle:{color:p.grid}},axisLine:{show:false},axisTick:{show:false}},
    series:[
      {name:'接管前',type:'bar',data:[d.b[1],d.b[2],d.b[3]],itemStyle:{color:p.b,borderRadius:[4,4,0,0]},barGap:'15%'},
      {name:'接管后',type:'bar',data:[d.a[1],d.a[2],d.a[3]],itemStyle:{color:p.o,borderRadius:[4,4,0,0]}}
    ]
  },true);
}

function renderDimCharts(rs){
  const p=pal();
  function draw(id,data,title){
    const ch=ensureChart(id);
    const top=data.slice(0,10);
    ch.setOption({
      title:{text:title,subtext:'柱顶=准确率%，标签n=样本量',left:'center',textStyle:{color:p.secondary,fontSize:12,fontWeight:'normal'},subtextStyle:{color:p.muted,fontSize:10}},
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:ps=>ps.map(x=>`${x.name}<br/>准确率 <b>${x.value.toFixed(1)}%</b> (n=${x.data.n})`).join('<br/>')},
      grid:{left:120,right:30,top:40,bottom:36},
      xAxis:{type:'value',max:100,axisLabel:{formatter:'{value}%',color:p.muted,fontSize:11},splitLine:{lineStyle:{color:p.grid}},axisLine:{show:false},axisTick:{show:false}},
      yAxis:{type:'category',data:top.map(d=>d.k).reverse(),axisLabel:{color:p.secondary,fontSize:11},axisLine:{lineStyle:{color:p.baseline}},axisTick:{show:false}},
      series:[{type:'bar',data:top.map(d=>({value:d.acc,n:d.n})).reverse(),
        itemStyle:{color:p.b,borderRadius:[0,4,4,0]},
        label:{show:true,position:'right',formatter:x=>x.value.toFixed(1)+'%',color:p.muted,fontSize:10}}]
    },true);
  }
  draw('c-sev',dimAcc(rs,'sev'),'按 severity');
  draw('c-mcat',dimAcc(rs,'mcat'),'按 Matrix Category');
  draw('c-mocc',dimAcc(rs,'mocc'),'按 Matrix Occurrence');
}

function renderTickets(rs){
  const tb=document.getElementById('tb-tickets');
  const rows=rs.slice(0,500);
  tb.innerHTML=rows.map(r=>{
    const dir=r.bd==='upgraded'?'<span class="chip under">漏判</span>':r.bd==='downgraded'?'<span class="chip over">过判</span>':'—';
    return `<tr>
      <td>${r.did}</td><td>${r.g?'接管后':'接管前'}</td><td>${r.pc}</td><td>${r.sev}</td>
      <td>${r.mcat}</td><td class="num">${r.ac?'否':'是'}</td><td class="num">${r.bs||0}</td>
      <td>${dir}</td><td>${r.sa?'是':''}</td></tr>`;
  }).join('');
}

function applyFilter(){
  const rs=filtered();
  CURRENT=rs;
  document.getElementById('flt-cnt').textContent='当前筛选：'+rs.length+' / '+RECORDS.length+' 张';
  renderKPIs(rs);renderAccChart(rs);renderFieldChart(rs);renderDirCharts(rs);
  renderBiShift(rs);renderDimCharts(rs);renderTickets(rs);
  redraw();
}
function redraw(){for(const id in CHARTS){CHARTS[id].resize();}}
window.addEventListener('resize',redraw);

// first paint
applyFilter();
</script>
</body>
</html>
"""


def compute_overview_stats(records):
    """Non-filterable headline stats shown in the note/hero (the full-cohort baseline)."""
    before = [r for r in records if r["g"] == 0]
    after = [r for r in records if r["g"] == 1]

    def acc(rs):
        n = len(rs)
        a = sum(1 for r in rs if not r["ac"])
        return {"n": n, "acc": a, "acc_pct": round(a / n * 100, 1) if n else 0.0}

    return {
        "n": len(records),
        "before": acc(before),
        "after": acc(after),
        "takeover": TAKEOVER,
    }


def main():
    print(f"Reading {DETAIL} ...")
    records = load_records()
    print(f"  {len(records)} slim records")
    stats = compute_overview_stats(records)
    html = build_html(records, stats)
    html = (html.replace("__TAKEOVER__", TAKEOVER)
                .replace("__N__", f"{len(records):,}"))
    OUT_HTML.write_text(html, encoding="utf-8")
    print(f"  -> {OUT_HTML}  ({OUT_HTML.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
