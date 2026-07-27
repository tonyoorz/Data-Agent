#!/usr/bin/env python3
"""
Ontology Enhancement Script
Based on 8 business documents analysis.
Updates: entities, dimensions, metrics, vocab, constraints, relationships, business_rules
"""
import json, os, copy
from datetime import datetime

BASE = "/Users/tonyorz/Data-Agent/ontology/v1/"
os.makedirs(BASE, exist_ok=True)

# Load all files
def load(name):
    with open(os.path.join(BASE, f"{name}.json"), encoding='utf-8') as f:
        return json.load(f)

def save(name, data):
    path = os.path.join(BASE, f"{name}.json")
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path

# ─── ENTITIES ────────────────────────────────────────────────────────────
def update_entities():
    data = load('entities')
    entities = data['entities']
    ent_map = {e['id']: e for e in entities}

    # 1. Add missing defect fields (from source_store.py vs ontology gap)
    defect = ent_map['quality.defect']
    existing = {p['id'] for p in defect['properties']}
    missing_defect_props = [
        {"id": "aida_businesskey", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "AIDA业务键", "en-US": "AIDA Business Key"},
         "description": "AIDA需求节点的业务标识键，用于跨系统追踪需求"},
        {"id": "aida_english", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "AIDA英文名", "en-US": "AIDA English Name"},
         "description": "AIDA需求节点的英文描述名"},
        {"id": "ecu_no_of_changes", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "ECU变更次数", "en-US": "ECU Number of Changes"},
         "description": "缺陷涉及的ECU变更次数"},
        {"id": "ecu_to_modul", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "ECU到模块映射", "en-US": "ECU to Module Mapping"},
         "description": "ECU到功能模块的映射关系"},
        {"id": "first_use_sop_of_function", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "功能首次SOP", "en-US": "First Use SOP of Function"},
         "description": "功能首次投入使用的SOP(Start of Production)里程碑"},
        {"id": "function2modul", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "功能到模块", "en-US": "Function to Module"},
         "description": "功能到软件模块的映射"},
        {"id": "function_responsible", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "功能负责人", "en-US": "Function Responsible"},
         "description": "负责该功能的开发人员(FO/Function Owner)"},
        {"id": "involved_i_step", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "涉及I-Step", "en-US": "Involved I-Step"},
         "description": "缺陷涉及的集成步骤(I-Step, 如I-420, I-450, I-490等)"},
        {"id": "problem_severity", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "问题严重度", "en-US": "Problem Severity"},
         "description": "Octane中独立于severity的问题严重度评级"},
        {"id": "program", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "项目程序", "en-US": "Program"},
         "description": "Octane中的项目程序字段，对于DTSV通常为IuK"},
        {"id": "relation_to", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "关联类型", "en-US": "Relation To"},
         "description": "父子缺陷的具体关联类型描述"},
        {"id": "reprel_changes", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "代表变更", "en-US": "Reprel Changes"},
         "description": "代表关系(Representative Release)的变更记录"},
        {"id": "requirement", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "需求", "en-US": "Requirement"},
         "description": "关联的Octane需求对象(Requirement Object)，用于附加标签"},
        {"id": "requirements_json", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "需求列表JSON", "en-US": "Requirements JSON"},
         "description": "关联的所有需求对象的JSON列表"},
        {"id": "solution_responsible", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "解决方案负责人", "en-US": "Solution Responsible"},
         "description": "负责解决该缺陷的人员或团队"},
        {"id": "status_phase", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "状态阶段", "en-US": "Status Phase"},
         "description": "Octane phase字段的原始值，包含阶段编号和名称"},
        {"id": "tolerated_count", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "容忍数量", "en-US": "Tolerated Count"},
         "description": "该缺陷可被容忍出现的次数"},
        {"id": "top_aida", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "顶级AIDA", "en-US": "Top AIDA"},
         "description": "缺陷关联的主要AIDA需求节点"},
        {"id": "tproject", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "测试项目", "en-US": "TProject"},
         "description": "Octane中的测试项目字段"},
    ]
    added_defect = 0
    for p in missing_defect_props:
        if p['id'] not in existing:
            defect['properties'].append(p)
            added_defect += 1

    # 2. Add missing test_run fields
    run = ent_map['testing.test_run']
    existing_r = {p['id'] for p in run['properties']}
    missing_run_props = [
        {"id": "author", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "创建者", "en-US": "Author"},
         "description": "测试执行的创建者(TMX用户)"},
        {"id": "exec_model_series", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "执行车型系列", "en-US": "Execution Model Series"},
         "description": "测试执行对应的车型系列"},
        {"id": "execution_sw_version", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "执行软件版本", "en-US": "Execution SW Version"},
         "description": "测试执行时的软件版本号"},
        {"id": "native_status", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "原始状态", "en-US": "Native Status"},
         "description": "Octane原始状态值(未经转换)"},
        {"id": "spec", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "规格", "en-US": "Spec"},
         "description": "测试执行的规格说明"},
        {"id": "set_field", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "SET字段", "en-US": "SET Field"},
         "description": "SET (System Engineering Test) 相关字段"},
        {"id": "taxonomies", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "分类标签", "en-US": "Taxonomies"},
         "description": "测试执行的分类标签，逗号分隔"},
        {"id": "test_version", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "测试版本", "en-US": "Test Version"},
         "description": "测试用例版本"},
        {"id": "testplatformid", "type": "string", "nullable": True, "sensitivity": "internal",
         "labels": {"zh-CN": "测试平台ID", "en-US": "Test Platform ID"},
         "description": "测试执行所在的平台标识符"},
    ]
    added_run = 0
    for p in missing_run_props:
        if p['id'] not in existing_r:
            run['properties'].append(p)
            added_run += 1

    # 3. Add new entities from documents
    new_entities = [
        {
            "id": "quality.maturity_grade",
            "version": "1.0.0",
            "labels": {"zh-CN": "成熟度等级", "en-US": "Maturity Grade (RG)"},
            "descriptions": {
                "zh-CN": "E/E成熟度等级模型(RG0-RG6)，衡量功能从开发到客户可用的成熟度。DTSV从RG4开始介入。",
                "en-US": "E/E maturity grade model (RG0-RG6). DTSV starts from RG4."
            },
            "aliases": ["RG", "Reifegrad", "maturity grade", "成熟度"],
            "source": {"sourceId": "analytics.beat", "system": "analytics", "readModel": "maturity_grades", "table": ""},
            "primaryKey": "function_id,rg_level",
            "sensitivity": "internal",
            "allowedOperations": ["read", "aggregate"],
            "properties": [
                {"id": "function_id", "type": "string", "nullable": False, "sensitivity": "internal",
                 "labels": {"zh-CN": "功能ID", "en-US": "Function ID"}},
                {"id": "rg_level", "type": "string", "nullable": False, "sensitivity": "internal",
                 "labels": {"zh-CN": "RG等级", "en-US": "RG Level"},
                 "description": "RG4=功能可测, RG5=功能完整(Green/Yellow/Red), RG6=客户可用(Showstopper-free)"},
                {"id": "rg_status", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "RG状态", "en-US": "RG Status"},
                 "description": "Green=达到, Yellow=部分达到, Red=未达到"},
                {"id": "fo_name", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "功能负责人", "en-US": "Function Owner (FO)"}},
                {"id": "measured_at", "type": "datetime", "nullable": True, "sensitivity": "internal"},
                {"id": "i_step", "type": "string", "nullable": True, "sensitivity": "internal",
                 "description": "对应I-Step (I-420, I-450, I-470, I-480, I-490等)"},
            ],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["BEAT_TopIssues", "CN_TestStrategy", "CN_Introduction"]
        },
        {
            "id": "organization.function_team_mapping",
            "version": "1.0.0",
            "labels": {"zh-CN": "功能团队映射", "en-US": "Function to Team Mapping"},
            "descriptions": {
                "zh-CN": "192条客户功能到DTSV团队的映射关系。用于缺陷自动分派和团队责任界定。",
                "en-US": "192 customer function to DTSV team mappings for defect routing."
            },
            "aliases": ["function mapping", "team mapping", "功能映射"],
            "source": {"sourceId": "analytics.team_mapping", "system": "analytics", "readModel": "function_team_mapping", "table": ""},
            "primaryKey": "function_name",
            "sensitivity": "internal",
            "allowedOperations": ["read", "aggregate"],
            "properties": [
                {"id": "function_name", "type": "string", "nullable": False, "sensitivity": "internal",
                 "labels": {"zh-CN": "功能名称", "en-US": "Function Name"}},
                {"id": "team", "type": "string", "nullable": False, "sensitivity": "internal",
                 "labels": {"zh-CN": "负责团队", "en-US": "Responsible Team"},
                 "description": "DTSV团队，如DIPS_TSP_Call_Services, DIPS_TSP_Car_Apps等"},
                {"id": "function_group", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "功能组", "en-US": "Function Group"},
                 "description": "功能分组: China specific, Call Services, Audio, Entertainment, AZV, InCar Apps等"},
            ],
            "governance": {"status": "approved", "owner": "DTSV Team"},
            "sourceDocuments": ["Testmanagement"]
        },
        {
            "id": "testing.test_event",
            "version": "1.0.0",
            "labels": {"zh-CN": "测试事件", "en-US": "Test Event"},
            "descriptions": {
                "zh-CN": "Release测试事件，对应Octane中的Feature。包含Release、SET、车型、国家容量规划等信息。",
                "en-US": "Release test event corresponding to Octane Feature, with capacity planning."
            },
            "aliases": ["test event", "release test", "SET", "测试事件"],
            "source": {"sourceId": "analytics.test_events", "system": "analytics", "readModel": "test_events", "table": ""},
            "primaryKey": "event_name",
            "sensitivity": "internal",
            "allowedOperations": ["read", "aggregate"],
            "properties": [
                {"id": "event_name", "type": "string", "nullable": False, "sensitivity": "internal",
                 "labels": {"zh-CN": "事件名称", "en-US": "Event Name"},
                 "description": "测试事件名称，也是Octane中Feature的名称"},
                {"id": "program", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "程序", "en-US": "Program"},
                 "description": "Octane程序区域，对于DTSV为IuK"},
                {"id": "domain", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "域", "en-US": "Domain"},
                 "description": "控制哪个部门的活动被监控"},
                {"id": "type", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "类型", "en-US": "Type"},
                 "description": "Standard=常规Release Test Event"},
                {"id": "release", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "Release", "en-US": "Release"},
                 "description": "SWIP Release号(R-YY-CW格式)"},
                {"id": "set_name", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "SET", "en-US": "SET"},
                 "description": "System Engineering Test标识"},
                {"id": "models", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "车型", "en-US": "Models"},
                 "description": "涉及的车型(MGU21, MGU22, IDC等)"},
                {"id": "capacity_iuk", "type": "integer", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "IuK容量", "en-US": "IuK Capacity"}},
                {"id": "capacity_dips", "type": "integer", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "DiPS容量", "en-US": "DiPS Capacity"}},
                {"id": "countries", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "国家", "en-US": "Countries"},
                 "description": "DE, CN, JP, KR, US, BR, TW, HK等"},
            ],
            "governance": {"status": "approved", "owner": "DTSV Team"},
            "sourceDocuments": ["Testmanagement"]
        },
        {
            "id": "product.test_rack",
            "version": "1.0.0",
            "labels": {"zh-CN": "测试台架", "en-US": "Test Rack"},
            "descriptions": {
                "zh-CN": "IuK测试台架，用于软件集成测试。分为开发系统、集群系统等模块化设计。",
                "en-US": "IuK test rack for software integration testing with modular design."
            },
            "aliases": ["rack", "test rack", "Pruefstand", "台架"],
            "source": {"sourceId": "analytics.test_racks", "system": "analytics", "readModel": "test_racks", "table": ""},
            "primaryKey": "rack_id",
            "sensitivity": "internal",
            "allowedOperations": ["read", "aggregate"],
            "properties": [
                {"id": "rack_id", "type": "string", "nullable": False, "sensitivity": "internal"},
                {"id": "rack_type", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "台架类型", "en-US": "Rack Type"},
                 "description": "Developer system / Cluster system"},
                {"id": "platform", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "平台", "en-US": "Platform"},
                 "description": "IDC, MGU21, MGU22等"},
                {"id": "location", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "位置", "en-US": "Location"},
                 "description": "Munich, Shenyang等"},
                {"id": "status", "type": "string", "nullable": True, "sensitivity": "internal"},
            ],
            "governance": {"status": "approved", "owner": "DTSV Team"},
            "sourceDocuments": ["Retrofitting", "Vehicles_Testdrives"]
        },
        {
            "id": "vehicle.test_vehicle",
            "version": "1.0.0",
            "labels": {"zh-CN": "测试车辆", "en-US": "Test Vehicle"},
            "descriptions": {
                "zh-CN": "DTSV测试车辆，通过FIPS系统预约。分为工作日和周末测试驾驶。",
                "en-US": "DTSV test vehicle, booked via FIPS system."
            },
            "aliases": ["test car", "FIPS", "测试车", "KSP"],
            "source": {"sourceId": "analytics.test_vehicles", "system": "analytics", "readModel": "test_vehicles", "table": ""},
            "primaryKey": "vin",
            "sensitivity": "confidential",
            "allowedOperations": ["read", "aggregate"],
            "properties": [
                {"id": "vin", "type": "string", "nullable": False, "sensitivity": "confidential",
                 "labels": {"zh-CN": "VIN", "en-US": "VIN"}},
                {"id": "model_series", "type": "string", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "车型系列", "en-US": "Model Series"},
                 "description": "G45, G70, J01, S18A, U06, G68, U11等"},
                {"id": "project", "type": "string", "nullable": True, "sensitivity": "internal",
                 "description": "IDC, MGU, ICON等"},
                {"id": "i_step", "type": "string", "nullable": True, "sensitivity": "internal"},
                {"id": "location", "type": "string", "nullable": True, "sensitivity": "internal",
                 "description": "Munich, Shenyang等"},
                {"id": "ksp", "type": "boolean", "nullable": True, "sensitivity": "internal",
                 "labels": {"zh-CN": "KSP车辆", "en-US": "KSP Vehicle"},
                 "description": "是否为KSP(Kurzschlussprüfstand)车辆"},
            ],
            "governance": {"status": "approved", "owner": "Fleet Management"},
            "sourceDocuments": ["Vehicles_Testdrives", "Retrofitting"]
        },
    ]

    existing_ids = {e['id'] for e in entities}
    added_entities = 0
    for ne in new_entities:
        if ne['id'] not in existing_ids:
            entities.append(ne)
            added_entities += 1

    print(f"entities.json: +{added_defect} defect props, +{added_run} run props, +{added_entities} entities")
    print(f"  Total: {len(entities)} entities")
    save('entities', data)
    return data


