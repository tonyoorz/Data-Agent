export const TESTCASE_PROPOSAL_POLICY = "testcase.proposal";
export const TESTCASE_COMMIT_POLICY = "testcase.commit";

export class TestCaseAuthorizationError extends Error {
  constructor(code, statusCode = 403) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function values(actor, key) {
  return Array.isArray(actor?.scopes?.[key])
    ? actor.scopes[key].map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

function internalActor(actor) {
  return String(actor?.scopeHash || "").startsWith("internal-");
}

function deny(code = "TESTCASE_ACCESS_DENIED") {
  throw new TestCaseAuthorizationError(code);
}

export function assertTestCaseOperationAuthorized(actor, operation, env = process.env) {
  if (!actor?.scopeHash) deny("TESTCASE_ACTOR_REQUIRED");
  if (internalActor(actor)) return actor;
  const requirement = operation === "commit"
    ? { policy: TESTCASE_COMMIT_POLICY, objectType: "testing.test_case" }
    : operation === "proposal"
      ? { policy: TESTCASE_PROPOSAL_POLICY, objectType: "quality.defect" }
      : null;
  if (!requirement) deny("TESTCASE_OPERATION_INVALID");
  if (!values(actor, "rowPolicyIds").includes(requirement.policy)
    || !values(actor, "allowedObjectTypes").includes(requirement.objectType)) {
    deny();
  }
  if (operation === "commit") {
    const workspaceId = String(env?.VIZION_OCTANE_WORKSPACE_ID || "2001").trim();
    if (!workspaceId || !values(actor, "workspaceIds").includes(workspaceId)) deny();
  }
  return actor;
}

export function assertTestCaseDefectAuthorized(actor, defectInfo = {}) {
  if (internalActor(actor)) return defectInfo;
  const projectIds = values(actor, "projectIds");
  const teamIds = values(actor, "teamIds");
  if (!projectIds.length && !teamIds.length) deny("TESTCASE_DEFECT_SCOPE_REQUIRED");
  const project = String(defectInfo?.project || "").trim();
  const team = String(defectInfo?.problem_finder_team || defectInfo?.problemFinderTeam || "").trim();
  if (projectIds.length && (!project || !projectIds.includes(project))) deny("TESTCASE_DEFECT_SCOPE_DENIED");
  if (teamIds.length && (!team || !teamIds.includes(team))) deny("TESTCASE_DEFECT_SCOPE_DENIED");
  return defectInfo;
}

export function buildTestCaseDefectScope(actor) {
  if (internalActor(actor)) return null;
  return {
    project_ids: values(actor, "projectIds"),
    team_ids: values(actor, "teamIds"),
  };
}

export function toSafeTestCaseAuthorizationError(error) {
  if (!(error instanceof TestCaseAuthorizationError)) return null;
  return { statusCode: error.statusCode, payload: { success: false, error: error.code } };
}
