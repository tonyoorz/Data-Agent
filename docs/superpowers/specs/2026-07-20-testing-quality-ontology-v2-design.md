# Testing & Quality Engineering Ontology V2 Design

- **Date:** 2026-07-20
- **Design status:** Review candidate
- **Target repository:** `/Users/tonyorz/Data-Agent`
- **Target runtime:** Node Main Agent Runtime + Python Analytics service
- **Ontology release:** `testing-quality-v2`

## 1. Outcome

This design upgrades Data-Agent from a small Ontology V1 catalog plus page-oriented analytics into a complete, governed Testing & Quality Engineering semantic kernel.

The release covers five bounded contexts as one coherent ontology:

1. Defect Management
2. Test Management
3. Traceability
4. Quality Intelligence
5. Organization & Product Context

The release is complete only when all five contexts have executable objects, relationships, dimensions, metrics, vocabulary, source bindings, policies, context packs, query support, evidence contracts, tests, and Agent integration. Internal delivery order does not make any context optional.

### 1.1 Terminology decisions

- **QGate** is the department shorthand for the **Defect Management** bounded context. It is not the name of the whole testing ontology and is not a standalone business object.
- **Octane** is a physical source system. It must appear in source bindings and lineage, not as the business-domain name.
- **Top Issue** is a governed analysis product over Defect Management facts. It is not a source entity.
- **Weekly report** is a governed report definition and a lineage-bearing report run. The report may combine defects, test execution, coverage, and traceability.
- **Coverage** is ambiguous without a subject. The resolver distinguishes testcase execution coverage, requirement coverage, and traceability coverage.
- **Module / 模块** is not globally equivalent to `assigned_ecu`. Resolution must expose the relevant candidate dimensions and record the selected meaning.

### 1.2 Scope closure

This release is a read-only intelligent-question-answering and analysis ontology. It includes all semantic and analytical capabilities required by the five bounded contexts above.

The following are deliberately outside this system boundary:

- creating or updating Octane defects, testcases, runs, or requirements;
- executing tests against vehicles or benches;
- test-step authoring workflows;
- replacing Octane as the system of record;
- introducing a separate graph database.

These are exclusions, not empty extension points. The V2 catalog must not contain non-executable stubs for them.

## 2. Current-state audit

### 2.1 Assets to preserve

The current branch already contains useful V1 foundations:

- versioned JSON sources under `ontology/v1`;
- JSON Schema validation and a deterministic compiler;
- a compiled artifact and SHA-256 fingerprint;
- Node registry, resolver, time resolver, scope policy, planner, and compiler;
- Python Ontology loader and `/api/semantic/query`;
- actor-scope validation and confidential-field pseudonymization;
- source-revision and evidence metadata;
- defect, test-run, testcase, and traceability read paths;
- Main Agent Runtime evidence and claim gates;
- semantic golden tests and focused Node/Python contract tests.

V2 extends these foundations rather than creating a second semantic stack.

### 2.2 Audited V1 limitations

The current V1 catalog contains 19 entities, 15 relationships, 22 dimensions, 22 metrics, and 37 vocabulary terms. Only 8 metrics are approved and executable; 14 metrics are draft.

The main gaps are:

| Area | Current behavior | V2 correction |
|---|---|---|
| Domain naming | `quality.qgate` is a draft entity | Remove it; map QGate to the Defect Management bounded context |
| Metric coverage | Only basic defect and test counts execute | Implement the complete governed metric catalog in this design |
| Physical alignment | Ontology advertises fields not present in defect rows | Compile source capabilities from real materialized schemas |
| Available defect fields | `solution_cluster`, `defect_category`, and outcome flags exist but are under-modeled | Promote them into governed dimensions and metrics |
| Records | `query_semantic_records` calls the aggregate executor | Implement allowlisted row retrieval, stable pagination, and snapshot-bound drilldown |
| Comparison | Missing groups disappear and only overall deltas are derivable | Zero-fill groups and return per-group delta/growth semantics |
| Multi-step analysis | Planner mostly splits multiple metrics | Support result-driven aggregate → select → analyze → records plans |
| Traceability | Special-case route and response shape | Execute through the same typed traversal/evidence kernel |
| Reports | Business rules are duplicated in page/report functions | Move definitions into metrics and analysis-product recipes |
| Source revisions | Some test and trace queries hash live rows and are unpinned | Use one explicit snapshot/revision set for every multi-step run |
| Missing data | Entire unavailable dimensions can appear as `(missing)` | Fail unavailable dimensions; allow missing labels for row-level nulls only |
| Vocabulary | Chinese/English terminology coverage is narrow | Ship complete bilingual vocabularies and ambiguity policies |

### 2.3 Verified baseline

The focused Python baseline is currently:

```text
python3 -m pytest \
  backend/tests/test_ontology_contract.py \
  backend/tests/test_semantic_query_api.py -q

27 passed
```

The local shell currently resolves Node `v22.22.3`, while `.nvmrc` requires `24.14.0`. Node conclusions must use the repository version before qualification.

The existing user-owned modification to `backend/database/ticket_embeddings.db` is unrelated and must remain untouched.

## 3. Architecture

### 3.1 Chosen architecture

V2 is a governed semantic kernel inside the existing FastAPI + Node Runtime architecture.

```text
User question
  -> model proposes a constrained semantic candidate
  -> deterministic resolver binds stable Ontology IDs
  -> policy and capability validator
  -> dependency-aware query plan
  -> controlled aggregate / compare / records / traverse primitives
  -> snapshot-bound Evidence
  -> deterministic derived facts
  -> claim validation
  -> answer or focused clarification
```

The model may propose intent and candidate concepts. It cannot invent columns, formulas, joins, permissions, or SQL.

### 3.2 Four layers

#### Layer A: Domain Ontology

Defines business identity and meaning:

- bounded contexts;
- entities and properties;
- relationships and cardinality;
- dimensions and controlled values;
- metrics and formula ASTs;
- analysis products;
- bilingual vocabulary;
- context packs;
- ownership and effective dates.

#### Layer B: Physical Binding & Capability Catalog

Defines what the current data can execute:

- source system, database, table, and column;
- physical type and normalized type;
- materialization rule;
- join key and cardinality evidence;
- snapshot strategy and freshness;
- non-null coverage and value-domain profile;
- field sensitivity;
- capability state: `active`, `degraded`, or `unavailable`.

An unavailable binding remains visible to governance diagnostics but is excluded from executable resolver candidates.

#### Layer C: Compiled Runtime Ontology

The compiler validates cross-references and emits a single immutable bundle containing:

- only deployable business definitions;
- executable capabilities;
- deterministic vocabulary indexes;
- formula plans;
- permitted join paths;
- policies and constraints;
- context-pack indexes;
- the catalog fingerprint.