# ─── DIMENSIONS ──────────────────────────────────────────────────────────
def update_dimensions():
    data = load('dimensions')
    dims = data['dimensions']
    existing = {d['id'] for d in dims}

    new_dims = [
        # Phase enum with full business semantics
        {
            "id": "quality.phase_enum",
            "labels": {"zh-CN": "缺陷阶段(完整枚举)", "en-US": "Defect Phase (Full Enum)"},
            "entityId": "quality.defect",
            "propertyId": "phase",
            "type": "enum",
            "enumValues": [
                {"value": "00-Draft", "labels": {"zh-CN": "草稿", "en-US": "Draft"}, "isOpen": False, "phaseGroup": "Integration"},
                {"value": "01-New", "labels": {"zh-CN": "新建/已退回", "en-US": "New/Rejected"}, "isOpen": True, "phaseGroup": "Integration",
                 "description": "新建缺陷或被FO退回的缺陷。Blocked缺陷=Phase 01 + Blocking Reason"},
                {"value": "02-In Pre-Analysis", "labels": {"zh-CN": "预分析(Q-Gate触发)", "en-US": "In Pre-Analysis (Q-Gate)"}, "isOpen": True, "phaseGroup": "Q-Gate",
                 "description": "Q-Gate在此阶段触发：评估缺陷是否阻止功能成熟度。无Blocking Reason时触发Q-Gate"},
                {"value": "03-In Analysis", "labels": {"zh-CN": "分析中", "en-US": "In Analysis"}, "isOpen": True, "phaseGroup": "CoC"},
                {"value": "04-In Progress", "labels": {"zh-CN": "处理中", "en-US": "In Progress"}, "isOpen": True, "phaseGroup": "CoC"},
                {"value": "05-In Verification", "labels": {"zh-CN": "验证中", "en-US": "In Verification"}, "isOpen": True, "phaseGroup": "CoC"},
                {"value": "06-Concluded", "labels": {"zh-CN": "已关闭(正向解决)", "en-US": "Concluded"}, "isOpen": False, "phaseGroup": "Integration",
                 "description": "缺陷已被正向解决(Resolved Forward: 08→06)"},
                {"value": "07-Reopen", "labels": {"zh-CN": "重开", "en-US": "Reopen"}, "isOpen": True, "phaseGroup": "Q-Gate"},
                {"value": "08-Resolved", "labels": {"zh-CN": "已解决", "en-US": "Resolved"}, "isOpen": False, "phaseGroup": "Integration"},
                {"value": "09-Concluded without action", "labels": {"zh-CN": "已关闭(直接拒绝)", "en-US": "Concluded without action"}, "isOpen": False, "phaseGroup": "Integration",
                 "description": "缺陷被直接拒绝(Rejected Directly: 01→09)"},
            ],
            "description": "Octane缺陷生命周期的10个阶段。02=Q-Gate触发点，06=正向关闭，09=拒绝关闭",
            "sourceDocuments": ["Defectmanagement", "read_models.py"],
        },
        # Maturity Grade
        {
            "id": "quality.maturity_grade",
            "labels": {"zh-CN": "成熟度等级(RG)", "en-US": "Maturity Grade"},
            "entityId": "quality.maturity_grade",
            "propertyId": "rg_level",
            "type": "enum",
            "enumValues": [
                {"value": "RG4", "labels": {"zh-CN": "可测试", "en-US": "Testable"}, "description": "功能达到可测试状态"},
                {"value": "RG5-Green", "labels": {"zh-CN": "功能完整", "en-US": "Function Complete"}, "description": "所有子功能已实现，端到端可测"},
                {"value": "RG5-Yellow", "labels": {"zh-CN": "功能完整(有阻塞)", "en-US": "Function Complete (with blocker)"},
                 "description": "功能本身完整但有基础功能阻塞客户体验(PMG ticket)"},
                {"value": "RG5-Red", "labels": {"zh-CN": "功能不完整", "en-US": "Function Incomplete"}, "description": "功能未达到完整状态"},
                {"value": "RG6", "labels": {"zh-CN": "客户可用", "en-US": "Ready for Customer"}, "description": "Showstopper-free，可上线"},
            ],
            "sourceDocuments": ["BEAT_TopIssues", "Defectmanagement"],
        },
        # Top Issue / Showstopper phase
        {
            "id": "quality.evaluation_phase",
            "labels": {"zh-CN": "评估阶段", "en-US": "Evaluation Phase"},
            "entityId": "quality.defect",
            "propertyId": "involved_i_step",
            "type": "enum",
            "enumValues": [
                {"value": "top_issue_phase", "labels": {"zh-CN": "Top Issue阶段(I-420~I-470)", "en-US": "Top Issue Phase"},
                 "description": "功能成熟度增长阶段。评估缺陷是否阻止达到预期Reifegrad"},
                {"value": "showstopper_phase", "labels": {"zh-CN": "Showstopper阶段(I-480~I-490)", "en-US": "Showstopper Phase"},
                 "description": "所有功能已实现。识别上线前必须修复的缺陷"},
            ],
            "sourceDocuments": ["Defectmanagement", "CN_Introduction"],
        },
        # Function Group (from Testmanagement)
        {
            "id": "quality.function_group",
            "labels": {"zh-CN": "功能组", "en-US": "Function Group"},
            "entityId": "organization.function_team_mapping",
            "propertyId": "function_group",
            "type": "enum",
            "enumValues": [
                {"value": "China specific", "labels": {"zh-CN": "中国专属"}, "description": "Tencent WeChat, Connected Music China, Video streaming China等"},
                {"value": "Call Services", "labels": {"zh-CN": "呼叫服务"}, "description": "E-Call, Concierge Call, Roadside Assistance等"},
                {"value": "Audio", "labels": {"zh-CN": "音频"}, "description": "Telephony, Audio settings等"},
                {"value": "Entertainment", "labels": {"zh-CN": "娱乐"}, "description": "AirConsole, Connected Music, PaDi等"},
                {"value": "AZV", "labels": {"zh-CN": "AZV"}, "description": "Date/Time, Driving data等"},
                {"value": "InCar Apps", "labels": {"zh-CN": "车内应用"}, "description": "Weather, News等"},
                {"value": "Navigation", "labels": {"zh-CN": "导航"}, "description": "Navigation 2.0等"},
                {"value": "HMI", "labels": {"zh-CN": "人机交互"}, "description": "Voice Interface, Personalization等"},
                {"value": "FlexUse", "labels": {"zh-CN": "灵活使用"}, "description": "CarSharing等"},
            ],
            "sourceDocuments": ["Testmanagement"],
        },
        # Test categories (ISO 25010)
        {
            "id": "testing.quality_category",
            "labels": {"zh-CN": "测试质量类别(ISO 25010)", "en-US": "Test Quality Category (ISO 25010)"},
            "entityId": "testing.test_run",
            "propertyId": "domain",
            "type": "enum",
            "enumValues": [
                {"value": "Functional Correctness", "labels": {"zh-CN": "功能正确性"}, "relevance": "y", "responsible": "DE-61"},
                {"value": "Time Behaviour", "labels": {"zh-CN": "时间行为"}, "relevance": "y", "responsible": "DE-61",
                 "description": "App startup, HMI startup, Route calculation, User login timings"},
                {"value": "Maturity", "labels": {"zh-CN": "成熟度/稳定性"}, "relevance": "y", "responsible": "DE-61",
                 "description": "Stability, black/yellow screen检测"},
                {"value": "Availability", "labels": {"zh-CN": "可用性"}, "relevance": "y", "responsible": "DE-61"},
                {"value": "Fault Tolerance", "labels": {"zh-CN": "容错性"}, "relevance": "y", "responsible": "DE-61"},
                {"value": "Recoverability", "labels": {"zh-CN": "可恢复性"}, "relevance": "y", "responsible": "DE-61"},
            ],
            "sourceDocuments": ["CN_TestStrategy"],
        },
        # Test Activity types
        {
            "id": "testing.activity_type",
            "labels": {"zh-CN": "测试活动类型", "en-US": "Test Activity Type"},
            "entityId": "testing.test_run",
            "propertyId": "test_phase",
            "type": "enum",
            "enumValues": [
                {"value": "Functional Regression Testing", "labels": {"zh-CN": "功能回归测试"}},
                {"value": "Experience-based Testing", "labels": {"zh-CN": "探索性测试"}, "description": "unguided free testing, 占工作时间30%"},
                {"value": "Prod Testing", "labels": {"zh-CN": "生产环境测试"}},
                {"value": "RSU E2E Test", "labels": {"zh-CN": "RSU端到端测试"}},
                {"value": "TAIWAN Onsite Test", "labels": {"zh-CN": "台湾现场测试"}},
                {"value": "HONGKONG MACAU Onsite Test", "labels": {"zh-CN": "港澳现场测试"}},
                {"value": "Special Test: Flexible App Release", "labels": {"zh-CN": "特殊测试:灵活应用发布"}},
                {"value": "Special Test: Backward Compatible", "labels": {"zh-CN": "特殊测试:向后兼容"}},
                {"value": "Guided Testing", "labels": {"zh-CN": "引导测试"}, "description": "基于FO提供的测试用例, 占工作时间70%"},
            ],
            "sourceDocuments": ["CN_TestStrategy"],
        },
        # China Team domains
        {
            "id": "org.cn_team_domain",
            "labels": {"zh-CN": "中国团队域", "en-US": "China Team Domain"},
            "entityId": "organization.team",
            "propertyId": "team",
            "type": "enum",
            "enumValues": [
                {"value": "Global Digital Services", "labels": {"zh-CN": "全球数字服务"}, "responsible": "Tianhua Xie"},
                {"value": "Navigation", "labels": {"zh-CN": "导航"}, "responsible": "Tony Wang"},
                {"value": "HMI/Voice", "labels": {"zh-CN": "人机交互/语音"}, "responsible": "Jerry Li"},
                {"value": "PaDi/RSU", "labels": {"zh-CN": "PaDi/RSU"}, "responsible": "Zhimei Yan"},
                {"value": "China DIPS IDC/MGU MyLife", "labels": {"zh-CN": "中国DIPS IDC/MGU MyLife"}, "responsible": "Huanran Wang"},
                {"value": "AZV/Entertainment/Telephony", "labels": {"zh-CN": "AZV/娱乐/电话"}, "responsible": "Miao Xu"},
                {"value": "MyBMW/Smart Access", "labels": {"zh-CN": "MyBMW/智能访问"}, "responsible": "Juzhen Xin"},
            ],
            "sourceDocuments": ["CN_Introduction"],
        },
        # Release enum
        {
            "id": "product.release_enum",
            "labels": {"zh-CN": "Release(完整枚举)", "en-US": "Release (Full Enum)"},
            "entityId": "testing.test_run",
            "propertyId": "release",
            "type": "enum",
            "enumValues": [
                {"value": f"R-{y}-{cw:02d}", "labels": {"zh-CN": f"{y}年第{cw}周"}}
                for y in range(21, 26)
                for cw in range(1, 13)
                if not (y == 21 and cw < 3)
            ][:50],
            "description": "SWIP Release号(R-YY-CW格式)，从2021年到2025年",
            "sourceDocuments": ["Testmanagement"],
        },
        # Q-Gate type
        {
            "id": "quality.qgate_type",
            "labels": {"zh-CN": "Q-Gate类型", "en-US": "Q-Gate Type"},
            "entityId": "quality.qgate",
            "propertyId": "qgate_type",
            "type": "enum",
            "enumValues": [
                {"value": "Functional Q-Gate", "labels": {"zh-CN": "功能Q-Gate"},
                 "description": "覆盖FV团队负责的所有功能。Phase 02触发"},
                {"value": "ECU Q-Gate (Resterampe)", "labels": {"zh-CN": "ECU Q-Gate(剩余斜坡)"},
                 "description": "Found in Function不属于特定团队但ECU属于CoCo的缺陷。TEAM=IUK_TSP_xxx或DIPS_TSP_xxx"},
                {"value": "Mobile App Q-Gate", "labels": {"zh-CN": "移动应用Q-Gate"},
                 "description": "基于Assigned ECU=APP_Mobile_2_0, Found in Function=Itinerary(Mobile App), Defect Category=Mobile App Client"},
                {"value": "Carfunctions Q-Gate (Ex-Box)", "labels": {"zh-CN": "车功能Q-Gate(Ex-Box)"}},
            ],
            "sourceDocuments": ["Defectmanagement"],
        },
        # TQR enum
        {
            "id": "quality.tqr_enum",
            "labels": {"zh-CN": "工单质量评级(TQR)", "en-US": "Ticket Quality Rating"},
            "entityId": "quality.defect",
            "propertyId": "tqr",
            "type": "enum",
            "enumValues": [
                {"value": "01-ok", "labels": {"zh-CN": "合格"}},
                {"value": "02-not ok error description", "labels": {"zh-CN": "错误描述不合格"},
                 "description": "缺陷描述不清楚或不准确"},
                {"value": "03-not ok missing traces", "labels": {"zh-CN": "缺少追踪信息"},
                 "description": "缺少必要的trace/log文件"},
                {"value": "04-not ok duplicate", "labels": {"zh-CN": "重复缺陷"}},
                {"value": "05-not ok wrong category", "labels": {"zh-CN": "分类错误"}},
            ],
            "description": "FO退票时必须填写的工单质量评级。常见错误：退票原因是缺少trace但TQR选了'错误描述不合格'",
            "sourceDocuments": ["Defectmanagement"],
        },
    ]

    added = 0
    for d in new_dims:
        if d['id'] not in existing:
            dims.append(d)
            added += 1

    print(f"dimensions.json: +{added} dimensions")
    print(f"  Total: {len(dims)} dimensions")
    save('dimensions', data)
    return data


