## 结构层 - Defect

**数据表**: octane_defects

**主键**: defect_id

### 字段结构

- **defect_id**: string
- **name**: string
- **project**: enum
- **market**: string
- **pu**: string
- **fv**: string
- **fvp**: string
- **team**: string
- **lead_model**: string
- **status_phase**: enum
- **severity**: enum
- **assigned_ecu**: string
- **problem_finder_team**: string
- **top_aida**: string
- **aida_english**: string
- **aida_businesskey**: string
- **phase**: string
- **solution_cluster**: string
- **year**: string
- **requirement**: string[]
- **raw_json**: json
- **creation_time**: datetime
- **last_modified**: datetime
- **fetched_at**: datetime

## 语义层 - Defect

### defect_id

**含义**: Octane 缺陷唯一ID

### name

**含义**: 缺陷标题/描述

### project

**含义**: 项目代号

**取值**: IDCEVO, IDC, MGU, RSU, App

**别名**:

- IDCEVO: idcevo, IDCEVO*, CDE, ENTRYEVO, NBTEVO

- IDC: idc, IDC23, HU-MGU_02_A

- MGU: mgu, MGU22, BMWMGU

- RSU: rsu, Remote_Software_Update

- App: app, Application, Phone_App

**分类**:

- china: IDCEVO, IDC, MGU

- global: RSU, App

### market

**含义**: 市场区域

**取值**: CN, GLOBAL, APAC, EU, NA

**别名**:

- CN: china, 中国, cn

- GLOBAL: global, 全球, intl

- APAC: apac, 亚太

- EU: eu, 欧洲

- NA: na, 北美

### pu

**含义**: 产品单元

### fv

**含义**: 功能版本

### fvp

**含义**: 功能版本计划

### team

**含义**: 负责团队

### lead_model

**含义**: 主导车型

### status_phase

**含义**: 缺陷处理阶段

**取值**: New, Open, In Progress, Fixed, Closed, Rejected, Deferred

**分类**:

- active: New, Open, In Progress

- resolved: Fixed, Closed

- excluded: Rejected, Deferred

**语义说明**:

- New: 新建缺陷，未开始处理

- Open: 已指派处理人，正在分析

- In Progress: 正在修复或解决方案验证中

- Fixed: 已修复，等待验证

- Closed: 已验证通过，问题解决

- Rejected: 不符合缺陷定义，拒绝处理

- Deferred: 计划性延后处理

### severity

**含义**: 严重程度

**取值**: Critical, Major, Minor, Cosmetic

**语义说明**:

- Critical: 安全相关/法规不满足/功能完全丧失，必须立即处理

- Major: 功能降级，影响用户使用体验

- Minor: 功能异常但可绕过，或体验问题

- Cosmetic: 外观/文案问题，不影响功能

### assigned_ecu

**含义**: 指派的电子控制单元

**别名**:

- BCM: Body_Control_Module, 车身控制器, 车身模块

- VCU: Vehicle_Control_Unit, 整车控制器

- MCU: Motor_Control_Unit, 电机控制器

- BMS: Battery_Management_System, 电池管理系统

- ADAS: Advanced_Driver_Assistance_Systems, 高级驾驶辅助

- IHU: In-Vehicle_Human_Machine_Interface, 车载人机交互

### problem_finder_team

**含义**: 问题发现团队

### top_aida

**含义**: AIDA 功能域（一级）

**别名**:

- ent_and_con_cn: content, 内容, 娱乐

- cn_navigation: navigation, 导航, nav

- cn_speech: speech, 语音

- cn_media: media, 媒体

### aida_english

**含义**: AIDA 功能域英文名称

### aida_businesskey

**含义**: AIDA 业务键

### phase

**含义**: 测试阶段

**分类**:

- q_gate: 02, 07

- integration: 00, 01, 06, 08, 09

- coc: 03, 04, 05

**语义说明**:

- 00: Development phase

- 01: Early Integration

- 02: Q-Gate 1

- 03: CoC 1

- 04: CoC 2

- 05: CoC 3

- 06: Q-Gate 2

- 07: Q-Gate 3

- 08: Pre-production

- 09: Production

### solution_cluster

**含义**: 解决方案聚类

**分类**:

- china: solution cluster:china product, ipa cn, speech cn, navigation cn, ent_and_con cn, navigation twn, etc jp

### year

**含义**: 年份

### requirement

**含义**: 关联的需求

### raw_json

**含义**: Octane 原始 JSON 数据

### creation_time

**含义**: 缺陷创建时间（用于趋势分析）

### last_modified

**含义**: 最后修改时间

### fetched_at

**含义**: 数据抓取时间


## 业务层 - Defect

### 计算指标

- **active_defect_count**: 活跃缺陷数（未关闭）
  - 计算: COUNT(*) WHERE status_phase IN ('New', 'Open', 'In Progress')

- **critical_defect_count**: 未关闭的 Critical 缺陷数
  - 计算: COUNT(*) WHERE severity = 'Critical' AND status_phase IN ('New', 'Open', 'In Progress')

- **defect_density**: 缺陷密度（每百用例缺陷数）
  - 计算: defect_count / test_case_count * 100

- **china_defect_count**: 中国区域缺陷数
  - 计算: COUNT(*) WHERE top_aida IN CHINA_SOLUTION_CLUSTERS OR market = 'CN'

- **q_gate_defect_count**: Q-Gate 阶段缺陷数
  - 计算: COUNT(*) WHERE phase IN ('02', '07')

- **coc_defect_count**: CoC 阶段缺陷数
  - 计算: COUNT(*) WHERE phase IN ('03', '04', '05')

### 业务规则提醒

根据你的问题，请注意以下业务规则:

- severity 是 Octane 原生字段（Critical/Major/Minor），matrix 是从 tags 提取的标签，不要混淆


## 操作层 - Defect

**禁止的操作**:

update、delete、insert

**默认时间范围**: 90 days

### 安全的 JOIN 路径

- **has_history** → DefectHistory
  - 关联: defect.defect_id = history.defect_id

- **tested_in_manual_run** → ManualRun
  - 关联: defect.defect_id = manual_run.defect_id

- **related_to_testcases** → TestCase
  - 关联: defect.defect_id = relations.related_id AND relations.relation_type = 'defect'

- **belongs_to_project** → Project
  - 关联: defect.project = project.name

- **found_by_team** → Team
  - 关联: defect.problem_finder_team = team.name


## 行为层 - Defect