#### Layer D: Semantic Execution Runtime

The Python Analytics service executes controlled operations. The Node Runtime owns conversation state, semantic resolution, planning, recovery, evidence, and claim validation.

### 3.3 Logical graph, relational execution

Relationships form a logical business graph, but physical execution remains on canonical relational read models and an edge read model.

This is a firm V2 decision:

- no Neo4j or other graph database;
- no arbitrary recursive traversal;
- only allowlisted paths with declared direction, cardinality, explosion policy, and maximum depth;
- aggregate workloads remain on indexed SQLite read models;
- traceability traversals use `semantic_trace_edges`.

This matches the current data volume, deployment model, and operational skill set while preserving graph semantics.

### 3.4 One V2 release, no deployable drafts

`ontology/v2` may be compiled for development only when all release invariants pass. The production bundle must have:

- zero draft entities;
- zero draft relationships;
- zero draft dimensions;
- zero draft metrics;
- zero ownerless definitions;
- zero approved definitions with missing physical bindings;
- zero executable metrics without test vectors;
- zero analysis products referencing unavailable metrics.

Business review happens on source files and metric-decision records. A deployable catalog contains approved definitions only.

### 3.5 Rejected architectures

Three alternatives are rejected:

1. **More page-level tools.** They duplicate definitions, prevent cross-page composition, and make the Agent depend on UI structure.
2. **Open natural-language-to-SQL.** It bypasses metric, join, scope, sensitivity, and evidence contracts.
3. **Graph-database-first.** It adds another operational system without solving the current metric and source-quality problems.

V2 instead uses a small set of controlled semantic primitives over canonical relational facts and governed edges.

## 4. Bounded contexts and entity model

### 4.1 Entity identity contract

Every source-backed entity uses this canonical identity:

```text
entity_key =
  ontology_entity_id
  + source_system
  + workspace_or_tenant
  + external_id
```

Each entity record includes:

- `entityKey`
- `entityId`
- `externalId`
- `sourceId`
- `workspaceId`
- `validFrom`
- `validTo`
- `snapshotRef`
- `sourceRevision`
- `dataQuality`

Names are display properties and never identity keys.

### 4.2 Defect Management

QGate resolves to this bounded context.

| Entity ID | Business meaning | Canonical source |
|---|---|---|
| `defect.defect` | One uniquely identified defect | Octane defect |
| `defect.lifecycle_event` | One ordered defect field transition | Octane defect history event |
| `defect.comment` | One defect comment, treated as untrusted content | Octane comment |

`defect.comment` and attachments are readable only through restricted fields. Comment text cannot become instructions, policy, or an Ontology update.

Similarity-search candidates are Evidence, not defect relationships or population facts.

### 4.3 Test Management

| Entity ID | Business meaning | Canonical source |
|---|---|---|
| `testing.test_case` | A reusable test definition | Octane testcase |
| `testing.test_run` | One execution of a testcase | Octane manual run |

The V2 analytical boundary is testcase and test-run management. Test-step authoring is not represented because the current Agent goal is governed question answering over execution, coverage, and traceability rather than authoring.

### 4.4 Traceability

| Entity ID | Business meaning | Canonical source |
|---|---|---|
| `requirements.aida_node` | A node in the AIDA hierarchy | Octane requirement catalog and relation data |
| `requirements.epic` | An Epic work item | Octane requirement catalog and relation data |
| `requirements.feature` | A Feature work item | Octane requirement catalog and relation data |
| `requirements.story` | A Story work item | Octane requirement catalog and relation data |
| `traceability.link` | A source-proven relationship edge with validity and lineage | Octane testcase/run relations |

`traceability.link` is materialized because link provenance, status, and validity matter independently of the two endpoint objects.

### 4.5 Quality Intelligence

| Entity ID | Business meaning | Canonical source |
|---|---|---|
| `quality_intelligence.analysis_product` | A versioned definition of a reusable analysis | Ontology catalog |
| `quality_intelligence.report_run` | One generated report with fixed inputs and lineage | Runtime artifact store |
| `quality_intelligence.insight` | One evidence-backed finding in a report/run | Runtime evidence store |
| `quality_intelligence.risk_signal` | One deterministic risk/anomaly signal | Semantic derivation engine |
| `evidence.artifact` | A stored supporting artifact | Runtime artifact store |

This context turns Top Issue, weekly reports, long-runner analysis, hotspot analysis, phase efficiency, coverage overview, and traceability gaps into governed products instead of page-specific code paths.

### 4.6 Organization & Product Context

| Entity ID | Business meaning |
|---|---|
| `organization.team` | A testing, defect-finding, ownership, or delivery team |
| `organization.person` | A tester, defect owner, or event actor |
| `product.project` | A governed project scope |
| `product.release` | A release/scope boundary |
| `product.service_pack` | Service Pack |
| `product.pu` | Product Unit |
| `product.i_step` | Integration step/version |
| `product.os` | Operating-system generation |
| `product.platform` | Product/vehicle software platform |
| `product.ecu` | ECU |
| `product.solution_cluster` | Solution cluster |
| `product.defect_category` | Defect business category |
| `product.feature_region` | Feature region |
| `product.fv` | Governed FV value |
| `product.fvp` | Governed FVP value |
| `vehicle.model_series` | Lead model/model series |
| `market.market` | Market scope |

These objects are shared context. They do not belong to QGate.

## 5. Relationship model

Every relationship declares:

- stable relationship ID;
- source and target entity;
- direction and reversibility;
- cardinality;
- join fields;
- allowed join paths;
- explosion policy;
- temporal validity;
- source and source revision;
- actor-scope propagation;
- aggregation grain protection.

### 5.1 Defect relationships

| Relationship ID | From → To | Cardinality |
|---|---|---|
| `defect.defect.has_lifecycle_event` | defect → lifecycle event | one-to-many |
| `defect.defect.has_comment` | defect → comment | one-to-many |
| `defect.defect.detected_in_run` | defect → test run | many-to-one |
| `defect.defect.linked_to_testcase` | defect → testcase | many-to-many |
| `defect.defect.affects_aida_node` | defect → AIDA node | many-to-many |
| `defect.defect.affects_epic` | defect → Epic | many-to-many |
| `defect.defect.affects_feature` | defect → Feature | many-to-many |
| `defect.defect.affects_story` | defect → Story | many-to-many |
| `defect.defect.affects_ecu` | defect → ECU | many-to-one |
| `defect.defect.found_by_team` | defect → team | many-to-one |
| `defect.defect.owned_by_person` | defect → person | many-to-one |
| `defect.defect.belongs_to_project` | defect → project | many-to-one |
| `defect.defect.targets_release` | defect → release | many-to-one |

