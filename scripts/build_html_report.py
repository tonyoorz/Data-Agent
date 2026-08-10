"""Generate the comprehensive dynamic HTML SEM evaluation report."""
from __future__ import annotations
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = json.load(open(REPO / "scripts" / "report_data.json", encoding="utf-8"))
OUT = REPO / "scripts" / "sem_evaluation_report.html"

HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEM 准确性评估报告 | Vizion Lab</title>
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
  --s6:#008300; --s7:#9085e9; --s8:#e66767;
  --div-neutral:#383835;
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
header.hero h1{margin:0 0 6px;font-size:26px;letter-spacing:-0.2px}
header.hero .sub{color:var(--secondary);font-size:14px}
.tog{float:right;display:flex;gap:6px;margin-top:-4px}
.tog button{background:var(--surface-1);border:1px solid var(--border);border-radius:8px;
  padding:5px 10px;cursor:pointer;color:var(--secondary);font-size:12px}
.tog button.on{color:var(--primary);border-color:var(--baseline)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:16px}
.card .lbl{color:var(--secondary);font-size:12px;text-transform:uppercase;letter-spacing:0.4px}
.card .val{font-size:28px;font-weight:700;margin:4px 0;font-variant-numeric:tabular-nums}
.card .delta{font-size:12px;font-variant-numeric:tabular-nums}
.up{color:var(--delta-good)} .down{color:var(--s8)}
section{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;
  padding:24px;margin:16px 0}
section h2{margin:0 0 4px;font-size:19px}
section .lede{color:var(--secondary);font-size:13px;margin:0 0 16px}
.chart{width:100%;height:360px}
.chart.sm{height:300px}
.chart.lg{height:420px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:760px){.row2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--grid)}
th{color:var(--secondary);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.3px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.filterbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center}
.filterbar select,.filterbar input{background:var(--page);color:var(--primary);border:1px solid var(--border);
  border-radius:7px;padding:6px 9px;font-size:13px}
.chip{display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600}
.chip.over{background:rgba(227,73,72,0.14);color:var(--s8)}
.chip.under{background:rgba(42,120,214,0.14);color:var(--s1)}
.chip.sem{background:rgba(237,161,0,0.16);color:var(--s4)}
.chip.ok{background:rgba(12,163,12,0.14);color:var(--good)}
.chip.tag{background:var(--grid);color:var(--secondary)}
.ticket{border:1px solid var(--border);border-radius:10px;padding:14px;margin:10px 0;background:var(--page)}
.ticket .tn{font-weight:700;font-size:13px}
.ticket .tn a{color:var(--s1);text-decoration:none}
.ticket .meta{color:var(--secondary);font-size:12px;margin:4px 0}
.flow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;margin:6px 0}
.flow .b{padding:5px 9px;border-radius:7px;background:var(--surface-1);border:1px solid var(--border);font-variant-numeric:tabular-nums}
.flow .arr{color:var(--muted)}
.cmt{border-left:3px solid var(--baseline);padding:8px 12px;margin:8px 0;background:var(--surface-1);border-radius:0 7px 7px 0}
.cmt.sem{border-left-color:var(--s4)}
.cmt .au{font-size:12px;font-weight:600}
.cmt.sem .au{color:var(--s4)}
.cmt .ts{color:var(--muted);font-size:11px;margin-left:6px}
.cmt .tx{font-size:13px;margin-top:3px;white-space:pre-wrap;word-break:break-word}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--grid);margin-bottom:14px;flex-wrap:wrap}
.tabs button{background:none;border:none;color:var(--secondary);padding:8px 14px;cursor:pointer;
  font-size:14px;border-bottom:2px solid transparent}
.tabs button.on{color:var(--primary);border-bottom-color:var(--s1)}
.note{background:rgba(42,120,214,0.06);border:1px solid var(--border);border-radius:8px;padding:10px 14px;
  font-size:13px;color:var(--secondary);margin:12px 0}
.warn{background:rgba(227,73,72,0.06)}
.prompt{background:var(--page);border:1px solid var(--border);border-radius:8px;padding:14px;margin:10px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-word;color:var(--primary)}
.prompt b{color:var(--s1)}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--grid);border:1px solid var(--grid);border-radius:8px;overflow:hidden;margin:10px 0}
.kpi-grid div{background:var(--surface-1);padding:10px;text-align:center}
.kpi-grid .k{font-size:11px;color:var(--secondary)}
.kpi-grid .v{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}
footer{color:var(--muted);font-size:12px;text-align:center;padding:20px}
.hide{display:none!important}
.legend-inline{font-size:12px;color:var(--secondary);margin-top:6px}
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
  <h1>SEM 自动接管 QGate 后初始判断准确性 · 综合评估报告</h1>
  <div class="sub">Smart Error Management · 接管分界 2026-06-29 · 数据源 qgate_raw.db (15GB SQLite, 105K defects) · Vizion Lab</div>
