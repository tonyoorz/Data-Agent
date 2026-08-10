"""Generate a self-contained HTML SEM accuracy report with a defect-type (prob_cat)
filter that drives every chart and the ticket table. Reads the already-computed
per-defect detail (sem_accuracy_detail.json) and defect names from the source DB.

Run:  .venv/Scripts/python.exe scripts/build_filtered_report.py
"""
from __future__ import annotations
import io, json, sqlite3, sys
from collections import Counter
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
REPO = Path(__file__).resolve().parent.parent
DB = REPO / "database" / "source" / "qgate_raw.db"
DETAIL = REPO / "scripts" / "sem_accuracy_detail.json"
OUT = REPO / "scripts" / "sem_accuracy_report_filtered.html"
TAKEOVER = "2026-06-29"

detail = json.load(open(DETAIL, encoding="utf-8"))
print(f"loaded {len(detail)} defect records")

# ---- fetch defect names in batches (15GB DB, but IN-list on indexed PK is fast) ----
names: dict[str, str] = {}
con = sqlite3.connect(DB)
dids = [d["did"] for d in detail]
BATCH = 5000
for i in range(0, len(dids), BATCH):
    batch = dids[i:i + BATCH]
    qmarks = ",".join("?" * len(batch))
    rows = con.execute(
        f'SELECT defect_id, json_extract(raw_json,"$.name") FROM octane_defects '
        f"WHERE defect_id IN ({qmarks})", batch)
    for did, name in rows:
        names[did] = (name or "")[:140]
    print(f"  names {len(names)}/{len(dids)}")
con.close()

# ---- slim per-defect records for the client ----
tickets = []
for d in detail:
    tickets.append({
        "did": d["did"], "name": names.get(d["did"], ""), "pc": d["prob_cat"] or "(empty)",
        "sev": d["severity"] or "", "sc": d["sol_cluster"] or "",
        "g": d["group"],  # before / after
        "im": d["init_matrix"], "fm": d["final_matrix"], "mch": d["matrix_changed"],
        "ib": d["init_bi_code"], "fb": d["final_bi_code"], "bch": d["bi_changed"],
        "bdir": d["bi_dir"], "rcch": d["rc_changed"], "shch": d["sh_changed"],
        "sha": d["sh_added"], "shr": d["sh_removed"], "any": d["any_changed"],
        "r03": d["reached_phase03"], "cr": d["created"][:10] if d["created"] else "",
        "ph": d["phase_name"] or "",
    })

# ---- overall (all defect types) for the headline ----
def stats(rs):
    n = len(rs)
    if not n:
        return {"n": 0, "change_rate": 0, "accuracy": 0, "matrix_re": 0, "bi_change": 0,
                "rc_change": 0, "sh_flip": 0, "bi_under": 0, "bi_over": 0, "sh_under": 0, "sh_over": 0}
    def rate(k): return round(sum(1 for d in rs if d[k]) / n * 100, 1)
    return {"n": n, "change_rate": round(sum(1 for d in rs if d["any_changed"]) / n * 100, 1),
            "accuracy": round(100 - sum(1 for d in rs if d["any_changed"]) / n * 100, 1),
            "matrix_re": rate("matrix_changed"), "bi_change": rate("bi_changed"),
            "rc_change": rate("rc_changed"), "sh_flip": rate("sh_changed"),
            "bi_under": sum(1 for d in rs if d["bi_dir"].startswith("upgraded")),
            "bi_over": sum(1 for d in rs if d["bi_dir"].startswith("downgraded")),
            "sh_under": sum(1 for d in rs if d["sh_added"]), "sh_over": sum(1 for d in rs if d["sh_removed"])}

before_all = [d for d in detail if d["group"] == "before"]
after_all = [d for d in detail if d["group"] == "after"]
overall = {"before": stats(before_all), "after": stats(after_all), "total": len(detail),
           "takeover": TAKEOVER}

# ---- defect-type options (prob_cat), sorted by total count desc ----
pc_counts = Counter(d["prob_cat"] or "(empty)" for d in detail)
defect_types = [{"k": k, "n": v} for k, v in pc_counts.most_common()]

payload = {"overall": overall, "defect_types": defect_types, "tickets": tickets}
print(f"payload: {len(tickets)} tickets, {len(defect_types)} defect types")

HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEM 准确性分析 · 按缺陷类型筛选 | Vizion Lab</title>
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
header.hero{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;
  padding:28px 32px;margin-bottom:20px}