### 5.2 Test relationships

| Relationship ID | From → To | Cardinality |
|---|---|---|
| `testing.test_run.executes_testcase` | run → testcase | many-to-one |
| `testing.test_run.detected_defect` | run → defect | one-to-many |
| `testing.test_run.executed_by_person` | run → person | many-to-one |
| `testing.test_run.executed_by_team` | run → team | many-to-one |
| `testing.test_run.belongs_to_project` | run → project | many-to-one |
| `testing.test_run.targets_release` | run → release | many-to-one |
| `testing.test_case.belongs_to_project` | testcase → project | many-to-one |
| `testing.test_case.targets_release` | testcase → release | many-to-many |

### 5.3 Traceability relationships

| Relationship ID | From → To | Cardinality |
|---|---|---|
| `requirements.aida_node.parent_of_aida_node` | AIDA → AIDA | one-to-many |
| `requirements.epic.contains_feature` | Epic → Feature | one-to-many |
| `requirements.feature.contains_story` | Feature → Story | one-to-many |
| `testing.test_case.validates_aida_node` | testcase → AIDA | many-to-many |
| `testing.test_case.validates_feature` | testcase → Feature | many-to-many |
| `testing.test_case.validates_story` | testcase → Story | many-to-many |
| `testing.test_run.traces_to_aida_node` | run → AIDA | many-to-many |
| `testing.test_run.traces_to_epic` | run → Epic | many-to-many |
| `testing.test_run.traces_to_feature` | run → Feature | many-to-many |
| `testing.test_run.traces_to_story` | run → Story | many-to-many |

`traceability.link` stores `sourceEntityId`, `sourceEntityKey`, `targetEntityId`, and `targetEntityKey` as validated typed references. These provenance fields do not create a polymorphic join relationship; the compiler resolves them to one of the explicit relationships above.

### 5.4 Context relationships

| Relationship ID | From → To | Cardinality |
|---|---|---|
| `product.release.belongs_to_project` | release → project | many-to-one |
| `product.pu.belongs_to_service_pack` | PU → Service Pack | many-to-one |
| `product.i_step.implements_pu` | i-step → PU | many-to-many |
| `product.platform.runs_os` | platform → OS | many-to-one |
| `vehicle.model_series.uses_platform` | model series → platform | many-to-one |
| `organization.person.belongs_to_team` | person → team | many-to-one |

### 5.5 Quality Intelligence relationships

| Relationship ID | From → To | Cardinality |
|---|---|---|
| `quality_intelligence.report_run.instantiates_product` | report run → analysis product | many-to-one |
| `quality_intelligence.report_run.contains_insight` | report run → insight | one-to-many |
| `quality_intelligence.insight.supported_by_artifact` | insight → artifact | many-to-many |
| `quality_intelligence.insight.derived_from_signal` | insight → risk signal | many-to-many |

A risk signal carries a validated `subjectEntityId + subjectEntityKey` typed reference. The reference is evidence lineage, not an unrestricted polymorphic join path.

## 6. Dimension and vocabulary model

### 6.1 Dimension classes

V2 dimensions are grouped into:

- event time;
- snapshot state;
- controlled enum;
- organization;
- product;
- requirement hierarchy;
- source quality;
- derived business classification.

Each dimension declares:

- `id`
- `entityId`
- `propertyId`
- `valueType`
- `valueDomain`
- `closedEnum`
- `sourceReadModel`
- `availabilityRule`
- `allowedOperators`
- `missingValuePolicy`
- `sensitivity`
- `owner`
- `definitionVersion`

### 6.2 Required defect dimensions

- `time.defect_created_at`
- `time.defect_resolved_at`
- `time.defect_event_at`
- `defect.phase`
- `defect.phase_group`
- `defect.status`
- `defect.severity`
- `defect.classification`
- `defect.reporting_class`
- `defect.china_scope`
- `defect.is_resolved_forward`
- `defect.is_rejected_directly`
- `defect.is_active`
- `org.problem_finder_team`
- `org.defect_owner`
- `product.project`
- `product.release`
- `product.service_pack`
- `product.pu`
- `product.i_step`
- `product.os`
- `product.platform`
- `product.ecu`
- `product.solution_cluster`
- `product.defect_category`
- `product.feature_region`
- `product.fv`
- `product.fvp`
- `vehicle.model_series`
- `market.market`
- `requirements.aida`

### 6.3 Required test dimensions

- `time.test_run_started_at`
- `time.test_run_finished_at`
- `time.test_week`
- `testing.run_status`
- `testing.result_bucket`
- `testing.trace_status`
- `org.tester`
- `org.test_team`
- `product.project`
- `product.release`
- `product.pu`
- `product.feature_region`
- `product.fv`
- `product.fvp`
- `requirements.aida`

### 6.4 Required traceability dimensions

- `traceability.relation_type`
- `traceability.link_status`
- `traceability.source_type`
- `traceability.target_type`
- `traceability.path_completeness`
- `traceability.scope_team`
- `product.release`
- `requirements.aida`

### 6.5 Controlled value domains

Closed enums are normalized from the complete source value, not from the numeric prefix alone, and are stored with raw values. This matters because audited fixtures contain values such as `09-In Progress`, `09-Rejected`, and `09-Concluded without action`; the prefix `09` does not have one universal lifecycle meaning.

```text
defect.phase:
  NEW
  PRE_ANALYSIS
  IN_ANALYSIS
  IN_PROGRESS
  OPEN
  IN_VERIFICATION
  CONCLUDED
  CONCLUDED_WITHOUT_ACTION
  DEFERRED
  REJECTED
  OTHER
  UNKNOWN

testing.result_bucket:
  PASSED
  FAILED
  REQUIRES_ATTENTION
  PLANNED
  OTHER
  UNKNOWN

traceability.link_status:
  VALID
  BROKEN_SOURCE
  BROKEN_TARGET
  DUPLICATE
  UNKNOWN
```

Source values remain in `rawValue`. Analytics use canonical values.

Resolved-forward and direct-rejection outcomes are separate governed event rules. They are not inferred from the current phase or from a numeric prefix:

```text
resolved_forward:
  status-phase transition 08 -> 06

rejected_directly:
  status-phase transition 01 -> 09
```

The materializer preserves the full old/new values and records the rule version that produced each outcome flag.

### 6.6 Module resolution

The phrase “模块” produces an ambiguity set, not an automatic ECU binding:

1. `product.solution_cluster`
2. `product.defect_category`
3. `product.feature_region` or `requirements.aida`, when the question is feature-oriented
4. `product.ecu`, when the user explicitly means ECU/electronic module

For defect questions that request a generic business-module rollup and provide no clarification, V2 may use the explicit virtual dimension:

```text
product.business_module =
  first_non_blank(
    product.solution_cluster,
    product.defect_category,
    "UNCLASSIFIED"
  )
```

The result must return:

- `resolvedDimensionId=product.business_module`
- `resolutionPath`
- counts for `UNCLASSIFIED`
- an assumption in the SemanticFrame

It must never label this virtual dimension as ECU.

### 6.7 Core bilingual terms

The V2 vocabularies must include at least:

- QGate / 缺陷管理 → Defect Management context
- Octane → physical source
- 缺陷 / defect / bug / 问题单
- 新增、存量、在途、关闭、解决、拒绝、延期、重开
- Top Issue / 重点问题 / 高风险缺陷
- Long Runner / 长期未解决 / 老缺陷
- 测试用例、测试执行、Manual Run、通过、失败、需要关注、计划中
- 覆盖率、执行覆盖率、需求覆盖率、可追溯率
- Traceability / 追溯 / 追踪链路 / 未关联需求
- 周报、环比、同比、趋势、Top N、增长率
- Project、Release、Service Pack、PU、i-step、OS、Platform、ECU
- Solution Cluster、Defect Category、Feature Region、FV、FVP、AIDA
- 测试团队、发现团队、负责人、测试人员

## 7. Governed metric catalog

### 7.1 Metric contract

Every metric is executable through a typed formula AST, never a free SQL expression.

Each metric declares:

- stable ID and definition version;
- business label and description;
- base entity and grain;
- population predicate;
- formula AST;
- event-time dimension;
- allowed dimensions and filters;
- required scope;
- join paths and explosion policy;
- denominator and zero policy;
- missing/unknown policy;
- source read models;
- synchronization rule;
- owner and effective dates;
- test vectors.

Supported formula nodes are:

- `count_distinct`
- `conditional_count_distinct`
- `sum`
- `min`
- `max`
- `average`
- `percentile`
- `ratio`
- `difference`
- `duration_calendar_days`
- `duration_business_hours`
- `predicate`
- `metric_ref`

The compiler validates node types and references. No formula node accepts SQL text.

### 7.2 Defect Management metrics

| Metric ID | Governed definition |
|---|---|
| `defect.count` | Distinct defects in the selected cohort |
| `defect.created_count` | Distinct defects whose creation event is in the selected period |
| `defect.active_count` | Current defects whose full-value canonical phase is not terminal; numeric phase prefixes alone are insufficient |
| `defect.concluded_count` | Distinct defects with a transition into `CONCLUDED` in the selected period |
| `defect.concluded_without_action_count` | Distinct defects with a transition into canonical `CONCLUDED_WITHOUT_ACTION` |
| `defect.rejected_count` | Distinct defects matching the approved direct-rejection event rule; this is the compatibility business label |
| `defect.verification_to_concluded_count` | Distinct defects with `IN_VERIFICATION → CONCLUDED` |
| `defect.resolve_rate` | Defects in the selected creation cohort matching the approved resolved-forward rule divided by all defects in that creation cohort |
| `defect.rejection_rate` | Defects in the selected creation cohort matching the approved direct-rejection rule divided by all defects in that creation cohort |
| `defect.age_days_avg` | Average calendar age of active defects at snapshot time |
| `defect.age_days_p90` | P90 calendar age of active defects at snapshot time |
| `defect.long_runner_count` | Active defects older than 30 calendar days |
| `defect.severe_long_runner_count` | Active defects older than 60 calendar days |
| `defect.critical_active_count` | Active defects with canonical severity `SHOWSTOPPER` or `CRITICAL` |
| `defect.phase_transition_count` | Count of valid lifecycle transitions |
| `defect.phase_transition_avg_business_days` | Average business-day duration per selected transition |
| `defect.phase_transition_p90_business_days` | P90 business-day duration per selected transition |
| `defect.reopen_count` | Distinct defects transitioning from a terminal phase to a non-terminal phase |
| `defect.top_issue_count` | Active defects in governed Top Issue severity classes |

Duplicate similarity has no population metric in V2. It remains record-level Evidence until a confirmed source relationship exists; a similarity score cannot be converted into a duplicate rate.

### 7.3 Test Management metrics

| Metric ID | Governed definition |
|---|---|
| `testing.testcase_count` | Distinct eligible testcases in scope |
| `testing.run_count` | Distinct manual runs in scope |
| `testing.executed_testcase_count` | Distinct testcases with at least one non-planned run |
| `testing.planned_run_count` | Distinct runs in canonical `PLANNED` state |
| `testing.completed_run_count` | Distinct runs with result `PASSED`, `FAILED`, or `REQUIRES_ATTENTION` |
| `testing.passed_run_count` | Distinct runs with canonical result `PASSED` |
| `testing.failed_run_count` | Distinct runs with canonical result `FAILED` |
| `testing.requires_attention_run_count` | Distinct runs with canonical result `REQUIRES_ATTENTION` |
| `testing.other_result_run_count` | Distinct runs with result `OTHER` or `UNKNOWN` |
| `testing.pass_rate` | `passed / (passed + failed)`; zero denominator returns unknown, not zero |
| `testing.fail_rate` | `failed / (passed + failed)`; zero denominator returns unknown, not zero |
| `testing.testcase_execution_coverage_rate` | `executed_testcase_count / testcase_count` under the same project/release scope |
| `testing.unexecuted_testcase_count` | Eligible testcases with no non-planned run |
| `testing.run_duration_avg_hours` | Average valid `finished - started` duration |
| `testing.run_duration_p90_hours` | P90 valid `finished - started` duration |
| `testing.active_tester_count` | Distinct authorized testers with at least one run |

Individual tester metrics are confidential. Aggregate team results are permitted; raw identities require an explicit field policy.

### 7.4 Traceability metrics

| Metric ID | Governed definition |
|---|---|
| `traceability.requirement_count` | Distinct eligible requirement/AIDA nodes in the selected scope |
| `traceability.covered_requirement_count` | Eligible requirements linked to at least one eligible testcase |
| `traceability.requirement_coverage_rate` | `covered_requirement_count / requirement_count` |
| `traceability.traced_testcase_count` | Eligible testcases linked to at least one requirement |
| `traceability.testcase_traceability_rate` | `traced_testcase_count / testing.testcase_count` |
| `traceability.traced_run_count` | Runs whose testcase or run has a valid requirement link |
| `traceability.run_traceability_rate` | `traced_run_count / testing.run_count` |
| `traceability.end_to_end_chain_count` | Distinct valid requirement → testcase → run paths |
| `traceability.end_to_end_chain_rate` | Requirements with a valid requirement → testcase → run path divided by eligible requirements |
| `traceability.orphan_testcase_count` | Eligible testcases with no valid requirement link |
| `traceability.broken_link_count` | Trace links with a missing or invalid endpoint |
| `traceability.defect_linked_run_count` | Defects connected to a testcase/run through valid links |
| `traceability.defect_test_trace_rate` | Defects with a valid testcase/run link divided by selected defects |