</header>

<!-- KPI cards injected -->
<div class="cards" id="kpis"></div>

<div class="note">本报告基于首轮 SEM 准确性分析（33,646 张打过 Matrix 标签的 defect）、CN Speech 深挖（5,536 张）、02→01 回退分析、以及人工 comment 挖掘综合生成。准确率定义：初始判断（Phase 01/02 SEM 打标）在 Phase 03 开发分析后<span style="color:var(--primary)">未变更 = 准确</span>。<b>样本定义已修正</b>：原"SEM 标签"字面筛选会使接管后组为空（旧标签 IuK_AI_SmartErrorMan 在 6/29 后不再使用），改用"打过 Matrix 标签"作 SEM 处理代理。</div>

<!-- ===== Overall ===== -->
<section>
  <h2>1 · 总体准确性：接管后显著提升</h2>
  <p class="lede">准确率 55.5% → 62.3%（+6.8pp，z=-8.54, p≈1e-17 统计显著）。主要驱动力：Showstopper Candidate 漏判率大幅下降（25.1%→13.2%）。</p>
  <div id="c-acc" class="chart"></div>
  <div id="c-field" class="chart sm"></div>
</section>

<!-- ===== Direction ===== -->
<section>
  <h2>2 · 误判方向：漏判 vs 过判</h2>
  <p class="lede">BI 等级中，降级（过判）多于升级（漏判），因 BI-6/7 边界主观；但 Showstopper Candidate 仅出现"漏判新增"（SEM 未识别 SH 被人工补加），无过判移除——与自动化"宁保守保留 SH"一致。</p>
  <div class="row2"><div id="c-bidir" class="chart sm"></div><div id="c-sh" class="chart sm"></div></div>
  <table id="t-dir"></table>
</section>

<!-- ===== Breakdowns ===== -->
<section>
  <h2>3 · 分维度细分</h2>
  <p class="lede">切换维度查看准确率。Matrix Category 呈"越主观越受益"规律：Cat 1 (+10.7pp)、Cat 2 (+9.4pp) 改善最大。</p>
  <div class="tabs" id="dimtabs">
    <button data-dim="matrix_cat" class="on">Matrix Category</button>
    <button data-dim="prob_cat">defect 类型</button>
    <button data-dim="severity">严重度</button>
    <button data-dim="sol_cluster">solution cluster</button>
  </div>
  <div id="c-dim" class="chart lg"></div>
</section>

<!-- ===== Speech deep dive ===== -->
<section>
  <h2>4 · CN Speech 深挖：唯一系统性"定级偏高"的品类</h2>
  <p class="lede">Speech defect 上 BI 过判(53) &gt; 漏判(35)，与整体方向相反。过判集中在 Occurrence A（SEM 判"持续可复现"实测多为 C/D/E）+ Cat 2/3。下方为接管后 SEM 自动判断的 Matrix 分布热力。</p>
  <div class="row2"><div id="c-speech-dir" class="chart sm"></div><div id="c-speech-grid" class="chart sm"></div></div>
  <div id="t-speech-over"></div>
  <div class="note warn"><b>关键洞察</b>：53 张过判分两类——① Matrix→BI 映射偏严（~49%，Matrix 正确但 BI 被下调，如 3C→SEM 给 BI-06，人工共识 BI-07）；② Matrix 本身偏高（~51%，高估 Category/Occurrence）。SEM 已有 <code>==Insufficient confidence==</code> 标记机制，但<b>未据此收敛到保守评分</b>。</div>
</section>

<!-- ===== 02->01 fallback ===== -->
<section>
  <h2>5 · Phase 02→01 回退：接管后上升，回退票是准确率洼地</h2>
  <p class="lede">月均回退量从 ~1,200-1,500 升至 ~1,966（7月峰值）。但被回退的 ticket 接管后变更率 58.3%，远高于全样本 37.7%——回退即"初始判断被驳回"，这类 case 即使重判仍被大量修正。</p>
  <div id="c-fb-trend" class="chart sm"></div>
  <div class="row2"><div id="c-fb-acc" class="chart sm"></div><div id="c-fb-dir" class="chart sm"></div></div>
</section>

<!-- ===== Comments ===== -->
<section>
  <h2>6 · 人工 comment 挖掘：漏判的真实定义</h2>
  <p class="lede">对漏判 ticket 评论的关键词扫描：人工讨论的核心正是 Matrix 的 Category×Occurrence 两维度（发生度低估、核心/主要功能错分、SH 遗漏），证明机械指标（BI 升级/SH 新增）捕捉到了真实漏判。</p>
  <div class="row2"><div id="c-kw-under" class="chart sm"></div><div id="c-kw-over" class="chart sm"></div></div>