header.hero h1{margin:0 0 6px;font-size:25px;letter-spacing:-0.2px}
header.hero .sub{color:var(--secondary);font-size:14px}
.tog{float:right;display:flex;gap:6px;margin-top:-4px}
.tog button{background:var(--surface-1);border:1px solid var(--border);border-radius:8px;
  padding:5px 10px;cursor:pointer;color:var(--secondary);font-size:12px}
.tog button.on{color:var(--primary);border-color:var(--baseline)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:20px 0}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:16px}
.card .lbl{color:var(--secondary);font-size:12px;text-transform:uppercase;letter-spacing:0.4px}
.card .val{font-size:26px;font-weight:700;margin:4px 0;font-variant-numeric:tabular-nums}
.card .delta{font-size:12px;font-variant-numeric:tabular-nums}
.up{color:var(--delta-good)} .down{color:var(--s8)} .tagc{color:var(--secondary)}
.filterbar{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;margin:16px 0;display:flex;flex-wrap:wrap;gap:14px;align-items:center;position:sticky;top:8px;z-index:20}
.filterbar label{font-size:13px;color:var(--secondary);display:flex;flex-direction:column;gap:3px}
.filterbar select,.filterbar input{background:var(--page);color:var(--primary);border:1px solid var(--border);
  border-radius:7px;padding:7px 9px;font-size:13px;min-width:200px}
.filterbar .reset{background:var(--page);color:var(--secondary);border:1px solid var(--border);
  border-radius:7px;padding:7px 12px;font-size:13px;cursor:pointer}
.filterbar .reset:hover{color:var(--primary)}
section{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;
  padding:24px;margin:16px 0}
section h2{margin:0 0 4px;font-size:19px}
section .lede{color:var(--secondary);font-size:13px;margin:0 0 16px}
.chart{width:100%;height:360px}
.chart.sm{height:300px}
.chart.lg{height:420px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:760px){.row2{grid-template-columns:1fr}}
.note{background:rgba(42,120,214,0.06);border:1px solid var(--border);border-radius:8px;padding:10px 14px;
  font-size:13px;color:var(--secondary);margin:12px 0}
.note.warn{background:rgba(227,73,72,0.06)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--grid)}
th{color:var(--secondary);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.3px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr:hover td{background:var(--page)}
.chip{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap}
.chip.over{background:rgba(227,73,72,0.14);color:var(--s8)}
.chip.under{background:rgba(42,120,214,0.14);color:var(--s1)}
.chip.ok{background:rgba(12,163,12,0.14);color:var(--good)}
.chip.tag{background:var(--grid);color:var(--secondary)}
.pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:14px 0;color:var(--secondary);font-size:13px}
.pager button{background:var(--page);border:1px solid var(--border);border-radius:7px;padding:6px 12px;cursor:pointer;color:var(--primary);font-size:13px}
.pager button:disabled{opacity:0.4;cursor:default}
footer{color:var(--muted);font-size:12px;text-align:center;padding:20px}
.hide{display:none!important}
a{color:var(--s1)}
</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <div class="tog">
    <button onclick="setTheme('auto')" id="tb-auto">Auto</button>
    <button onclick="setTheme('light')" id="tb-light">Light</button>
    <button onclick="setTheme('dark')" id="tb-dark">Dark</button>
  </div>
  <h1>SEM 准确性分析 · 按缺陷类型筛选报告</h1>
  <div class="sub">Smart Error Management 自动接管 QGate · 接管分界 __TK__ · 数据源 qgate_raw.db · 当前筛选：<b id="cur-filter">全部缺陷类型</b></div>
</header>

<div class="filterbar" id="fbar">
  <label>缺陷类型 (problem_category)
    <select id="flt-pc"><option value="">全部</option></select>
  </label>
  <label>组别
    <select id="flt-g">
      <option value="">全部</option>
      <option value="before">接管前(人工)</option>
      <option value="after">接管后(SEM自动)</option>
    </select>
  </label>
  <label>误判方向
    <select id="flt-dir">
      <option value="">全部</option>
      <option value="under">漏判(升级/SH新增)</option>
      <option value="over">过判(降级)</option>
      <option value="unchanged">未变更(准确)</option>
      <option value="changed">已变更(不准确)</option>
    </select>
  </label>
  <label>搜索 defect id / 名称
    <input id="flt-q" placeholder="输入 id 或名称…">
  </label>
  <button class="reset" onclick="resetFilters()">重置筛选</button>