Requirement coverage can execute only when the requirement population is materialized for the selected project/release. A relation-only source cannot masquerade as the full denominator.

### 7.5 Quality Intelligence metrics

| Metric ID | Governed definition |
|---|---|
| `quality.weekly_defect_inflow` | Defects created in an ISO week |
| `quality.weekly_defect_outflow` | Defects entering a governed terminal outcome in an ISO week, with outcome components returned separately |
| `quality.weekly_net_defect_change` | `weekly_defect_inflow - weekly_defect_outflow` |
| `quality.defects_per_100_completed_runs` | `defect.created_count / testing.completed_run_count * 100` on one synchronized revision set |
| `quality.hotspot_top5_share` | Share of defects in the five largest selected dimension groups |
| `quality.defect_history_coverage_rate` | Defects with usable lifecycle history divided by selected defects |

Cross-source ratios require a shared snapshot manifest. If either source is stale or unsynchronized, the metric returns unavailable with a safe reason.

### 7.6 Compatibility aliases

The following V1 IDs remain aliases, not duplicate formulas:

- `team.execution_count` → `testing.run_count` grouped by `org.test_team`
- `team.defect_discovery_count` → `defect.created_count` grouped by `org.problem_finder_team`
- `defect.direct_rejection_count` → `defect.rejected_count`
- `testing.requirement_coverage_rate` → `traceability.requirement_coverage_rate`
- `testing.traceability_rate` → subject-specific traceability metric selected by resolver

`defect.repeat_rate`, `team.discovery_efficiency`, and `quality.defect_density` are removed because their current denominators or confirmed populations are not governed. The supported, explicit cross-domain replacement is `quality.defects_per_100_completed_runs`.

## 8. Analysis products

Analysis products are versioned recipes over primitives. A recipe cannot call a page endpoint.

### 8.1 Required products

| Product ID | Purpose | Mandatory outputs |
|---|---|---|
| `analysis.weekly_quality_report` | Department weekly report | inflow/outflow/net, active/critical/long-runner, run/pass/fail, execution coverage, traceability gaps, Top Issue records |
| `analysis.top_issue` | Ranked high-risk active defects | governed filters, severity-first rank, age, owner/team/project context, record evidence |
| `analysis.long_runner` | Aging defect analysis | count, average/P90 age, 30/60-day buckets, records |
| `analysis.defect_hotspot` | High-frequency group analysis | explicit group dimension, Top groups, share, secondary severity/status analysis, records |
| `analysis.phase_efficiency` | Defect lifecycle efficiency | transition count, average/P90 business days, coverage rate, records |
| `analysis.test_coverage_overview` | Test execution and coverage | testcase/run counts, pass/fail, execution coverage by project/release/AIDA |
| `analysis.traceability_gap` | Missing/broken trace analysis | coverage rates, orphan/broken counts, traversed paths, gap records |
| `analysis.team_project_comparison` | Controlled comparison | same metrics, same time/snapshot, per-group deltas |

### 8.2 Top Issue rule

The default Top Issue selection is:

```text
is_active = true
AND severity IN (SHOWSTOPPER, CRITICAL, MAJOR)
ORDER BY
  severity_rank ASC,
  age_days DESC,
  defect_id ASC
LIMIT policy.max_top_issue_records
```

The rule returns the applied severity set and snapshot date. Users may override filters, but the result must state the override.

### 8.3 Weekly report recipe

The weekly report runs on one ISO week and one pinned `sourceRevisionSet`.

Sections:

1. Scope and source health
2. Defect inflow, outflow, net change, active inventory
3. Critical and long-runner defects
4. Test execution, pass/fail, and coverage
5. Requirement/test/run traceability
6. Top Issue records
7. Largest changes by an explicit dimension
8. Evidence references and completeness warnings

The report title may use the department’s preferred display name. Its semantic product ID stays `analysis.weekly_quality_report`, not QGate.

## 9. Canonical physical read models

Dashboard-specific payloads are not the semantic execution boundary. V2 introduces canonical snapshot tables.

Canonical source IDs are:

- `source.octane.defects`
- `source.octane.defect_history`
- `source.octane.comments`
- `source.octane.testcases`
- `source.octane.manual_runs`
- `source.octane.requirements`
- `source.octane.traceability`
- `source.duplicate_search`
- `source.runtime_artifacts`

The existing `qgate_raw.db` filename may remain as a compatibility storage path, but the catalog and Evidence use the source IDs above. Requirement ingestion must materialize the complete eligible project/release population; trace relations alone are not an acceptable denominator source.

### 9.1 `semantic_defect_facts`

One row per `snapshot_ref + defect_id`.

Required columns:

- identity and revision fields;
- name, creation time, current phase/status;
- severity, classification, reporting class;
- finder team, owner;
- project, release, service pack, PU, i-step, OS, platform, ECU;
- solution cluster, defect category, feature region, FV, FVP;
- AIDA/requirement references;
- market, model series;
- active/terminal flags;
- resolved-forward/direct-rejection flags;
- source-field availability bitmap.

### 9.2 `semantic_defect_events`

One row per normalized lifecycle event:

- event ID and sequence;
- defect ID;
- event timestamp;
- field ID;
- old/new raw value;
- old/new canonical value;
- actor;
- valid transition flag;
- duration from previous event;
- source revision.

### 9.3 `semantic_testcase_facts`

One row per `snapshot_ref + testcase scope + testcase_id`:

- testcase identity and name;
- project/release/team scope;
- PU/AIDA/feature context;
- eligible-for-coverage flag;
- relation counts;
- trace status;
- source revision.

### 9.4 `semantic_testrun_facts`

One row per `snapshot_ref + run_id`:

- run and testcase IDs;
- raw and canonical status;
- started/finished time and valid duration;
- ISO test week;
- project/release/team/tester;
- PU/AIDA/feature region/FV/FVP;
- linked defect IDs;
- source revision.

### 9.5 `semantic_trace_edges`

One row per canonical edge:

- edge ID;
- source entity type/key;
- target entity type/key;
- relation type;
- source relation type;
- project/release/team scope;
- valid/broken status;
- source and fetched time;
- snapshot reference.

### 9.6 `semantic_context_nodes`

One row per organization/product/requirement context object with:

- canonical ID and type;
- display name and normalized name;
- parent key;
- source scope;
- effective dates;
- aliases;
- source revision.

### 9.7 Snapshot manifest

Every materialization creates:

```ts
type SemanticSnapshotManifest = {
  snapshotRef: string;
  createdAt: string;
  timezone: "Asia/Shanghai";
  ontologyVersion: "testing-quality-v2";
  ontologyFingerprint: string;
  sources: Array<{
    sourceId: string;
    revisionId: string;
    watermark: string;
    rowCount: number;
    freshnessStatus: "fresh" | "stale" | "unknown";
  }>;
  readModels: Array<{
    readModel: string;
    schemaFingerprint: string;
    rowCount: number;
    status: "ready" | "degraded" | "unavailable";
  }>;
};
```

All steps in one Agent analysis use the same `snapshotRef`. A refresh creates a new snapshot; it never mutates an existing one.

## 10. Source capability and missing-data semantics

### 10.1 Capability compilation

The V2 compiler consumes a generated physical profile:

```text
physical-profile.json
  source schemas
  field types
  non-blank coverage
  distinct-value samples
  join-key uniqueness
  snapshot/watermark state
  schema fingerprints
```

For every dimension and metric, compilation proves:

- all referenced source fields exist;
- types are compatible;
- required read models are ready;
- join paths are materialized;
- cardinality checks pass within tolerance;
- required enum mappings exist;
- the metric formula is executable.

### 10.2 Zero, missing, unknown, unavailable

These states are never conflated:

- `zero`: the governed population was evaluated and the count is 0;
- `missing`: a row exists but a property is null/blank;
- `unknown`: a value exists but cannot be normalized;
- `unavailable`: the source/binding/population required to evaluate the question is absent;
- `not_applicable`: the property does not apply to the object;
- `truncated`: only a bounded subset is returned.

If an entire queried dimension has no executable source field, execution returns `SEMANTIC_DIMENSION_UNAVAILABLE`. It must not return a single `(missing)` group.

Row-level missing groups are returned only when `includeMissing=true`, with a missing count and completeness metadata.

## 11. Semantic query primitives

### 11.1 Public tool surface

The Main Agent receives a small composable tool surface:

1. `query_semantic_metrics`
2. `query_semantic_records`
3. `query_semantic_traverse`
4. `lookup_ontology_concepts`
5. `search_duplicates` through the existing adapter

`query_traceability` remains a compatibility adapter to `query_semantic_traverse` until all internal callers migrate within this program.

### 11.2 Query contract

```ts
type SemanticQueryV2 = {
  schemaVersion: "2.0";
  ontologyVersion: "testing-quality-v2";
  ontologyFingerprint: string;
  snapshotRef?: string;
  operation: "aggregate" | "trend" | "compare" | "rank" | "records" | "traverse";
  entityIds: string[];
  metricIds: string[];
  groupBy: Array<{
    dimensionId: string;
    bucket?: "day" | "iso_week" | "month" | "quarter" | "year";
    includeMissing?: boolean;
  }>;
  filters: FilterExpression;
  timeScopes: TimeScope[];
  comparison?: {
    kind: "periods" | "dimension_values";
    groups: string[];
    zeroFill: true;
    minimumBaselineCount: number;
  };
  sort: Array<{ fieldId: string; direction: "asc" | "desc" }>;
  limit: number;
  records?: {
    selectFields: string[];
    cursor?: string;
    pageSize: number;
    drilldownRef?: string;
  };
  traversal?: {
    startEntityKeys: string[];
    relationshipIds: string[];
    direction: "outbound" | "inbound" | "both";
    maxDepth: number;
  };
};
```

Filters support typed `and`, `or`, `not`, predicates, ranges, null checks, and canonical enum values. Every property and value is validated against the compiled catalog.

### 11.3 Aggregate and trend

The aggregate executor:

- chooses a declared fact read model;
- applies policy filters before user filters;
- validates metric grain against group dimensions;
- uses distinct keys to prevent join inflation;
- supports multiple compatible metrics in one physical scan;
- returns total group count separately from source row count;
- reports exact truncation.

Trend is aggregate with a governed time bucket. ISO week uses `Asia/Shanghai` and ISO week-year semantics.

### 11.4 Compare

Comparison output is per metric and group:

```ts
type ComparisonCell = {
  group: Record<string, string>;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  growthPct: number | null;
  isNew: boolean;
  isGone: boolean;
  baselineBelowThreshold: boolean;
};
```

Rules:

- union current and baseline group keys;
- zero-fill only metrics whose zero policy allows it;
- `growthPct=null` when baseline is zero;
- set `isNew=true` when current is positive and baseline is zero;
- do not rank unstable growth unless baseline meets `minimumBaselineCount`;
- return `totalGroups`, `returnedGroups`, and `truncated`.

### 11.5 Records

Records are real entity rows, not grouped counts.

Requirements:

- `selectFields` is checked against an entity-specific allowlist;
- primary key and stable sort are always present;
- cursor is opaque, snapshot-bound, scope-bound, and query-hash-bound;
- `pageSize` is policy-limited;
- confidential fields require explicit field policy;
- comments and attachment text are excluded by default;
- every response returns `snapshotRef`, `drilldownRef`, `nextCursor`, `totalKnown`, and field-level missingness;
- a stale cursor returns a stable conflict code.

### 11.6 Traverse

Traversal:

- starts from explicit entity keys or a prior `drilldownRef`;
- uses only approved relationship IDs;
- validates direction and depth;
- preserves actor scope across every hop;
- enforces explosion limits;
- returns nodes, edges, path completeness, and broken-link diagnostics;
- never converts a similarity result into a graph fact.

### 11.7 Dependent multi-step plans

The planner supports deterministic data dependencies:

```text
s1 aggregate defects by business module
s2 select top/high-growth groups from s1
s3 aggregate selected groups by severity/status
s4 fetch allowlisted defect records for selected groups
s5 derive claims from s1+s3+s4
```

Plan transforms are allowlisted:

- `select_top_groups`
- `select_growth_outliers`
- `extract_filter_values`
- `project_entity_keys`
- `join_compatible_evidence`

Transforms cannot execute code or SQL.

## 12. Evidence and claim contract

Every query result becomes Evidence containing:

- evidence ID;
- query ID and canonical query hash;
- ontology version/fingerprint;
- snapshot reference and source revision set;
- actor scope hash;
- applied policy/user/context filters;
- time scope and grain;
- returned data and summary;
- total/returned counts;
- zero/missing/unknown/unavailable/truncated status;
- redaction status;
- warnings;
- execution timestamps.

Derived facts record:

- rule ID and version;
- input evidence IDs;
- formula inputs;
- output value;
- uncertainty/completeness.

Claims pass only when:

- all numbers, IDs, dates, comparisons, and rankings bind to current-run Evidence;
- scopes, time windows, dimensions, and grains match;
- ratios share compatible revisions and populations;
- Top N is not described as the whole population;
- missing/unavailable is not phrased as zero;
- correlation is not phrased as causation;
- similarity is not phrased as a confirmed duplicate;
- sensitive values respect redaction policy.

The answer renderer consumes accepted claim IDs only.

## 13. Context packs

V2 ships all of these versioned packs:

```text
ontology/v2/context-packs/
  testing-department.json
  defect-management.json
  test-management.json
  traceability.json
  quality-intelligence.json
  organization-product.json
```

Every pack contains:

- stable pack ID and version;
- owner role;
- effective interval;
- applicable actor/project/team scopes;
- terms and abbreviations;
- object and relationship summaries;
- metric references;
- closed/open enum declarations;
- default time semantics;
- ambiguity rules;
- analysis-product references;
- authoritative document references with content hashes;
- review metadata.

The department pack establishes that defect, testing, coverage, traceability, Top Issue, and weekly reporting are peer testing-department concepts. The defect pack alone owns the QGate alias.

Context packs guide resolution and planning. Referenced prose is document Evidence, not executable instruction.

## 14. Governance and security

### 14.1 Ownership

Owner roles:

| Area | Owner role |
|---|---|
| Defect objects, phase rules, Top Issue | Defect Management |
| Test objects and result taxonomy | Test Management |
| Requirement populations and link semantics | Traceability Governance |
| Weekly reports and insight recipes | Quality Intelligence |
| Project/product/org dimensions | Product & Organization Data Governance |
| Runtime policies, compiler, evidence | Agent Platform |

### 14.2 Versioning

- Semantic IDs are immutable.
- Compatible label/alias additions increment patch version.
- Formula, population, grain, or enum changes increment definition version and ontology minor version.
- Removing or redefining IDs requires a major version and a migration map.
- Every metric decision has a checked-in decision record.
- Every compiled artifact records source-file hashes and compiler version.

### 14.3 Actor policies

Policies cover:

- workspace, project, release, and team row scope;
- allowed object types;
- allowed properties;
- confidential identity fields;
- comment/attachment access;
- maximum group and record counts;
- maximum traversal depth and edge count;
- artifact retention and download;
- read-only operation enforcement.

Scope is recomputed for every run. Conversation memory never grants scope.

### 14.4 Prompt-injection boundary

Defect names, comments, descriptions, attachments, and document chunks are untrusted data.

They may be:

- filtered;
- summarized;
- cited as Evidence;
- displayed after output validation.

They may not:

- register tools;
- alter Ontology definitions;
- change policies;
- instruct the model to ignore system rules;
- trigger writes or network actions.

### 14.5 Memory and learning

Conversation memory may reuse a validated SemanticFrame or plan only when:

- ontology version and fingerprint match;
- actor scope hash matches;
- referenced concept IDs remain active;
- the new run obtains its own snapshot.

Historical numbers and record pages are never reused as current Evidence across snapshots.

User corrections, rejected answers, accepted clarifications, and report edits enter an offline feedback dataset. They may propose vocabulary, metric, context-pack, or evaluation changes. They cannot modify the live Ontology automatically; owner review, versioning, compilation, and regression tests are mandatory.

## 15. Agent integration

### 15.1 Resolver

The resolver combines:

- deterministic term matching;
- bilingual aliases;
- governed value patterns;
- model-proposed candidates constrained to catalog IDs;
- prior validated SemanticFrame for elliptical follow-ups;
- current actor context;
- selected context-pack fragments.

Ambiguity is handled with one focused question when the answer materially changes the result, especially for:

- coverage subject;
- generic module;
- resolved/closed outcome;
- current snapshot versus creation cohort;
- comparison period;
- requirement hierarchy level.

### 15.2 Planner

The planner:

- validates the compiled fingerprint;
- injects mandatory scope filters;
- rejects unavailable fields and metrics;
- chooses compatible read models;
- creates dependent steps;
- pins one snapshot;
- carries a `drilldownRef`;
- emits typed tool arguments;
- records warnings and assumptions.

### 15.3 Runtime migration

V2 becomes the default semantic path after qualification.

Existing page endpoints remain as UI adapters over the same read models and metric definitions. They must not retain independent business formulas.

Existing V1 callers use an explicit ID migration map. The final program state has:

- V2 default in Node registry and Python loader;
- compatibility aliases for accepted V1 IDs;
- page endpoints backed by V2 primitives/read models;
- no `quality.qgate` entity;
- no draft metric exposed to the Agent;
- no page-only metric formula.

Duplicate Search internals remain unchanged. Only its tool adapter and evidence normalization participate in the Runtime.

## 16. File and module boundaries

### 16.1 Ontology sources

```text
ontology/schema/v2/
  common.schema.json
  manifest.schema.json
  sources.schema.json
  entities.schema.json
  relationships.schema.json
  dimensions.schema.json
  metrics.schema.json
  vocab.schema.json
  analysis-products.schema.json
  context-pack.schema.json
  policies.schema.json
  constraints.schema.json
  physical-profile.schema.json

ontology/v2/
  manifest.json
  sources.json
  entities.json
  relationships.json
  dimensions.json
  metrics.json
  vocab.zh-CN.json
  vocab.en-US.json
  analysis-products.json
  policies.json
  constraints.json
  metric-decisions/
  context-packs/

ontology/generated/v2/
  physical-profile.json
  ontology.compiled.json
  fingerprint.txt
  capability-report.json
  id-migration-v1.json
```

Generated files are never edited by hand.

### 16.2 Python Analytics

```text
backend/analytics/semantic/
  catalog.py
  contracts.py
  physical_profile.py
  snapshot_manifest.py
  materialize_defects.py
  materialize_tests.py
  materialize_traceability.py
  materialize_context.py
  metric_ast.py
  aggregate.py
  compare.py
  records.py
  traverse.py
  evidence.py
  service.py
```

`backend/analytics/api.py` remains a thin HTTP layer.

### 16.3 Node Runtime

```text
server/ontology/
  registry.mjs
  semanticFrame.mjs
  resolver.mjs
  timeResolver.mjs
  scopePolicy.mjs
  queryCompiler.mjs
  queryPlanner.mjs
  resultTransforms.mjs
  contextPacks.mjs
  ontologyClient.mjs
  validator.mjs
```

The existing Runtime graph must call these gates; a model cannot bypass them.

## 17. Mandatory implementation work packages

This program is decomposed for safe implementation and review. Every package is mandatory.

### Package A: V2 schema, compiler, and release invariants

- V2 JSON Schemas
- manifest and domain ownership
- formula AST validation
- context-pack and analysis-product validation
- physical capability compilation
- fingerprint and ID migration
- zero-draft release gate

### Package B: Canonical snapshots and physical profiles