</section>

<!-- ===== Ticket drilldown ===== -->
<section>
  <h2>7 · 关键 ticket 全分析（含 comment）</h2>
  <p class="lede">按类型筛选，点击 ticket 展开完整的初始/最终值 + 人工评论（含 SEM 自身 #AIgenerated 输出）。</p>
  <div class="filterbar">
    <label>类型 <select id="flt-tag"><option value="">全部</option></select></label>
    <label>组别 <select id="flt-group"><option value="">全部</option><option value="before">接管前</option><option value="after">接管后</option></select></label>
    <input id="flt-search" placeholder="搜索 defect id / 名称 / 评论…">
  </div>
  <div id="tickets"></div>
</section>

<!-- ===== Recommendations ===== -->
<section>
  <h2>8 · SEM Prompt 改进建议（针对 speech）</h2>
  <p class="lede">5 条 prompt 片段，锚定数据根因，对齐 SEM 现有输出格式（Defect name / Found in Function / Matrix Score / Duplicate candidates）。预期 A+C 两条可消除 speech 过判 ~70%。</p>
  <div id="prompts"></div>
</section>

<!-- ===== Conclusion ===== -->
<section>
  <h2>9 · 总结与置信度</h2>
  <div class="kpi-grid" id="conclusion-kpis"></div>
  <table id="t-conclusion"></table>
  <div class="note warn"><b>主要数据局限</b>：① 成熟度偏差——接管前组最长 18 个月观察窗口 vs 接管后 ~5 周，可能高估接管后优势；② 历史只记 ADD 不记 REMOVE，最终状态为 add 序列推断；③ 接管后当前快照 user_tags 100% 缺失，全程依赖历史重建；④ after cohort 4,403 / speech 668，子集偏小。<b>置信度</b>：方向性结论（接管后更准）= 高；具体幅度（+6.8pp）= 中等。</div>
</section>

<footer>生成方式 scripts/build_html_report.py · 数据 scripts/report_data.json · 可复现<br>Vizion Lab SEM Evaluation · 2026-08-06</footer>
</div>

<script>
const DATA = __DATA__;
const PAL = ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#4a3aa7","#e34948"];
const PAL_D = ["#3987e5","#d95926","#199e70","#c98500","#d55181","#008300","#9085e9","#e66767"];
function p(){return document.documentElement.getAttribute("data-theme")==="dark"||(document.documentElement.getAttribute("data-theme")!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches)?PAL_D:PAL}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
function base(){return{backgroundColor:"transparent",textStyle:{color:css("--primary")},color:p()}}

// theme
function setTheme(t){document.documentElement.removeAttribute("data-theme");if(t!=="auto")document.documentElement.setAttribute("data-theme",t);
["auto","light","dark"].forEach(x=>document.getElementById("tb-"+x).classList.toggle("on",x===t));location.hash="theme="+t;rerender()}
if(location.hash.includes("theme=")){const t=location.hash.split("theme=")[1].split("&")[0];if(["auto","light","dark"].includes(t))setTheme(t)}
else document.getElementById("tb-auto").classList.add("on");

// ===== KPI cards =====
function kpiCard(l,v,d,cls){return`<div class="card"><div class="lbl">${l}</div><div class="val">${v}</div><div class="delta ${cls||''}">${d||''}</div></div>`}
(function(){
const b=DATA.overall.before,a=DATA.overall.after;
const accDelta=(a.accuracy-b.accuracy);
document.getElementById("kpis").innerHTML=
 kpiCard("接管后准确率",a.accuracy+"%",(accDelta>=0?"+":"")+accDelta.toFixed(1)+"pp vs 接管前","up")
+kpiCard("接管后变更率",a.change_rate+"%",(a.change_rate-b.change_rate).toFixed(1)+"pp","down")
+kpiCard("SH 漏判率",a.sh_flip+"%",(a.sh_flip-b.sh_flip).toFixed(1)+"pp","up")
+kpiCard("样本量(接管后)",a.n,"接管前 "+b.n,"tag")
+kpiCard("Speech 过判(after)",DATA.speech.after.bi_over,"漏判 "+DATA.speech.after.bi_under,"down")
+kpiCard("02→01 回退(7月)",DATA.fallback.monthly.find(m=>m.m==="2026-07")?.n||"—","接管后上升","down");
})();

// ===== charts =====
let charts=[];
function mk(id,opt){const el=document.getElementById(id);if(!el)return;const c=echarts.init(el);c.setOption(opt);charts.push(c)}