</div>

<div class="cards" id="kpis"></div>

<div class="note">准确率定义：初始判断（Phase 01/02 SEM 打 Matrix 标签时）在 Phase 03 开发分析后<span style="color:var(--primary)">未变更 = 准确</span>。BI 升级(final&lt;init)=<b>漏判</b>，BI 降级(final&gt;init)=<b>过判</b>；Showstopper 新增=漏判。所有图表与下方表格随上方"缺陷类型"筛选实时联动。</div>

<section>
  <h2>1 · 准确率：接管前 vs 接管后</h2>
  <p class="lede" id="lede-acc">柱状对比当前筛选范围内的准确率与变更率。</p>
  <div id="c-acc" class="chart sm"></div>
</section>

<section>
  <h2>2 · 误判方向：漏判 vs 过判</h2>
  <p class="lede">BI 等级降级(过判) vs 升级(漏判) 数量；Showstopper 漏判(人工补加 SH)。</p>
  <div class="row2"><div id="c-bidir" class="chart sm"></div><div id="c-sh" class="chart sm"></div></div>
</section>

<section>
  <h2>3 · 字段级变更率</h2>
  <p class="lede">Matrix 重新评级 / BI 等级变更 / 分类集合变更 / SH 翻转，接管前 vs 后。</p>
  <div id="c-field" class="chart sm"></div>
</section>

<section>
  <h2>4 · 缺陷类型对比（准确率）</h2>
  <p class="lede">当前筛选范围内各 problem_category 的接管后准确率 Top 12（按样本量排序）。点击柱条可设为筛选。</p>
  <div id="c-pc" class="chart lg"></div>
</section>

<section>
  <h2>5 · 明细列表 <span class="chip tag" id="cnt-chip">0 张</span></h2>
  <p class="lede">下表为当前筛选命中的 defect，按创建时间倒序。点击 Octane 链接跳转原 ticket。仅显示前 200 条，调整筛选以缩小范围。</p>
  <table id="t-tickets">
    <thead><tr>
      <th>Defect ID / 名称</th><th>类型</th><th>组别</th><th>Matrix (init→final)</th>
      <th>BI (init→final)</th><th>方向</th><th>SH</th><th>状态</th>
    </tr></thead>
    <tbody></tbody>
  </table>
  <div class="pager" id="pager"></div>
</section>

<div class="note warn"><b>主要数据局限</b>：① 成熟度偏差——接管前组最长 18 个月观察窗口 vs 接管后约 5 周，可能高估接管后优势；方向性结论高置信、具体幅度中等置信。② 历史只记 ADD 不记 REMOVE，最终状态为 add 序列推断。③ 接管后当前快照 user_tags 缺失，全程依赖历史重建。④ sample 定义：以"打过 Matrix 标签"作 SEM 处理代理（旧标签 IuK_AI_SmartErrorMan 在 6/29 后不再使用）。</div>

<footer>数据 scripts/sem_accuracy_detail.json (33,774 defects) · 生成 scripts/build_filtered_report.py · Vizion Lab SEM Evaluation</footer>
</div>

<script>
const DATA = __PAYLOAD__;
const TK = "__TK__";
const PAL = ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#4a3aa7","#e34948"];
const PAL_D = ["#3987e5","#d95926","#199e70","#c98500","#d55181","#008300","#9085e9","#e66767"];
function p(){return document.documentElement.getAttribute("data-theme")==="dark"||(document.documentElement.getAttribute("data-theme")!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches)?PAL_D:PAL}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
function base(){return{backgroundColor:"transparent",textStyle:{color:css("--primary")},color:p()}}
function setTheme(t){document.documentElement.removeAttribute("data-theme");if(t!=="auto")document.documentElement.setAttribute("data-theme",t);
["auto","light","dark"].forEach(x=>document.getElementById("tb-"+x).classList.toggle("on",x===t));location.hash="theme="+t;rerender()}
if(location.hash.includes("theme=")){const t=location.hash.split("theme=")[1].split("&")[0];if(["auto","light","dark"].includes(t))setTheme(t)}
else document.getElementById("tb-auto").classList.add("on");

// document title shows the takeover
document.querySelector(".sub").innerHTML=document.querySelector(".sub").innerHTML.replace("__TK__",TK);

// ---- populate defect-type select ----
(function(){const sel=document.getElementById("flt-pc");
DATA.defect_types.forEach(d=>{const o=document.createElement("option");o.value=d.k;o.textContent=`${d.k} (${d.n})`;sel.appendChild(o)})})();