# ─── METRICS ─────────────────────────────────────────────────────────────
def update_metrics():
    data = load('metrics')
    metrics = data['metrics']
    existing = {m['id'] for m in metrics}

    new_metrics = [
        {
            "id": "kpi.defect_detection_ratio",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "缺陷检测率(DDP)", "en-US": "Defect Detection Ratio"},
            "description": "DDP = R1 / (R1 + R2) * 100%。R1=上线前发现的缺陷数，R2=上线后发现的缺陷数。目标≥99%",
            "entityId": "quality.defect",
            "grain": "defects detected before vs after customer release",
            "measure": "count_distinct(defect_id WHERE phase NOT IN ('06-Concluded','09-Concluded without action') AND creation_time < release_date) / count_distinct(defect_id) * 100",
            "formula": "R1 / (R1 + R2) * 100",
            "unit": "percentage",
            "targetValue": ">=99%",
            "defaultTimeDimension": "time.defect_creation_date",
            "applicableDimensions": ["product.project", "quality.phase", "vehicle.model_series"],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
        {
            "id": "kpi.regression_coverage",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "回归测试覆盖率", "en-US": "Regression Test Coverage"},
            "description": "每个DTSV周期中，至少执行过一次测试的RG5已签收功能数 / RG5功能总数。目标100%",
            "entityId": "testing.test_case",
            "grain": "RG5 signed-off features with at least one test case executed",
            "measure": "count_distinct(test_id WHERE rg_level='RG5' AND run_count > 0) / count_distinct(test_id WHERE rg_level='RG5') * 100",
            "unit": "percentage",
            "targetValue": "100%",
            "applicableDimensions": ["product.project", "testing.domain"],
            "governance": {"status": "approved", "owner": "DE-611 Test Management"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
        {
            "id": "kpi.config_coverage_models",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "配置覆盖率(车型)", "en-US": "Configuration Coverage - Car Models"},
            "description": "已测试的车型变体数 / I-Step交付支持的总车型变体数。目标100%",
            "entityId": "vehicle.test_vehicle",
            "grain": "derivate coverage per I-step delivery",
            "measure": "count_distinct(model_series WHERE tested=true) / count_distinct(model_series) * 100",
            "unit": "percentage",
            "targetValue": "100%",
            "applicableDimensions": ["product.i_step", "vehicle.model_series"],
            "governance": {"status": "approved", "owner": "Project Planning"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
        {
            "id": "kpi.config_coverage_variants",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "配置覆盖率(硬件变体)", "en-US": "Configuration Coverage - Hardware Variants"},
            "description": "100%覆盖硬件变体(High, Mid, Base, Premium)。目标100%",
            "entityId": "vehicle.test_vehicle",
            "grain": "hardware variant coverage",
            "measure": "count_distinct(hw_variant WHERE tested=true) / count_distinct(hw_variant) * 100",
            "unit": "percentage",
            "targetValue": "100%",
            "applicableDimensions": ["product.platform"],
            "governance": {"status": "approved", "owner": "Platform Resource Planning"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
        {
            "id": "kpi.defect_rejection_rate",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "缺陷拒收率(CWA)", "en-US": "Defect Rejection Rate (CWA)"},
            "description": "CWA(Child Without Action)率。子缺陷被直接拒绝的比例。目标≤10%",
            "entityId": "quality.defect",
            "grain": "child defects rejected directly",
            "measure": "count_distinct(defect_id WHERE parent_child_type='child' AND phase='09-Concluded without action') / count_distinct(defect_id WHERE parent_child_type='child') * 100",
            "unit": "percentage",
            "targetValue": "<=10%",
            "applicableDimensions": ["org.team", "product.project", "quality.solution_cluster"],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
        {
            "id": "kpi.function_coverage",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "功能(AIDA)覆盖率", "en-US": "Function (AIDA) Coverage"},
            "description": "功能(AIDA)的需求或验收标准覆盖率。目标100%。由流程保证",
            "entityId": "requirements.aida_node",
            "grain": "AIDA nodes with requirements coverage",
            "measure": "count_distinct(aida_id WHERE has_requirement=true) / count_distinct(aida_id) * 100",
            "unit": "percentage",
            "targetValue": "100%",
            "applicableDimensions": ["product.project", "requirements.aida"],
            "governance": {"status": "approved", "owner": "Process Management"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
        {
            "id": "defect.top_issue_count",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "Top Issue缺陷数", "en-US": "Top Issue Defect Count"},
            "description": "在Top Issue阶段(通常I-420~I-470)，阻止功能达到预期Reifegrad的缺陷数。这类缺陷需要在Octane的'Assign'字段标记为'Preventing Maturity Grade ConDrive'",
            "entityId": "quality.defect",
            "grain": "defects blocking maturity grade achievement",
            "measure": "count_distinct(defect_id WHERE reporting_class LIKE '%Top Issue%' OR user_tags LIKE '%TopIssue%')",
            "unit": "count",
            "defaultTimeDimension": "time.defect_creation_date",
            "applicableDimensions": ["product.project", "quality.phase", "vehicle.model_series", "product.ecu"],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["Defectmanagement"],
        },
        {
            "id": "defect.showstopper_count",
            "definitionVersion": "1.0.0",
            "labels": {"zh-CN": "Showstopper缺陷数", "en-US": "Showstopper Defect Count"},
            "description": "在Showstopper阶段(通常I-480~I-490)，上线前必须修复的缺陷数。标记为'Showstopper_Candidat'的潜在Showstopper",
            "entityId": "quality.defect",
            "grain": "critical defects blocking go-live",
            "measure": "count_distinct(defect_id WHERE reporting_class LIKE '%Showstopper%' OR user_tags LIKE '%Showstopper%')",
            "unit": "count",
            "defaultTimeDimension": "time.defect_creation_date",
            "applicableDimensions": ["product.project", "quality.phase", "vehicle.model_series", "product.ecu"],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["Defectmanagement"],
        },
    ]

    added = 0
    for m in new_metrics:
        if m['id'] not in existing:
            metrics.append(m)
            added += 1

    print(f"metrics.json: +{added} metrics")
    print(f"  Total: {len(metrics)} metrics")
    save('metrics', data)
    return data


# ─── VOCAB ───────────────────────────────────────────────────────────────
def update_vocab():
    data = load('vocab.zh-CN')
    terms = data['terms']
    existing = {t['id'] for t in terms}

    new_terms = [
        # Business concepts
        {"id": "concept.top_issue", "phrases": ["Top Issue", "top issue", "顶级问题", "topissue"],
         "kind": "synonym", "resolution": {"metricId": "defect.top_issue_count", "entityId": "quality.defect"},
         "definition": "在功能成熟度增长阶段(I-420~I-470)，阻止功能达到预期Reifegrad的缺陷",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.showstopper", "phrases": ["Showstopper", "showstopper", "停演", "阻断缺陷"],
         "kind": "synonym", "resolution": {"metricId": "defect.showstopper_count", "entityId": "quality.defect"},
         "definition": "在Showstopper阶段(I-480~I-490)，上线前必须修复的缺陷。与Top Issue的区别：Top Issue关注功能完整度，Showstopper关注客户可用性",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.qgate", "phrases": ["Q-Gate", "Q Gate", "质量门", "质量关卡", "qgate"],
         "kind": "concept", "resolution": {"dimensionId": "quality.qgate_type"},
         "definition": "在Phase 02-In Pre Analysis阶段对缺陷进行的质量评估门。4种类型：功能/ECU/Mobile App/Carfunctions",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.maturity_grade", "phrases": ["RG5", "RG6", "RG4", "Reifegrad", "成熟度", "maturity grade", "RG"],
         "kind": "concept", "resolution": {"dimensionId": "quality.maturity_grade"},
         "definition": "E/E成熟度等级。RG4=可测试, RG5=功能完整(Green/Yellow/Red), RG6=客户可用(=Showstopper-free)",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.cwa", "phrases": ["CWA", "Child Without Action", "无动作子缺陷"],
         "kind": "concept",
         "definition": "子缺陷被直接拒绝(parent_child_type=child + Phase 09)。CWA率目标≤10%",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.blocked", "phrases": ["Blocked", "blocked", "阻塞", "已阻止"],
         "kind": "concept",
         "definition": "Phase=01-New + 有Blocking Reason的缺陷。被FO退回，由Problem Finder Team处理",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.tqr", "phrases": ["TQR", "Ticket Quality Rating", "工单质量", "工单质量评级"],
         "kind": "concept", "resolution": {"dimensionId": "quality.tqr_enum"},
         "definition": "FO退票时必须填写的质量评级。常见错误：退票原因是缺trace但TQR选了'错误描述不合格'",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.matrix", "phrases": ["Matrix", "matrix", "矩阵", "Matrix Rating"],
         "kind": "concept",
         "definition": "Octane中的缺陷严重度矩阵评级。与severity字段不同，Matrix Rating更准确地反映业务严重度",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.dtsv", "phrases": ["DTSV", "Dynamischer Teilsystem-Versuch", "动态子系统验证"],
         "kind": "concept",
         "definition": "DTSV = 动态子系统验证。E/E集成验证的一部分，负责从RG4开始的子系统级测试",
         "governance": {"status": "approved", "owner": "DTSV Team"}},
        {"id": "concept.beat", "phrases": ["BEAT", "beat"],
         "kind": "concept",
         "definition": "BMW的测试成熟度报告系统。DTSV使用BEAT报告功能实现进度，每周更新",
         "governance": {"status": "approved", "owner": "DTSV Team"}},
        {"id": "concept.aida", "phrases": ["AIDA", "AIDA Movement"],
         "kind": "concept",
         "definition": "BMW的需求管理系统。客户功能按Report Element(BE)分组，每个BE有基于I-Step的成熟度增长计划",
         "governance": {"status": "approved", "owner": "Requirements Analytics"}},
        {"id": "concept.iuk", "phrases": ["IuK", "IUK", "iuk"],
         "kind": "concept",
         "definition": "Integration & Verification。DTSV所属的项目程序区域，Octane Program字段通常为IuK",
         "governance": {"status": "approved", "owner": "DTSV Team"}},
        {"id": "concept.dips", "phrases": ["DiPS", "dips", "DIPS"],
         "kind": "concept",
         "definition": "DiPS = Digital Products & Services。DTSV内的另一个测试方向",
         "governance": {"status": "approved", "owner": "DTSV Team"}},
        {"id": "concept.i_step", "phrases": ["I-Step", "I-step", "I-420", "I-450", "I-470", "I-480", "I-490", "I-500"],
         "kind": "concept", "resolution": {"dimensionId": "product.i_step"},
         "definition": "集成步骤(Integration Step)。关键节点：I-420=早期集成, I-470=Top Issue阶段结束, I-480/490=Showstopper阶段, I-500=发布",
         "governance": {"status": "approved", "owner": "Project Management"}},
        {"id": "concept.sop", "phrases": ["SOP", "Start of Production", "投产"],
         "kind": "concept",
         "definition": "SOP = Start of Production。量产开始，E/E集成验证的终点",
         "governance": {"status": "approved", "owner": "Project Management"}},
        {"id": "concept.set", "phrases": ["SET", "System Engineering Test"],
         "kind": "concept",
         "definition": "系统工程测试(System Engineering Test)。Release Test Event的标识",
         "governance": {"status": "approved", "owner": "Test Management"}},
        {"id": "concept.flash", "phrases": ["Flash", "flash", "刷写", "Flashing"],
         "kind": "concept",
         "definition": "将软件刷写到车辆或台架。DTSV每周五进行official cluster flash",
         "governance": {"status": "approved", "owner": "DTSV Team"}},
        {"id": "concept.ksp", "phrases": ["KSP", "ksp"],
         "kind": "concept",
         "definition": "KSP = Kurzschlussprüfstand。短路测试台架/特殊测试车辆配置",
         "governance": {"status": "approved", "owner": "DTSV Team"}},
        {"id": "concept.fips", "phrases": ["FIPS", "fips"],
         "kind": "concept",
         "definition": "FIPS = 测试车辆预约系统。用于预约工作日和周末的测试驾驶",
         "governance": {"status": "approved", "owner": "Fleet Management"}},
        {"id": "concept.mgip", "phrases": ["MgIP", "Messen gegen Integrations Planung"],
         "kind": "concept",
         "definition": "MgIP = 对照集成计划进行测量。评估当前I-Step的实际成熟度vs计划成熟度",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.resterampe", "phrases": ["Resterampe", "resterampe", "剩余斜坡"],
         "kind": "concept",
         "definition": "Found in Function不属于特定团队但ECU属于CoCo的缺陷。由TPM团队每日分派到对应团队",
         "governance": {"status": "approved", "owner": "TPM Team"}},
        {"id": "concept.china_scope", "phrases": ["China scope", "China Scope", "中国范围", "CN scope"],
         "kind": "concept",
         "definition": "判定缺陷是否属于中国市场范围。基于solution_cluster匹配40个China值OR defect_category匹配China类别",
         "governance": {"status": "approved", "owner": "DTSV China"}},
        {"id": "concept.tsp", "phrases": ["TSP", "tsp"],
         "kind": "concept",
         "definition": "TSP = Test & System Verification Platform。IuK_TSP_xxx或DIPS_TSP_xxx是团队前缀",
         "governance": {"status": "approved", "owner": "DTSV Team"}},
        {"id": "concept.ddp", "phrases": ["DDP", "Defect Detection Ratio", "缺陷检测率"],
         "kind": "synonym", "resolution": {"metricId": "kpi.defect_detection_ratio"},
         "definition": "缺陷检测率 = 上线前发现的缺陷 / 总缺陷 * 100%。目标≥99%",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
        {"id": "concept.regression_coverage", "phrases": ["回归覆盖率", "回归测试覆盖", "regression coverage"],
         "kind": "synonym", "resolution": {"metricId": "kpi.regression_coverage"},
         "governance": {"status": "approved", "owner": "DE-611"}},
        {"id": "concept.owner_field", "phrases": ["Owner", "owner", "所有者"],
         "kind": "concept",
         "definition": "Octane Owner字段 = 解决方案负责人。注意：不是问题发现者(Problem Finder)，常见误用是将发现者设为Owner",
         "governance": {"status": "approved", "owner": "Quality Analytics"}},
    ]

    added = 0
    for t in new_terms:
        if t['id'] not in existing:
            terms.append(t)
            added += 1

    print(f"vocab.zh-CN.json: +{added} terms")
    print(f"  Total: {len(terms)} terms")
    save('vocab.zh-CN', data)
    return data


# ─── CONSTRAINTS ─────────────────────────────────────────────────────────
def update_constraints():
    data = load('constraints')
    constraints = data['constraints']
    existing = {c['id'] for c in constraints}

    new_constraints = [
        {
            "id": "rule.qgate_trigger",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "Q-Gate触发条件：Phase='02-In Pre-Analysis' 且 无 Blocking Reason",
            "condition": "phase = '02-In Pre-Analysis' AND blocking_reason IS NULL OR blocking_reason = ''",
            "action": "trigger_qgate_evaluation",
            "enforcement": "plan",
            "parameters": {"phaseField": "phase", "phaseValue": "02-In Pre-Analysis", "blockingReasonField": "blocking_reason"},
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["Defectmanagement"],
        },
        {
            "id": "rule.blocked_definition",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "Blocked缺陷定义：Phase='01-New' 且 有 Blocking Reason",
            "condition": "phase = '01-New' AND blocking_reason IS NOT NULL AND blocking_reason != ''",
            "action": "classify_as_blocked",
            "enforcement": "plan",
            "parameters": {"phaseField": "phase", "phaseValue": "01-New"},
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["Defectmanagement"],
        },
        {
            "id": "rule.top_issue_phase",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "Top Issue阶段定义：通常I-420到I-470。评估缺陷是否阻止功能达到预期Reifegrad",
            "condition": "involved_i_step BETWEEN 'I-420' AND 'I-470'",
            "action": "evaluate_top_issue",
            "enforcement": "plan",
            "parameters": {"startIStep": "I-420", "endIStep": "I-470"},
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["Defectmanagement", "CN_Introduction"],
        },
        {
            "id": "rule.showstopper_phase",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "Showstopper阶段定义：通常I-480到I-490。所有功能已实现，识别上线前必须修复的缺陷",
            "condition": "involved_i_step BETWEEN 'I-480' AND 'I-490'",
            "action": "evaluate_showstopper",
            "enforcement": "plan",
            "parameters": {"startIStep": "I-480", "endIStep": "I-490"},
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["Defectmanagement", "CN_Introduction"],
        },
        {
            "id": "rule.resolved_forward",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "正向解决定义：缺陷从Phase 08-Resolved流转到Phase 06-Concluded",
            "condition": "phase = '06-Concluded' AND EXISTS history_event WHERE field_name='phase' AND old_value='08-Resolved' AND new_value='06-Concluded'",
            "action": "classify_resolved_forward",
            "enforcement": "plan",
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["read_models.py"],
        },
        {
            "id": "rule.rejected_directly",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "直接拒绝定义：缺陷从Phase 01-New直接流转到Phase 09-Concluded without action",
            "condition": "phase = '09-Concluded without action' AND EXISTS history_event WHERE field_name='phase' AND old_value='01-New' AND new_value='09-Concluded without action'",
            "action": "classify_rejected_directly",
            "enforcement": "plan",
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["read_models.py"],
        },
        {
            "id": "rule.china_scope",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "China Scope判定：solution_cluster匹配China值OR defect_category匹配China类别",
            "condition": "solution_cluster IN ({CHINA_SOLUTION_CLUSTERS}) OR defect_category IN ({CHINA_DEFECT_CATEGORIES})",
            "action": "classify_china_scope",
            "enforcement": "plan",
            "parameters": {
                "chinaSolutionClusters": [
                    "solution cluster:china product", "ipa cn", "speech cn", "navigation cn",
                    "ent_and_con cn", "navigation twn", "etc jp"
                ],
                "chinaDefectCategories": [
                    "ent/connected_music_china", "application navigation china hk", "cn dkr",
                    "cn backend_service", "cn etc", "cn nav", "cn speech", "cn media",
                    "cn llm", "cn store", "cn wechat", "cn launcher"
                ]
            },
            "governance": {"status": "approved", "owner": "DTSV China"},
            "sourceDocuments": ["read_models.py"],
        },
        {
            "id": "rule.phase_group_classification",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "Phase分组：02/07=Q-Gate, 00/01/06/08/09=Integration, 03/04/05=CoC",
            "condition": "CASE WHEN phase_code IN ('02','07') THEN 'Q-Gate' WHEN phase_code IN ('00','01','06','08','09') THEN 'Integration' WHEN phase_code IN ('03','04','05') THEN 'CoC' ELSE 'Other' END",
            "action": "classify_phase_group",
            "enforcement": "plan",
            "parameters": {
                "qgate": ["02", "07"],
                "integration": ["00", "01", "06", "08", "09"],
                "coc": ["03", "04", "05"]
            },
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["read_models.py", "Defectmanagement"],
        },
        {
            "id": "rule.owner_semantics",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "Owner字段语义：Owner永远是解决方案负责人，不是问题发现者。常见误用：将Problem Finder设为Owner",
            "condition": "owner != detected_by AND owner != problem_finder_team",
            "action": "validate_owner_assignment",
            "enforcement": "plan",
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["Defectmanagement"],
        },
        {
            "id": "rule.mobile_app_qgate",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "Mobile App Q-Gate条件：Assigned ECU=APP_Mobile_2_0 AND Found in Function=Itinerary(Mobile App) AND Defect Category=Mobile App Client",
            "condition": "assigned_ecu = 'APP_Mobile_2_0' AND top_aida = 'Itinerary (Mobile App)' AND defect_category = 'Mobile App Client'",
            "action": "route_to_mobile_app_qgate",
            "enforcement": "plan",
            "governance": {"status": "approved", "owner": "DIPS_TSP_MobileApps"},
            "sourceDocuments": ["Defectmanagement"],
        },
        {
            "id": "rule.cwa_target",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "CWA目标：缺陷拒收率(CWA)≤10%",
            "condition": "count(defect_id WHERE parent_child_type='child' AND phase='09-Concluded without action') / count(defect_id WHERE parent_child_type='child') * 100 <= 10",
            "action": "alert_if_exceeded",
            "enforcement": "plan",
            "parameters": {"targetValue": 10, "unit": "percent"},
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
        {
            "id": "rule.ddp_target",
            "version": "1.0.0",
            "kind": "business_rule",
            "description": "DDP目标：缺陷检测率≥99%",
            "condition": "R1 / (R1 + R2) * 100 >= 99",
            "action": "alert_if_below",
            "enforcement": "plan",
            "parameters": {"targetValue": 99, "unit": "percent"},
            "governance": {"status": "approved", "owner": "Quality Analytics"},
            "sourceDocuments": ["CN_TestStrategy"],
        },
    ]

    added = 0
    for c in new_constraints:
        if c['id'] not in existing:
            constraints.append(c)
            added += 1

    print(f"constraints.json: +{added} constraints")
    print(f"  Total: {len(constraints)} constraints")
    save('constraints', data)
    return data


# ─── RELATIONSHIPS ───────────────────────────────────────────────────────
def update_relationships():
    data = load('relationships')
    rels = data['relationships']
    existing = {r['id'] for r in rels}

    new_rels = [
        {
            "id": "quality.defect.evaluated_by.quality.qgate",
            "predicate": "evaluated_by",
            "sourceEntity": "quality.defect",
            "targetEntity": "quality.qgate",
            "direction": "outbound",
            "cardinality": "many_to_one",
            "reversible": True,
            "sourceFields": {"source": "phase", "target": "qgate_type"},
            "allowedJoinPaths": [["quality.defect", "quality.qgate"]],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
        },
        {
            "id": "quality.defect.has_maturity_grade.quality.maturity_grade",
            "predicate": "has_maturity_grade",
            "sourceEntity": "quality.defect",
            "targetEntity": "quality.maturity_grade",
            "direction": "outbound",
            "cardinality": "many_to_one",
            "reversible": True,
            "sourceFields": {"source": "top_aida", "target": "function_id"},
            "allowedJoinPaths": [["quality.defect", "quality.maturity_grade"]],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
        },
        {
            "id": "organization.function_team_mapping.belongs_to.organization.team",
            "predicate": "belongs_to",
            "sourceEntity": "organization.function_team_mapping",
            "targetEntity": "organization.team",
            "direction": "outbound",
            "cardinality": "many_to_one",
            "reversible": True,
            "sourceFields": {"source": "team", "target": "team"},
            "allowedJoinPaths": [["organization.function_team_mapping", "organization.team"]],
            "governance": {"status": "approved", "owner": "DTSV Team"},
        },
        {
            "id": "quality.maturity_grade.measured_at.product.i_step",
            "predicate": "measured_at",
            "sourceEntity": "quality.maturity_grade",
            "targetEntity": "product.i_step",
            "direction": "outbound",
            "cardinality": "many_to_one",
            "reversible": True,
            "sourceFields": {"source": "i_step", "target": "i_step"},
            "allowedJoinPaths": [["quality.maturity_grade", "product.i_step"]],
            "governance": {"status": "approved", "owner": "Quality Analytics"},
        },
        {
            "id": "testing.test_event.includes.testing.test_run",
            "predicate": "includes",
            "sourceEntity": "testing.test_event",
            "targetEntity": "testing.test_run",
            "direction": "outbound",
            "cardinality": "one_to_many",
            "reversible": True,
            "sourceFields": {"source": "release", "target": "release"},
            "allowedJoinPaths": [["testing.test_event", "testing.test_run"]],
            "governance": {"status": "approved", "owner": "DTSV Team"},
        },
        {
            "id": "testing.test_run.executed_on.vehicle.test_vehicle",
            "predicate": "executed_on",
            "sourceEntity": "testing.test_run",
            "targetEntity": "vehicle.test_vehicle",
            "direction": "outbound",
            "cardinality": "many_to_one",
            "reversible": True,
            "sourceFields": {"source": "vin", "target": "vin"},
            "allowedJoinPaths": [["testing.test_run", "vehicle.test_vehicle"]],
            "governance": {"status": "approved", "owner": "Fleet Management"},
        },
        {
            "id": "testing.test_run.executed_on.product.test_rack",
            "predicate": "executed_on",
            "sourceEntity": "testing.test_run",
            "targetEntity": "product.test_rack",
            "direction": "outbound",
            "cardinality": "many_to_one",
            "reversible": True,
            "sourceFields": {"source": "testplatformid", "target": "rack_id"},
            "allowedJoinPaths": [["testing.test_run", "product.test_rack"]],
            "governance": {"status": "approved", "owner": "DTSV Team"},
        },
    ]

    added = 0
    for r in new_rels:
        if r['id'] not in existing:
            rels.append(r)
            added += 1

    print(f"relationships.json: +{added} relationships")
    print(f"  Total: {len(rels)} relationships")
    save('relationships', data)
    return data


# ─── BUSINESS RULES (NEW FILE) ───────────────────────────────────────────
def create_business_rules():
    rules = {
        "schemaVersion": "1.0",
        "ontologyVersion": "v1",
        "description": "从8份业务文档提取的纯业务逻辑规则。这些规则不属于数据约束，而是业务领域知识。",
        "rules": [
            {
                "id": "br.top_issue_vs_showstopper",
                "title": "Top Issue vs Showstopper 区别",
                "source": "Defectmanagement",
                "definition": {
                    "top_issue": "功能成熟度增长阶段(I-420~I-470)。评估缺陷是否阻止功能达到AIDA规划中预期的Reifegrad。",
                    "showstopper": "所有功能已实现后(I-480~I-490)。识别上线前必须修复的、客户不可接受的缺陷。"
                },
                "semanticNotes": "Top Issue关注'功能完整度'(Can we reach RG5?)，Showstopper关注'客户可用性'(Can we go live?)。",
                "octaneFields": {"topIssue": "reporting_class LIKE '%Top Issue%'", "showstopper": "reporting_class LIKE '%Showstopper%' OR user_tags LIKE '%Showstopper_Candidat%'"}
            },
            {
                "id": "br.maturity_grade_definition",
                "title": "E/E成熟度等级模型(RG)",
                "source": "BEAT_TopIssues",
                "definition": {
                    "RG4": "功能达到可测试状态",
                    "RG5_Green": "所有子功能已实现，端到端可测，客户视角完整",
                    "RG5_Yellow": "功能本身完整但有基础功能阻塞(PMG ticket)",
                    "RG5_Red": "功能不完整",
                    "RG6": "Ready for Customer = Showstopper-free，可上线"
                },
                "measurement": "DTSV从RG4开始介入。在BEAT系统中每周报告成熟度。",
                "octaneFields": {"planning": "AIDA中每个Report Element(BE)有基于I-Step的成熟度增长计划"}
            },
            {
                "id": "br.qgate_process",
                "title": "Q-Gate流程",
                "source": "Defectmanagement",
                "definition": {
                    "trigger": "Phase=02-In Pre-Analysis AND 无Blocking Reason",
                    "types": {
                        "functional": "覆盖FV团队负责的所有功能",
                        "ecu_resterampe": "FiF不属于特定团队但ECU属于CoCo。TEAM=IUK_TSP_xxx或DIPS_TSP_xxx (xxx=AZV, Connectivity_Audio, Carfunctions, Entertainment, HMI, Navi)",
                        "mobile_app": "Assigned ECU=APP_Mobile_2_0 AND FiF=Itinerary(Mobile App) AND Defect Category=Mobile App Client. Team=DIPS_TSP_MobileApps",
                        "carfunctions": "Ex-Box相关功能"
                    }
                }
            },
            {
                "id": "br.blocked_rejected_process",
                "title": "Blocked和Rejected缺陷处理",
                "source": "Defectmanagement",
                "definition": {
                    "blocked": "Phase=01-New + Blocking Reason。被FO退回。由Problem Finder Team处理。",
                    "rejected_directly": "Phase从01-New直接到09-Concluded without action",
                    "resolved_forward": "Phase从08-Resolved到06-Concluded",
                    "tqr_required": "FO退票时必须填写TQR。常见错误：退票原因是缺trace但TQR选了'02-not ok error description'"
                }
            },
            {
                "id": "br.owner_field_semantics",
                "title": "Owner字段语义",
                "source": "Defectmanagement",
                "definition": "Owner永远是解决方案负责人(Solution Responsible)，不是问题发现者(Problem Finder)。",
                "commonError": "将Problem Finder设为Owner，因为他'是下一个要做事情的人'。这是错误的。",
                "correctUsage": "Owner = 负责修复缺陷的人/团队。detected_by/problem_finder_team = 发现缺陷的人/团队。"
            },
            {
                "id": "br.china_team_structure",
                "title": "DTSV中国团队结构",
                "source": "CN_Introduction",
                "definition": {
                    "domains": [
                        {"person": "Tianhua Xie", "domain": "Global Digital Services, Base Connectivity"},
                        {"person": "Tony Wang", "domain": "Navigation (IuK18/IuK22 Lead)"},
                        {"person": "Jerry Li", "domain": "HMI/Voice Interface/Personalization/Car-Functions"},
                        {"person": "Zhimei Yan", "domain": "PaDi/RSU (IuK23 Lead)"},
                        {"person": "Huanran Wang", "domain": "China DIPS IDC + MGU MyLife"},
                        {"person": "Miao Xu", "domain": "AZV/Kombi/Entertainment/Carplay/Telephony & Audio (Taiwan Lead)"},
                        {"person": "Juzhen Xin", "domain": "MyBMW/MyMini/TMALL/Smart Access (Hongkong Lead)"},
                    ],
                    "weeklyWorkflow": "FRI=flash+quick check, SAT-SUN=weekend test drive, MON-THU=guided(70%)+free(30%) testing, TUE=intensive test drive"
                }
            },
            {
                "id": "br.kpi_definitions",
                "title": "DTSV关键绩效指标(KPI)",
                "source": "CN_TestStrategy",
                "definition": [
                    {"name": "Function Coverage", "target": "100%", "formula": "AIDA requirements覆盖率"},
                    {"name": "Regression Coverage", "target": "100%", "formula": "有测试执行的RG5功能/RG5功能总数"},
                    {"name": "Config Coverage 1 (Models)", "target": "100%", "formula": "已测试车型/支持车型"},
                    {"name": "Config Coverage 2 (Variants)", "target": "100%", "formula": "硬件变体覆盖(High/Mid/Base/Premium)"},
                    {"name": "Config Coverage 3 (Environment)", "target": "10% PROD", "formula": "I490前10%PROD平台retrofit, CoCo产品全覆盖"},
                    {"name": "DDP", "target": ">=99%", "formula": "R1/(R1+R2)*100%"},
                    {"name": "CWA Rate", "target": "<=10%", "formula": "直接拒绝的子缺陷比例"}
                ]
            },
            {
                "id": "br.iso25010_test_scope",
                "title": "ISO 25010 DTSV测试范围",
                "source": "CN_TestStrategy",
                "definition": {
                    "in_scope": ["Functional Correctness", "Time Behaviour", "Maturity/Stability", "Availability", "Fault Tolerance", "Recoverability"],
                    "out_of_scope": ["Functional Completeness (FO/PO)", "Compatibility", "Usability", "Security", "Maintainability", "Portability"],
                    "time_behaviour_examples": ["App startup time (with CPU limits)", "Ex-Box/Rückfahrkamera startup", "User login timings", "Route calculations", "HMI startup time"]
                }
            },
            {
                "id": "br.defect_tags",
                "title": "缺陷附加标签(Requirement Objects)",
                "source": "Defectmanagement",
                "definition": {
                    "TSP_IuK_Text": "翻译和拼写错误缺陷的标识",
                    "TSP_IuK_Speedlock": "速度锁框架相关缺陷",
                    "TSP_IuK_Egomodel": "Egomodel相关缺陷(无独立BE/FiF)",
                    "Super_SST": "不应在任何情况下关闭的Showstopper标记",
                    "Vehicle Issue": "因车辆问题被退回的缺陷(仅DTSV)"
                }
            },
            {
                "id": "br.release_naming",
                "title": "Release命名规则",
                "source": "Testmanagement",
                "definition": "格式：R-YY-CW (如R-24-02 = 2024年第2周)。对应Octane Release字段 = SWIP Release号。",
                "capacitySplit": "每个Release Test Event按IuK和DiPS分容量，并按国家分配(DE/CN/JP/KR/US/BR/TW/HK)"
            },
            {
                "id": "br.aida_be_mapping",
                "title": "AIDA Berichtselement (BE) → IuK Domain 映射",
                "source": "Responsibilities",
                "definition": "DTSV负责所有在AIDA中标记为'IuK'的Berichtselemente(BE)。包括Integration & Verification和Maturity Grade Evaluation。当AIDA中新增/删除/修改IuK标签时，影响DTSV的职责范围。",
                "changeProcess": "Change Request (CR) 需要经过验证和审批"
            },
            {
                "id": "br.test_strategy_cn",
                "title": "中国测试策略",
                "source": "CN_TestStrategy",
                "definition": {
                    "scope": "Black box test on system level. Focus: China Mainland, Taiwan, Hong Kong/Macao markets.",
                    "testRatio": "Guided testing 70% vs Free/exploratory testing 30%",
                    "specialTests": ["Flexible app release validation", "Backward compatibility timeline validation", "RL circle validation"],
                    "reportingPhases": {"TOP-ISSUE": "成熟度增长阶段，highlight maturity-blocking issues", "SHOWSTOPPER": "功能实现后，highlight critical pre-SOP bugs"}
                }
            },
        ]
    }

    path = os.path.join(BASE, "business_rules.json")
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)
    print(f"business_rules.json: created with {len(rules['rules'])} rules")
    return rules


# ─── MAIN ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 60)
    print("🚀 Ontology Enhancement from Business Documents")
    print("=" * 60)

    print("\n[1/7] Updating entities.json...")
    update_entities()

    print("\n[2/7] Updating dimensions.json...")
    update_dimensions()

    print("\n[3/7] Updating metrics.json...")
    update_metrics()

    print("\n[4/7] Updating vocab.zh-CN.json...")
    update_vocab()

    print("\n[5/7] Updating constraints.json...")
    update_constraints()

    print("\n[6/7] Updating relationships.json...")
    update_relationships()

    print("\n[7/7] Creating business_rules.json...")
    create_business_rules()

    print("\n" + "=" * 60)
    print("✅ ALL DONE!")
    print("=" * 60)