function accChart(){
const b=DATA.overall.before,a=DATA.overall.after;
mk("c-acc",Object.assign(base(),{tooltip:{trigger:"axis"},legend:{data:["准确率(未变更)","变更率(不准确)"],bottom:0,textStyle:{color:css("--secondary")}},
grid:{left:50,right:30,top:30,bottom:50},
xAxis:{type:"category",data:["接管前(人工)","接管后(SEM自动)"],axisLine:{lineStyle:{color:css("--baseline")}},axisLabel:{color:css("--secondary")}},
yAxis:{type:"value",max:70,axisLabel:{color:css("--secondary"),formatter:"{value}%"},splitLine:{lineStyle:{color:css("--grid")}}},
series:[
 {name:"准确率(未变更)",type:"bar",data:[b.accuracy,a.accuracy],itemStyle:{color:p()[2],borderRadius:[4,4,0,0]},barWidth:54,label:{show:true,position:"top",formatter:"{c}%",color:css("--primary")}},
 {name:"变更率(不准确)",type:"bar",data:[b.change_rate,a.change_rate],itemStyle:{color:p()[7],borderRadius:[4,4,0,0]},barWidth:54,label:{show:true,position:"top",formatter:"{c}%",color:css("--primary")}}
]}));
}

function fieldChart(){
const b=DATA.overall.before,a=DATA.overall.after;
const cats=["Matrix 重新评级","BI 等级变更","分类集合变更","SH Candidate 翻转"];
mk("c-field",Object.assign(base(),{tooltip:{trigger:"axis",axisPointer:{type:"shadow"}},
legend:{data:["接管前","接管后"],bottom:0,textStyle:{color:css("--secondary")}},
grid:{left:90,right:30,top:20,bottom:50},
xAxis:{type:"value",axisLabel:{color:css("--secondary"),formatter:"{value}%"},splitLine:{lineStyle:{color:css("--grid")}}},
yAxis:{type:"category",data:cats,axisLine:{lineStyle:{color:css("--baseline")}},axisLabel:{color:css("--secondary")}},
series:[
 {name:"接管前",type:"bar",data:[b.matrix_re,b.bi_change,b.rc_change,b.sh_flip],itemStyle:{color:p()[0],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}},
 {name:"接管后",type:"bar",data:[a.matrix_re,a.bi_change,a.rc_change,a.sh_flip],itemStyle:{color:p()[1],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}}
]}));
}