// ---- stats helper (mirrors python stats()) ----
function stats(rs){const n=rs.length;
 if(!n)return{n:0,change_rate:0,accuracy:0,matrix_re:0,bi_change:0,rc_change:0,sh_flip:0,bi_under:0,bi_over:0,sh_under:0,sh_over:0};
 const rate=k=>rs.filter(d=>d[k]).length/n*100;
 return{n,change_rate:+(rs.filter(d=>d.any).length/n*100).toFixed(1),
  accuracy:+(100-rs.filter(d=>d.any).length/n*100).toFixed(1),
  matrix_re:+rate("mch").toFixed(1),bi_change:+rate("bch").toFixed(1),
  rc_change:+rate("rcch").toFixed(1),sh_flip:+rate("shch").toFixed(1),
  bi_under:rs.filter(d=>d.bdir.startsWith("upgraded")).length,
  bi_over:rs.filter(d=>d.bdir.startsWith("downgraded")).length,
  sh_under:rs.filter(d=>d.sha).length,sh_over:rs.filter(d=>d.shr).length}}

function filtered(){const pc=document.getElementById("flt-pc").value,g=document.getElementById("flt-g").value,
 dir=document.getElementById("flt-dir").value,q=document.getElementById("flt-q").value.toLowerCase();
 return DATA.tickets.filter(t=>{
  if(pc&&t.pc!==pc)return false;
  if(g&&t.g!==g)return false;
  if(dir==="under"&&!((t.bdir.startsWith("upgraded"))||t.sha))return false;
  if(dir==="over"&&!t.bdir.startsWith("downgraded"))return false;
  if(dir==="unchanged"&&t.any)return false;
  if(dir==="changed"&&!t.any)return false;
  if(q&&!(t.did.includes(q)||t.name.toLowerCase().includes(q)))return false;
  return true})}

function kpiCard(l,v,d,cls){return`<div class="card"><div class="lbl">${l}</div><div class="val">${v}</div><div class="delta ${cls||''}">${d||''}</div></div>`}

let charts=[];
function mk(id,opt){const el=document.getElementById(id);if(!el)return;const c=echarts.init(el);c.setOption(opt);charts.push(c)}
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

function renderKpis(b,a){
 const dAcc=(a.accuracy-b.accuracy);
 document.getElementById("kpis").innerHTML=
  kpiCard("接管后准确率",a.accuracy+"%",(dAcc>=0?"+":"")+dAcc.toFixed(1)+"pp vs 接管前","up")
 +kpiCard("接管前准确率",b.accuracy+"%","n="+b.n,"tagc")
 +kpiCard("接管后变更率",a.change_rate+"%",(a.change_rate-b.change_rate).toFixed(1)+"pp","down")
 +kpiCard("BI 漏判(接管后)",a.bi_under,"过判 "+a.bi_over,"tagc")
 +kpiCard("SH 漏判(接管后)",a.sh_under,"过判 "+a.sh_over,"tagc")
 +kpiCard("样本量(当前范围)",b.n+a.n,"接管后 "+a.n,"tagc");
}

function accChart(b,a){
 mk("c-acc",Object.assign(base(),{tooltip:{trigger:"axis"},legend:{data:["准确率(未变更)","变更率(不准确)"],bottom:0,textStyle:{color:css("--secondary")}},
 grid:{left:50,right:30,top:30,bottom:50},
 xAxis:{type:"category",data:["接管前(人工)","接管后(SEM自动)"],axisLine:{lineStyle:{color:css("--baseline")}},axisLabel:{color:css("--secondary")}},
 yAxis:{type:"value",max:100,axisLabel:{color:css("--secondary"),formatter:"{value}%"},splitLine:{lineStyle:{color:css("--grid")}}},
 series:[
  {name:"准确率(未变更)",type:"bar",data:[b.accuracy,a.accuracy],itemStyle:{color:p()[2],borderRadius:[4,4,0,0]},barWidth:54,label:{show:true,position:"top",formatter:"{c}%",color:css("--primary")}},
  {name:"变更率(不准确)",type:"bar",data:[b.change_rate,a.change_rate],itemStyle:{color:p()[7],borderRadius:[4,4,0,0]},barWidth:54,label:{show:true,position:"top",formatter:"{c}%",color:css("--primary")}}
 ]}));
}

