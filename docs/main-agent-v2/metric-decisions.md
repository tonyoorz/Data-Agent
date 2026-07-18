# Metric governance decisions

This file records business-definition decisions that cannot be inferred safely from code or column names. A metric stays `draft` until its owner, grain, numerator/denominator, time field, missing-data policy, and source revision strategy are approved.

| Metric | Initial status | Decision needed |
| --- | --- | --- |
| `defect.count` | approved | Distinct defect primary keys at the selected snapshot and scope. |
| `defect.created_count` | approved | Count by defect creation event time; must not use resolution time. |
| `defect.resolved_count` | draft | Approve the exact outcome/phase/status mapping for “resolved/closed”. |
| `defect.rejected_count` | draft | Approve rejection outcome mapping and reopened-defect treatment. |
| `defect.open_count` | draft | Approve terminal status set and snapshot-time semantics. |
| `defect.resolve_rate` | draft | Approve denominator and cohort/window semantics. |
| `defect.rejection_rate` | draft | Approve denominator, event time, and reopened treatment. |
| `defect.age_days` | draft | Approve clock stop rules, timezone, and unresolved calculation. |
| `defect.long_runner_count` | draft | Approve age threshold and eligible defect states. |
| `defect.repeat_rate` | draft | Approve duplicate linkage source and denominator. |
| `testing.run_count` | approved | Distinct manual run IDs by test finished time. |
| `testing.testcase_count` | approved | Distinct test-case IDs at the selected scope. |
| `testing.pass_rate` | draft | Approve included run statuses, rerun policy, and denominator. |
| `testing.requirement_coverage_rate` | draft | Approve requirement population, trace depth, and waived items. |
| `testing.traceability_rate` | draft | Approve valid relationship types and denominator. |
| `quality.defect_density` | draft | Requires an approved size/exposure denominator; never infer one. |
| `team.execution_count` | approved | Distinct test runs executed by tester/team. |
| `team.defect_discovery_count` | approved | Distinct defects attributed to the approved problem-finder team field. |
| `team.discovery_efficiency` | draft | Approve formula and attribution window. |

Draft metrics must cause a focused clarification or an explicit unsupported response; the planner must not silently substitute another definition.