function dirCharts(){
const b=DATA.overall.before,a=DATA.overall.after;
mk("c-bidir",Object.assign(base(),{title:{text:"BI 误判方向（数量）",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
tooltip:{trigger:"axis"},legend:{data:["漏判(升级)","过判(降级)"],bottom:0,textStyle:{color:css("--secondary")}},
grid:{left:50,right:20,top:40,bottom:50},xAxis:{type:"category",data:["接管前","接管后"],axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
yAxis:{type:"value",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
series:[{name:"漏判(升级)",type:"bar",data:[b.bi_under,a.bi_under],itemStyle:{color:p()[0],borderRadius:[4,4,0,0]},barWidth:40},
 {name:"过判(降级)",type:"bar",data:[b.bi_over,a.bi_over],itemStyle:{color:p()[1],borderRadius:[4,4,0,0]},barWidth:40}]}));
mk("c-sh",Object.assign(base(),{title:{text:"Showstopper 漏判（SH 新增）",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
tooltip:{trigger:"axis"},grid:{left:50,right:20,top:40,bottom:30},xAxis:{type:"category",data:["接管前","接管后"],axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
yAxis:{type:"value",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
series:[{type:"bar",data:[b.sh_under,a.sh_under],itemStyle:{color:p()[7],borderRadius:[4,4,0,0]},barWidth:48,label:{show:true,position:"top",color:css("--primary")}}]}));
const rows=`<tr><th>指标</th><th class="num">接管前</th><th class="num">接管后</th></tr>
<tr><td>BI 漏判(升级)</td><td class="num">${b.bi_under}</td><td class="num">${a.bi_under}</td></tr>
<tr><td>BI 过判(降级)</td><td class="num">${b.bi_over}</td><td class="num">${a.bi_over}</td></tr>
<tr><td>SH 漏判(新增)</td><td class="num">${b.sh_under}</td><td class="num">${a.sh_under}</td></tr>
<tr><td>SH 过判(移除)</td><td class="num">${b.sh_over}</td><td class="num">${a.sh_over}</td></tr>`;
document.getElementById("t-dir").innerHTML=rows;
}

function dimChart(dim){
let rows;
if(dim==="matrix_cat") rows=DATA.matrix_cat.map(d=>({name:"Cat "+d.cat,b:d.b,a:d.a}));
else rows=DATA.breakdowns[dim].map(d=>({name:d.cat,b:d.b,a:d.a})).filter(r=>r.b.n>0||r.a.n>0).slice(0,10);
const maxn=Math.max(...rows.flatMap(r=>[r.b.n,r.a.n]));
mk("c-dim",Object.assign(base(),{tooltip:{trigger:"axis",axisPointer:{type:"shadow"},formatter:p=>{
 const r=rows[p[0].dataIndex];return `${r.name}<br>接管前: ${r.b.accuracy}% (n=${r.b.n})<br>接管后: ${r.a.accuracy}% (n=${r.a.n})`}},
legend:{data:["接管前准确率","接管后准确率"],bottom:0,textStyle:{color:css("--secondary")}},
grid:{left:120,right:40,top:20,bottom:50},
xAxis:{type:"value",max:100,axisLabel:{color:css("--secondary"),formatter:"{value}%"},splitLine:{lineStyle:{color:css("--grid")}}},
yAxis:{type:"category",data:rows.map(r=>r.name),axisLine:{lineStyle:{color:css("--baseline")}},axisLabel:{color:css("--secondary")}},
series:[
 {name:"接管前准确率",type:"bar",data:rows.map(r=>r.b.accuracy),itemStyle:{color:p()[0],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}},
 {name:"接管后准确率",type:"bar",data:rows.map(r=>r.a.accuracy),itemStyle:{color:p()[2],borderRadius:[0,4,4,0]},label:{show:true,position:"right",formatter:"{c}%",color:css("--primary")}}
]}));
}

function speechCharts(){
const b=DATA.speech.before,a=DATA.speech.after;
mk("c-speech-dir",Object.assign(base(),{title:{text:"Speech: BI 误判方向",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
tooltip:{trigger:"axis"},legend:{data:["漏判","过判"],bottom:0,textStyle:{color:css("--secondary")}},
grid:{left:50,right:20,top:40,bottom:50},xAxis:{type:"category",data:["接管前","接管后"],axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
yAxis:{type:"value",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
series:[{name:"漏判",type:"bar",data:[b.bi_under,a.bi_under],itemStyle:{color:p()[0],borderRadius:[4,4,0,0]},barWidth:40},
 {name:"过判",type:"bar",data:[b.bi_over,a.bi_over],itemStyle:{color:p()[1],borderRadius:[4,4,0,0]},barWidth:40}]}));
// heatmap
const g=DATA.speech.grid_after;
const occs=["E","D","C","B","A"];
const heatData=[];
g.forEach(row=>{row.vals.forEach(v=>{heatData.push([occs.indexOf(v.occ),4-parseInt(row.cat)-1,v.n])})});
const maxn=Math.max(...heatData.map(d=>d[2]));
mk("c-speech-grid",Object.assign(base(),{title:{text:"接管后 Matrix 分布 (Cat×Occ)",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
tooltip:{formatter:p=>`Cat ${4-p.value[1]} / Occ ${occs[p.value[0]]}<br>${p.value[2]} 张`},
grid:{left:50,right:30,top:40,bottom:40},
xAxis:{type:"category",data:occs,name:"Occurrence",nameLocation:"middle",nameGap:25,axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
yAxis:{type:"category",data:["4","3","2","1"],name:"Category",nameLocation:"middle",nameGap:25,axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
visualMap:{min:0,max:maxn,calculable:false,orient:"horizontal",left:"center",bottom:0,
 textStyle:{color:css("--secondary")},inRange:{color:[css("--div-neutral"),p()[1]]}},
series:[{type:"heatmap",data:heatData,label:{show:true,color:css("--primary")},emphasis:{itemStyle:{shadowBlur:10}}}]}));
const oc=DATA.speech.over_by_cat,oo=DATA.speech.over_by_occ;
document.getElementById("t-speech-over").innerHTML=
`<table><tr><th>过判 by Matrix Category</th>${"1234".split("").map(c=>`<th class="num">Cat ${c}</th>`).join("")}</tr>
<tr><td>票数</td>${"1234".split("").map(c=>`<td class="num">${oc[c]}</td>`).join("")}</tr></table>
<table style="margin-top:8px"><tr><th>过判 by Occurrence</th>${"EDCBA".split("").map(c=>`<th class="num">${c}</th>`).join("")}</tr>
<tr><td>票数</td>${"EDCBA".split("").map(c=>`<td class="num">${oo[c]}</td>`).join("")}</tr></table>`;
}

function fallbackCharts(){
const ms=DATA.fallback.monthly;
mk("c-fb-trend",Object.assign(base(),{tooltip:{trigger:"axis"},grid:{left:50,right:20,top:20,bottom:30},
xAxis:{type:"category",data:ms.map(m=>m.m),axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
yAxis:{type:"value",name:"02→01 次数",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
series:[{type:"line",data:ms.map(m=>m.n),smooth:true,symbolSize:7,itemStyle:{color:p()[1]},areaStyle:{color:p()[1],opacity:0.12},
 markLine:{data:[{xAxis:"2026-06"}],lineStyle:{color:css("--s4"===""?"":p()[4]),type:"dashed"},label:{formatter:"接管 6/29",color:css("--secondary")}}}]}));
const ba=DATA.fallback.before_acc,aa=DATA.fallback.after_acc;
mk("c-fb-acc",Object.assign(base(),{title:{text:"回退票变更率 vs 全样本",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
tooltip:{trigger:"axis"},grid:{left:50,right:20,top:40,bottom:30},xAxis:{type:"category",data:["接管前全样本","接管前回退票","接管后全样本","接管后回退票"],axisLabel:{color:css("--secondary"),fontSize:10},axisLine:{lineStyle:{color:css("--baseline")}}},
yAxis:{type:"value",max:70,axisLabel:{color:css("--secondary"),formatter:"{value}%"},splitLine:{lineStyle:{color:css("--grid")}}},
series:[{type:"bar",data:[44.5,ba.change_rate,37.7,aa.change_rate],itemStyle:{color:p()[7],borderRadius:[4,4,0,0]},barWidth:34,label:{show:true,position:"top",formatter:"{c}%",color:css("--primary")}}]}));
mk("c-fb-dir",Object.assign(base(),{title:{text:"回退票误判方向",left:"center",textStyle:{color:css("--secondary"),fontSize:13,fontWeight:400}},
tooltip:{trigger:"axis"},legend:{data:["漏判","过判"],bottom:0,textStyle:{color:css("--secondary")}},grid:{left:50,right:20,top:40,bottom:50},xAxis:{type:"category",data:["接管前","接管后"],axisLabel:{color:css("--secondary")},axisLine:{lineStyle:{color:css("--baseline")}}},
yAxis:{type:"value",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
series:[{name:"漏判",type:"bar",data:[ba.bi_under,aa.bi_under],itemStyle:{color:p()[0],borderRadius:[4,4,0,0]},barWidth:40},
 {name:"过判",type:"bar",data:[ba.bi_over,aa.bi_over],itemStyle:{color:p()[1],borderRadius:[4,4,0,0]},barWidth:40}]}));
}

function kwChart(id,kw){
mk(id,Object.assign(base(),{tooltip:{},grid:{left:90,right:30,top:10,bottom:20},
xAxis:{type:"value",axisLabel:{color:css("--secondary")},splitLine:{lineStyle:{color:css("--grid")}}},
yAxis:{type:"category",data:kw.top.map(t=>t.k),axisLine:{lineStyle:{color:css("--baseline")}},axisLabel:{color:css("--secondary")}},
series:[{type:"bar",data:kw.top.map(t=>t.n),itemStyle:{color:p()[0],borderRadius:[0,4,4,0]},label:{show:true,position:"right",color:css("--primary")}}]}));
}

// ===== tickets =====
function flow(b,c,label){return `<span class="b">${b}</span><span class="arr">→</span><span class="b">${c}</span> <span class="chip tag">${label}</span>`}
function ticketHtml(t){
const biDir = t.bi_dir ? (t.bi_dir.includes("upgraded")?"<span class='chip under'>BI 漏判↑</span>":"<span class='chip over'>BI 过判↓</span>"):"";
const shDir = t.sh_added?"<span class='chip under'>SH 漏判</span>":(t.sh_removed?"<span class='chip over'>SH 过判</span>":"");
const tagChip = {"speech-overjudge":`<span class='chip over'>Speech 过判</span>`,"speech-underjudge":`<span class='chip under'>Speech 漏判</span>`,"SH-underjudge-before":`<span class='chip under'>SH 漏判</span>`,"02-01-fallback-after":`<span class='chip tag'>02→01 回退</span>`}[t.tag]||`<span class='chip tag'>${t.tag}</span>`;
const cmts = t.comments.map(c=>`<div class="cmt ${c.is_sem?'sem':''}"><span class="au">${c.is_sem?'🤖 ':''}${c.author}</span><span class="ts">${c.ts}</span><div class="tx">${escapeHtml(c.text)}</div></div>`).join("");
return `<div class="ticket">
 <div class="tn">#${t.did} · <a href="https://octane-prod.bmwgroup.net/ui/entity?p=1002/2002&entityType=work_item&id=${t.did}" target="_blank">Octane ↗</a></div>
 <div class="meta">${escapeHtml(t.name)} · ${t.team} · ${t.prob_cat||"—"} · ${t.severity||"—"} · ${t.phase||"—"} · 创建 ${t.created||"—"} · 评论 ${t.n_comments}</div>
 <div class="flow">Matrix: ${flow(t.init_matrix,t.final_matrix,t.init_matrix===t.final_matrix?"未变":"已重评")} · BI: ${flow(t.init_bi+" "+(t.init_bi_name||"").slice(0,3),t.final_bi+" "+(t.final_bi_name||"").slice(0,3),"")} ${biDir}${shDir}</div>
 <div class="meta">分类: ${t.init_rc.join(", ")||"—"} → ${t.final_rc.join(", ")||"—"} · SH: ${t.init_sh?"✓":"✗"}→${t.final_sh?"✓":"✗"} · 组别: ${t.group==="after"?"接管后(SEM自动)":"接管前(人工)"} · ${t.reached_03?"✓经过 Phase03":"✗未到Phase03"}</div>
 ${cmts||"<div class='meta'>无相关评论</div>"}
</div>`}
function escapeHtml(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

function renderTickets(){
const tag=document.getElementById("flt-tag").value;
const grp=document.getElementById("flt-group").value;
const q=document.getElementById("flt-search").value.toLowerCase();
let ex=DATA.examples.filter(t=>{
 if(tag&&t.tag!==tag)return false;
 if(grp&&t.group!==grp)return false;
 if(q&&!(t.did.includes(q)||t.name.toLowerCase().includes(q)||t.comments.some(c=>c.text.toLowerCase().includes(q))))return false;
 return true});
document.getElementById("tickets").innerHTML=ex.map(ticketHtml).join("")||"<div class='meta'>无匹配 ticket</div>"}
// populate filter
(function(){const tags=[...new Set(DATA.examples.map(t=>t.tag))];const sel=document.getElementById("flt-tag");
tags.forEach(t=>{const o=document.createElement("option");o.value=t;o.textContent=t;sel.appendChild(o)})})();
document.getElementById("flt-tag").onchange=renderTickets;
document.getElementById("flt-group").onchange=renderTickets;
document.getElementById("flt-search").oninput=renderTickets;

// ===== prompts =====
const PROMPTS=[
 {t:"A · Occurrence 证据优先（缺证降级）",r:"speech Occ A 过判 24/53",b:`<b>【Speech 缺陷 Occurrence 评定规则（从严证据）】</b>
对 problem_category / solution_cluster 含 "Speech / IPA / Voice / 语音 / ASR / TTS / NLP" 的缺陷，Occurrence 评级必须基于显式复现证据：
• 评 A（持续/明确可复现）：须有 ≥2 个 Lifecycle 中"相同复现步骤 + 明确规律"的记录，或日志/视频证明"在 ≥2 个 LC 中按已知规律复现且持续 >2s"。
• 评 B（短暂可复现）：须有 ≥2 个 LC 的复现记录且每次 <2s。
• 仅 1 个 LC 内多次但无规律 → 只能评 D，不得评 A/B。
• 仅报告"有时发生/intermittent"而无复现步骤 → 评 D，不得评 C 以上。
• 缺复现步骤、复现次数、涉及 LC 数、持续时间中任一项 → Occurrence 不得高于 D，并标注 ==Insufficient confidence==。
禁止依据"always/often/permanently 等强语气词"直接评 A。`},
 {t:"B · Category 对 speech 功能的保守映射",r:"Cat 2/3 过判 43/53",b:`<b>【Speech 缺陷 Category 评定规则】</b>
• 仅当"语音核心入口完全无法使用"（唤醒词无响应、指令 100% 失败、TTS 完全无声）且无替代路径 → Cat 1。
• "语音功能可用但受限/可恢复"（识别率下降、个别指令失败、可手动替代、重试/重启后恢复）→ 一律 Cat 3，不得 Cat 1/2。
• 语音与"网络/在线服务"耦合的缺陷：若根因为网络/后端而非语音本身 → Category 不得高于 3，注明"依赖网络/后端"。
• 涉及 HUD/App/视频等被语音间接触发的次生问题：按"受影响功能"而非"触发入口"判 Category，不得仅因涉及 HUD 就升 Cat 1。
• 拼写/翻译/措辞/口音识别偏差但不影响功能可用 → Cat 4。`},
 {t:"C · Matrix→BI 映射对齐人工共识（修正偏严）",r:"26/53 Matrix 正确但 BI 偏严",b:`<b>【Speech 缺陷 BI 映射校准】</b>
对 speech 缺陷，Matrix 落在以下格子时采用人工共识 BI（而非默认偏严值）：
• 3C / 3D / 3E → BI-07 / No-SH（功能受限但可恢复，关闭；勿给 BI-06）。
• 3B → 人工判断区，缺复现证据时默认 BI-07。
• 2E / 2D → BI-06 / No-SH（继续但不设 SH）。
仅 3A 持续受限、1x/2C/2B/2A 高频 → 给 BI-06；1x → ≤BI-5 + SH。
不确定 → 默认取更宽松 BI，写明"speech BI 校准：默认降一档，待 Q-Gate 确认"。`},
 {t:"D · 不确定时收敛到保守评分",r:"SEM 标 ==Insufficient confidence== 仍给 Cat 1C",b:`<b>【不确定收敛规则】</b>
当 "Found in Function" 为 ==Insufficient confidence==，或 Missing topics 非空，或缺少复现证据时：
• Matrix Score 一律按"保守一档"输出：Category 上调 +1（更轻）、Occurrence 下调一档，整体再向轻收敛一档。
• 不得在标注不确定的同时输出 Cat 1 或 Occ A，除非有显式安全/法规证据。
• 评论中必须输出"评分假设"与"需 Problem Finder 补充的信息"（复现步骤、LC 数、持续时间、设备/软件版本）。`},
 {t:"E · 重复票关联时 Occurrence 重评",r:"speech 过判多与重复票 occurrence 变化相关",b:`<b>【重复票关联时的 Occurrence 重评】</b>
当 Duplicate candidates 命中且关联到 Master/重复票时：
• 不得沿用单票 Occurrence；须按"合并后涉及的总 LC 数 + 总发生次数"重新评估。
• 若重复票使发生范围扩大但仍无规律 → 升 Occurrence 至 D/C（非 A）。
• 若重复票显示仅单次/单 LC → 维持 E/D。
• 评论注明"已按 N 个关联票合并评估 Occurrence"。`}
];
document.getElementById("prompts").innerHTML=PROMPTS.map(p=>`<div class="prompt"><b>${p.t}</b><br><span style="color:var(--s8)">根因：${p.r}</span><br>${p.b}</div>`).join("");

// ===== conclusion =====
(function(){
const b=DATA.overall.before,a=DATA.overall.after;
document.getElementById("conclusion-kpis").innerHTML=
`<div><div class="k">方向性结论</div><div class="v up">接管后更准 ✓</div></div>
 <div><div class="k">准确率提升</div><div class="v">+6.8pp</div></div>
 <div><div class="k">显著性 p</div><div class="v">≈1e-17</div></div>
 <div><div class="k">置信度</div><div class="v">中等偏高</div></div>
 <div><div class="k">最大改善</div><div class="v">SH 漏判 -12pp</div></div>`;
document.getElementById("t-conclusion").innerHTML=
`<tr><th>结论</th><th>证据</th><th>置信度</th></tr>
<tr><td>SEM 自动接管后初始判断更准确</td><td>55.5%→62.3%, z=-8.54, p≈1e-17</td><td><span class="chip ok">高</span></td></tr>
<tr><td>主要驱动力是 SH 漏判率下降</td><td>25.1%→13.2% (-11.9pp)</td><td><span class="chip ok">高</span></td></tr>
<tr><td>Speech 是唯一系统性偏高的品类</td><td>过判53&gt;漏判35, Occ A 集中过判</td><td><span class="chip" style="background:rgba(237,161,0,.16);color:var(--s4)">中等</span></td></tr>
<tr><td>回退票是准确率洼地</td><td>回退票变更率58.3% vs 全样本37.7%</td><td><span class="chip" style="background:rgba(237,161,0,.16);color:var(--s4)">中等</span></td></tr>
<tr><td>具体幅度+6.8pp可能偏高</td><td>成熟度偏差(18月vs5周)</td><td><span class="chip over">需谨慎</span></td></tr>`;
})();

// ===== render & resize =====
let curDim="matrix_cat";
function rerender(){
charts.forEach(c=>c.dispose());charts=[];
accChart();fieldChart();dirCharts();dimChart(curDim);speechCharts();fallbackCharts();
kwChart("c-kw-under",DATA.comment_kw.sh_under);kwChart("c-kw-over",DATA.comment_kw.speech_over);
renderTickets();
}
document.querySelectorAll("#dimtabs button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#dimtabs button").forEach(x=>x.classList.remove("on"));b.classList.add("on");curDim=b.dataset.dim;
// re-render just dim chart
const el=document.getElementById("c-dim");const old=echarts.getInstanceByDom(el);if(old)old.dispose();dimChart(curDim)});
window.addEventListener("resize",()=>charts.forEach(c=>c.resize()));
rerender();
</script>
</body></html>"""

html = HTML.replace("__DATA__", json.dumps(DATA, ensure_ascii=False))
OUT.write_text(html, encoding="utf-8")
print(f"Report written: {OUT}  ({len(html)/1024:.0f} KB)")