function dirCharts(b,a){
 mk("c-bidir",Object.assign(base(),{title:{text:"BI 误判方向（数量）",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
 tooltip:{trigger:"axis"},legend:{data:["漏判(升级)","过判(降级)"],bottom:0,textStyle:{color:css("--secondary")}},
 grid:{left:50,right:20,top:40,bottom:50},xAxis:{type:"category",data:["接管前","接管后"],axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
 yAxis:{type:"value",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
 series:[{name:"漏判(升级)",type:"bar",data:[b.bi_under,a.bi_under],itemStyle:{color:p()[0],borderRadius:[4,4,0,0]},barWidth:40,label:{show:true,position:"top",color:css("--primary")}},
  {name:"过判(降级)",type:"bar",data:[b.bi_over,a.bi_over],itemStyle:{color:p()[1],borderRadius:[4,4,0,0]},barWidth:40,label:{show:true,position:"top",color:css("--primary")}}]}));
 mk("c-sh",Object.assign(base(),{title:{text:"Showstopper 漏判（SH 新增）",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
 tooltip:{trigger:"axis"},grid:{left:50,right:20,top:40,bottom:30},xAxis:{type:"category",data:["接管前","接管后"],axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
 yAxis:{type:"value",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
 series:[{type:"bar",data:[b.sh_under,a.sh_under],itemStyle:{color:p()[7],borderRadius:[4,4,0,0]},barWidth:48,label:{show:true,position:"top",color:css("--primary")}}]}));
}

function fieldChart(b,a){
 const cats=["Matrix 重新评级","BI 等级变更","分类集合变更","SH Candidate 翻转"];
 mk("c-field",Object.assign(base(),{tooltip:{trigger:"axis",axisPointer:{type:"shadow"}},
 legend:{data:["接管前","接管后"],bottom:0,textStyle:{color:css("--secondary")}},
 grid:{left:90,right:30,top:20,bottom:50},
 xAxis:{type:"value",max:100,axisLabel:{color:css("--secondary"),formatter:"{value}%"},splitLine:{lineStyle:{color:css("--grid")}}},
 yAxis:{type:"category",data:cats,axisLine:{lineStyle:{color:css("--baseline")}},axisLabel:{color:css("--secondary")}},
 series:[
  {name:"接管前",type:"bar",data:[b.matrix_re,b.bi_change,b.rc_change,b.sh_flip],itemStyle:{color:p()[0],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}},
  {name:"接管后",type:"bar",data:[a.matrix_re,a.bi_change,a.rc_change,a.sh_flip],itemStyle:{color:p()[1],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}}
 ]}));
}

function pcChart(rs){
 // group by prob_cat, compute after accuracy, top 12 by n
 const m={};
 rs.forEach(t=>{const k=t.pc;(m[k]=m[k]||[]).push(t)});
 let arr=Object.keys(m).map(k=>({k,n:m[k].length,a:m[k].filter(x=>x.g==="after"),b:m[k].filter(x=>x.g==="before")}))
  .filter(r=>r.a.length>0||r.b.length>0);
 arr.sort((x,y)=>y.n-x.n);arr=arr.slice(0,12);
 const rows=arr.map(r=>({k:r.k,n:r.n,ba:r.b.length?stats(r.b).accuracy:0,aa:r.a.length?stats(r.a).accuracy:0,na:r.a.length,nb:r.b.length}));
 mk("c-pc",Object.assign(base(),{tooltip:{trigger:"axis",axisPointer:{type:"shadow"},
  formatter:p=>{const r=rows[p[0].dataIndex];return `${r.k} (n=${r.n})<br>接管前: ${r.ba}% (n=${r.nb})<br>接管后: ${r.aa}% (n=${r.na})`}},
 legend:{data:["接管前准确率","接管后准确率"],bottom:0,textStyle:{color:css("--secondary")}},
 grid:{left:160,right:50,top:20,bottom:50},
 xAxis:{type:"value",max:100,axisLabel:{color:css("--secondary"),formatter:"{value}%"},splitLine:{lineStyle:{color:css("--grid")}}},
 yAxis:{type:"category",data:rows.map(r=>r.k.length>22?r.k.slice(0,21)+"…":r.k),axisLine:{lineStyle:{color:css("--baseline")}},axisLabel:{color:css("--secondary")}},
 series:[
  {name:"接管前准确率",type:"bar",data:rows.map(r=>r.ba),itemStyle:{color:p()[0],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}},
  {name:"接管后准确率",type:"bar",data:rows.map(r=>r.aa),itemStyle:{color:p()[2],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}}
 ]}));
 // click a bar -> set as filter
 const inst=echarts.getInstanceByDom(document.getElementById("c-pc"));
 if(inst)inst.off("click"),inst.on("click",p=>{const r=rows[p.dataIndex];if(r){document.getElementById("flt-pc").value=r.k;onFilter()}});
}

// ---- ticket table (paged, top 200) ----
let pageCur=0;const PAGE=25,MAX_ROWS=200;
function renderTable(rs){
 rs.sort((a,b)=>(b.cr||"").localeCompare(a.cr||""));
 const shown=rs.slice(0,MAX_ROWS);
 const tb=document.querySelector("#t-tickets tbody");
 function row(t){const dir=t.bdir.startsWith("upgraded")?`<span class="chip under">BI漏判↑</span>`:(t.bdir.startsWith("downgraded")?`<span class="chip over">BI过判↓</span>`:"");
  const sh=t.sha?`<span class="chip under">SH漏判</span>`:(t.shr?`<span class="chip over">SH过判</span>`:(t.shch?`<span class="chip tag">SH翻转</span>`:"—"));
  const st=t.any?`<span class="chip over">已变更</span>`:`<span class="chip ok">准确</span>`;
  const grp=t.g==="after"?"接管后":"接管前";
  return `<tr>
   <td><b>${t.did}</b> · <a href="https://octane-prod.bmwgroup.net/ui/entity?p=1002/2002&entityType=work_item&id=${t.did}" target="_blank">Octane↗</a><br><span style="color:var(--secondary);font-size:12px">${esc(t.name)}</span></td>
   <td>${esc(t.pc)}</td><td>${grp}</td>
   <td>${t.im||"—"} → ${t.fm||"—"}${(t.im!==t.fm)?" <span class='chip tag'>重评</span>":""}</td>
   <td>${t.ib||"—"} → ${t.fb||"—"}</td><td>${dir}</td><td>${sh}</td><td>${st}</td></tr>`}
 // page slice
 const start=pageCur*PAGE,slice=shown.slice(start,start+PAGE);
 tb.innerHTML=slice.map(row).join("")||`<tr><td colspan="8" style="color:var(--muted);text-align:center;padding:20px">无匹配 defect</td></tr>`;
 // pager
 const pages=Math.ceil(shown.length/PAGE);
 let h=`<button onclick="pagePrev()" ${pageCur===0?"disabled":""}>‹ 上一页</button> `+
  `<span>第 ${pages?pageCur+1:0}/${pages} 页 · 显示 ${shown.length} / ${rs.length} 条 ${rs.length>MAX_ROWS?"(仅前200)":''}</span> `+
  `<button onclick="pageNext()" ${pageCur>=pages-1?"disabled":""}>下一页 ›</button>`;
 document.getElementById("pager").innerHTML=h;
 document.getElementById("cnt-chip").textContent=rs.length+" 张";
}
function pageNext(){pageCur++;renderTable(curRS)}
function pagePrev(){pageCur--;renderTable(curRS)}

let curRS=[];
function onFilter(){pageCur=0;rerender()}
function resetFilters(){document.getElementById("flt-pc").value="";document.getElementById("flt-g").value="";document.getElementById("flt-dir").value="";document.getElementById("flt-q").value="";pageCur=0;rerender()}

function rerender(){
 charts.forEach(c=>c.dispose());charts=[];
 const rs=filtered();curRS=rs;
 const b=stats(rs.filter(t=>t.g==="before")),a=stats(rs.filter(t=>t.g==="after"));
 // current filter label
 const pc=document.getElementById("flt-pc").value||"全部缺陷类型";
 document.getElementById("cur-filter").textContent=pc+` (n=${rs.length})`;
 renderKpis(b,a);accChart(b,a);dirCharts(b,a);fieldChart(b,a);pcChart(rs);renderTable(rs);
}

["flt-pc","flt-g","flt-dir"].forEach(id=>document.getElementById(id).onchange=onFilter);
document.getElementById("flt-q").oninput=onFilter;
window.addEventListener("resize",()=>charts.forEach(c=>c.resize()));
rerender();
</script>
</body></html>"""

html = HTML.replace("__PAYLOAD__", json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
html = html.replace("__TK__", TAKEOVER)

OUT.write_text(html, encoding="utf-8")
print(f"Report written: {OUT}  ({len(html)/1024:.0f} KB)")
