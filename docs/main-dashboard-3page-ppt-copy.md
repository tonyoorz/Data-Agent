# Main Dashboard 3-Page PPT Copy

## English Version

### Slide 1: Main Dashboard Overview

**Subtitle**

Integrate issue scale, processing outcomes, team performance, and ticket details into one decision interface.

**Slide Copy**

- Main Dashboard is the core landing page of the DTSV quality analytics platform, designed to provide a unified management view rather than a single chart page.
- It consolidates the key elements of quality management into one place: issue scope, processing outcomes, responsible teams, and ticket-level details.
- Users can quickly understand the current quality picture by first looking at the overall scope, then the outcome distribution, and finally the team-level differences.
- Compared with scattered reporting or switching across multiple systems, Main Dashboard turns fragmented information into a single, consistent decision surface.

**Speaker Notes**

Main Dashboard can be understood as the management homepage for quality analysis. Its main value is not just showing data, but connecting the full chain from overall status to specific tickets. For managers, this means they can see the current quality picture in one place. For analysts, it reduces the time spent collecting and reconciling information from different sources.

### Slide 2: Technical Principle

**Subtitle**

Frontend dashboard, local analytics service, and snapshot-based data serving work together as one system.

**Slide Copy**

- The architecture is built in three layers: React frontend for interaction, local FastAPI analytics service for aggregation, and SQLite-based source and hot databases for serving.
- Raw data comes from QGate and Octane, including defects, history events, and related test data, then flows through local analytics processing before being exposed to the dashboard.
- The system first loads a summary view and then loads paged ticket details under the same snapshot version, ensuring KPI cards, team analysis, and detail tables all use the same data scope.
- Frontend and backend share the same business vocabulary, while the frontend adapter converts raw payloads into a stable view model, making the dashboard easier to evolve without changing business meaning.
- This design is important because Full Picture data is large and refreshed over time; snapshot-based serving makes the page more consistent, comparable, and reliable for management use.

**Speaker Notes**

The key point here is data consistency. This dashboard is not a simple front-end page that reads a file and renders it. It is a complete serving chain. The backend prepares and aggregates the data, publishes snapshot versions, and the frontend reads summary and details from the same snapshot. So when leadership sees a KPI card and then drills down to tickets, the numbers still match. That is the basis for trustworthy analysis.

### Slide 3: Usage and Business Benefit

**Subtitle**

Support a natural workflow from management overview to execution follow-up.

**Slide Copy**

- The user flow is straightforward: first view the overall scope and outcome distribution, then click into a specific outcome or team, and finally land on the exact tickets that require follow-up.
- Main Dashboard supports layered analysis: overview for management, team comparison for ownership judgment, and detail table for execution tracking.
- For managers, the value is faster identification of risk areas, abnormal teams, and high-priority problem clusters.
- For analysts, the value is lower manual reporting effort and faster transition from data collection to real judgment and root-cause analysis.
- For execution teams, the value is clearer ownership and a shorter path from dashboard insight to ticket-level action.
- Overall, the dashboard improves three business outcomes: faster decision-making, smoother cross-team communication, and stronger issue closure efficiency.

**Speaker Notes**

In practice, this page supports a very natural rhythm. First, look at the overall situation. Second, identify which outcome or which team needs attention. Third, go directly to ticket-level details and continue follow-up. That means the dashboard is not only for display. It is a working surface for decision, coordination, and execution. Its business value is that it shortens the path from finding a problem to pushing the problem toward closure.

## 中文版

### 第 1 页：Main Dashboard 是什么

**副标题**

把问题规模、处理结果、团队表现和工单明细，集中到同一个管理入口。

**页面文案**

- Main Dashboard 是 DTSV 质量分析平台的核心首页，定位不是单一图表页，而是一张统一的质量管理总览图。
- 它把质量管理中最关键的几个维度集中起来：问题范围、处理结果、责任团队和 ticket 明细。
- 用户进入页面后，可以先看到当前质量全貌，再逐步识别重点结果、重点团队和重点问题。
- 相比过去分散看报表、切换多个系统，这个页面把碎片化信息收敛成一个一致的决策界面。

**讲稿**

这一页想表达的是，Main Dashboard 不是一个单纯展示数字的页面，而是质量管理的统一入口。它的价值在于把原来分散的信息整合成一张图，让管理者、分析人员和执行团队都可以在同一个界面里看同一套结果。

### 第 2 页：技术原理

**副标题**

前端看板、本地分析服务和快照数据服务三层协同。

**页面文案**

- 系统整体采用三层架构：React 前端负责交互展示，本地 FastAPI analytics 服务负责聚合计算，SQLite source 和 hot 数据库负责数据承载与服务。
- 底层原始数据来自 QGate / Octane，包括 defect、history event 和相关测试数据，经过本地分析处理后形成 dashboard 可直接使用的数据结果。
- 页面先加载 summary 概览，再在同一 snapshot version 下加载分页 tickets，保证卡片、团队分析和明细表使用的是同一口径。
- 前后端保留 Full Picture 的业务语义，但由前端 adapter 统一转换成标准视图模型，既能复用原有数据语义，也方便后续演进。
- 这套设计的重点不只是把数据展示出来，而是保证数据在刷新和下钻过程中仍然一致、可比、可追溯。

**讲稿**

这一页最重要的是说明，Main Dashboard 背后不是简单的页面拼接，而是一整条数据服务链路。通过 snapshot 机制，管理层从总览下钻到 ticket 的过程中，看到的仍然是同一套数据口径，这也是它能够支撑管理决策的基础。

### 第 3 页：使用方式与业务收益

**副标题**

支持从全局判断，到责任识别，再到 ticket 跟进的完整工作路径。

**页面文案**

- 使用流程非常直接：先看总体 scope 和 outcome，再点击某个结果或某个 team 下钻，最后定位到具体 ticket 做后续跟进。
- 页面天然支持分层分析：总览层面帮助管理判断，团队层面帮助识别责任边界，明细层面支撑执行跟踪。
- 对管理层，价值在于更快识别高风险区域、异常团队和重点问题簇。
- 对分析人员，价值在于减少手工汇总和跨系统对账时间，把更多精力放在判断和分析上。
- 对执行团队，价值在于更清晰地接住具体问题，缩短从看板洞察到 ticket 行动的链路。
- 业务层面的核心收益可以概括为三点：决策更快、沟通更顺、闭环更强。

**讲稿**

Main Dashboard 的真正价值，在于它把看数据变成了推动问题解决的过程。管理层可以快速判断风险，分析人员可以更快定位问题，执行团队可以直接拿到 ticket 去推动闭环。所以它既是一个展示入口，也是一个协同和执行入口。