- semantic snapshot manifest
- defect facts/events
- testcase/run facts
- trace edges
- context nodes
- source profiling and capability states
- atomic refresh and immutable revisions

### Package C: Complete business catalog

- all five bounded contexts
- entities, relationships, dimensions
- bilingual vocabularies
- metric decisions and approved metric catalog
- policies and constraints
- all context packs

### Package D: Controlled query kernel

- typed filters and time semantics
- aggregate/trend/rank
- zero-safe compare
- real records with cursor/drilldown
- governed traversal
- field redaction and availability errors

### Package E: Agent resolver and dependent planning

- V2 SemanticFrame
- ambiguity handling
- business-module resolution
- context-pack retrieval
- dependent plan transforms
- one-snapshot propagation

### Package F: Quality Intelligence products

- weekly quality report
- Top Issue
- long runner
- defect hotspot
- phase efficiency
- test coverage overview
- traceability gap
- team/project comparison

### Package G: Evidence, claims, compatibility, and cutover

- V2 evidence envelope
- derived fact rules
- claim validation
- V1 ID compatibility map
- page/API adapters
- semantic and report parity tests
- qualification and V2 default cutover

## 18. Verification strategy

### 18.1 Compiler tests

- schema validation for every source file;
- duplicate ID/property detection;
- cross-reference validation;
- formula AST validation;
- approved-definition source binding;
- join-path and cardinality validation;
- context-pack reference validation;
- no-draft release invariant;
- deterministic compile and fingerprint.

### 18.2 Materialization tests

- source schema variants and migrations;
- normalization of phase/status/result enums;
- current-state and event-time correctness;
- immutable snapshot behavior;
- row counts and distinct identities;
- broken-link materialization;
- field availability and non-blank coverage;
- no mutation of source databases.

### 18.3 Query tests

- each approved metric against fixed fixtures;
- every allowed group/filter/time dimension;
- rejected unavailable dimensions;
- exact zero/missing/unknown semantics;
- comparison zero filling, delta, growth, new/gone groups;
- exact total/returned/truncated metadata;
- records field allowlists and stable cursors;
- traversal direction/depth/explosion controls;
- actor scope and redaction;
- stale snapshot/cursor conflicts.

### 18.4 Semantic golden tests

Goldens cover mixed Chinese/English questions, including:

- QGate defect questions resolve only to Defect Management;
- testing, coverage, traceability, Top Issue, and weekly reports do not resolve to QGate by default;
- Octane resolves to source context, not a business object;
- “模块” yields candidates or the explicit business-module rule;
- “ECU 模块” resolves to ECU;
- unqualified “覆盖率” requests clarification;
- “先找增长最快的模块，再看严重度和样本” creates dependent steps;
- follow-up questions reuse the validated frame and pinned snapshot;
- unavailable fields produce a safe explanation, not `(missing)` results.

### 18.5 Product parity tests

For equivalent filters and snapshots:

- defect totals match the current Full Picture dataset;
- resolved-forward/direct-rejection flags match outcome materialization;
- testing totals match testing coverage snapshots;
- traceability counts match canonical edge populations;
- weekly report sections reconcile to underlying metrics;
- Top Issue records reconcile to the governed selection rule;
- page adapters and Agent queries return the same metric values.

### 18.6 Runtime and safety tests

- ontology fingerprint mismatch;
- stale source and partial completeness;
- checkpoint recovery with pinned snapshot;
- policy-denied object/property access;
- comment/attachment prompt injection;
- evidence/claim rejection;
- similarity-not-statistic;
- cross-source ratio synchronization;
- legacy compatibility aliases;
- Duplicate Search adapter regression.

### 18.7 Qualification commands

The implementation plan must produce exact commands using Node `24.14.0`, including:

```bash
npm run ontology:compile
npm run ontology:check
npm run semantic-golden:check
npm run runtime-target:check
npm run test:ontology
python3 -m pytest backend/tests -q
npm test -- --run
npm run build
```

Qualification reports observed results; it does not infer success from code inspection.

## 19. Acceptance criteria

V2 is complete when all conditions below hold:

1. QGate resolves only to Defect Management.
2. All five bounded contexts exist in the compiled catalog.
3. All entities and relationships in Sections 4–5 are approved and cross-reference valid.
4. All dimensions in Section 6 have executable bindings or are rejected by capability compilation; no whole dimension silently appears as missing.
5. All metrics in Section 7 have typed formulas, owners, test vectors, and executable providers.
6. All analysis products in Section 8 execute through semantic primitives.
7. Every multi-step analysis uses one immutable snapshot and source revision set.
8. `query_semantic_records` returns allowlisted records with cursor and drilldown metadata.
9. Comparison returns per-group current, baseline, delta, growth, and new/gone semantics.
10. Traceability runs through the governed traversal kernel.
11. “模块” never silently means ECU.
12. Weekly report, Top Issue, long runner, hotspot, phase efficiency, coverage, and traceability-gap products are Agent-callable.
13. Actor scope and confidential fields are enforced in both Node and Python.
14. Claims are rendered only after Evidence validation.
15. The deployable V2 bundle contains no draft business definition.
16. V1 accepted IDs migrate through explicit aliases; `quality.qgate` is absent.
17. Existing Duplicate Search internals are unchanged.
18. The focused and full qualification suites pass under the repository Node/Python environment.
19. The modified `backend/database/ticket_embeddings.db` is neither staged nor changed by this work.
20. V2 is the default Main Agent semantic path and the UI/report adapters use the same governed definitions.

## 20. Design consequences

### Benefits

- The Agent reasons in testing-department concepts rather than page names.
- Defect, testing, coverage, traceability, and reporting share one governed vocabulary.
- Metrics become explainable and reproducible.
- Aggregate-to-drilldown analysis becomes composable.
- Source gaps are honest and machine-checkable.
- Report and page values reconcile with Agent answers.
- QGate and Octane no longer distort the domain model.

### Costs

- The current V1 schemas and query contract require a real V2 migration.
- Canonical read models add materialization work and storage.
- Metric ownership and test vectors add governance overhead.
- Full record and traversal support needs stricter field and scope policies.
- Page-specific formulas must be replaced by shared definitions.

These costs are accepted because they are necessary for a trustworthy enterprise data Agent.

## 21. Review decision

Approval of this written specification confirms:

- the five-context scope;
- QGate and Octane terminology;
- the entity and relationship inventory;
- the governed metric definitions;
- the analysis products;
- the controlled query primitives;
- the no-draft/no-fake-missing release gates;
- the mandatory implementation work packages.

After approval, the next artifact is the executable implementation plan, decomposed by the mandatory packages in Section 17 with TDD checkpoints, exact files, test commands, migration order, and review gates.
