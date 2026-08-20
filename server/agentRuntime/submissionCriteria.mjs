/**
 * P1-C5: Submission Criteria Engine (Palantir G7 alignment).
 * Evaluates a governed action's submissionCriteria[] against a submission context.
 * ALL criteria must pass (AND semantics); the failure report names each unmet
 * criterion explicitly so users know exactly what blocks submission.
 *
 * Criterion kinds:
 *   - userGroup      { userGroup: "dtsv_team" }            actor ∈ group
 *   - actorAttribute { attribute: "teamId", value: "DTSV" } actor.attributes[attribute] == value
 *   - timeWindow     { window: "workHours" | calendar ref, timezone? } now inside window
 *   - scenario       { scenario: "sandbox" | "production" } ctx.scenario matches
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/** Shanghai-tz work-hours check (Mon–Fri 08:00–19:00 local). */
function inWorkHours(nowIso, timezoneOffsetHours = 8) {
  const instant = new Date(nowIso);
  if (Number.isNaN(instant.getTime())) return { ok: false, detail: "invalid now" };
  const local = new Date(instant.getTime() + timezoneOffsetHours * 3600 * 1000);
  const day = local.getUTCDay(); // 0=Sun .. 6=Sat
  const hour = local.getUTCHours();
  const ok = day >= 1 && day <= 5 && hour >= 8 && hour < 19;
  return { ok, detail: `local day=${day} hour=${hour}` };
}

/** Named window resolvers; calendar refs land here as they grow. */
function resolveTimeWindow(criterion, ctx) {
  const nowIso = ctx?.now || new Date().toISOString();
  const window = String(criterion.window || "workHours");
  const offset = Number.isFinite(criterion.timezoneOffsetHours) ? criterion.timezoneOffsetHours : 8;
  if (window === "workHours" || window === "business_hours") {
    return inWorkHours(nowIso, offset);
  }
  if (window === "any" || window === "always") return { ok: true, detail: "window=any" };
  // Unknown named window: treat as unmet with an explicit message (fail closed).
  return { ok: false, detail: `unknown time window: ${window}` };
}

const evaluators = {
  userGroup(criterion, ctx) {
    const groups = new Set(toStringArray(ctx?.groups));
    const required = String(criterion.userGroup || "");
    return { ok: groups.has(required), detail: `requires group ${required}, actor has [${[...groups].join(", ")}]` };
  },
  actorAttribute(criterion, ctx) {
    const attribute = String(criterion.attribute || "");
    const expected = criterion.value;
    const attributes = isRecord(ctx?.attributes) ? ctx.attributes : {};
    if (!(attribute in attributes)) return { ok: false, detail: `actor missing attribute ${attribute}` };
    const actual = attributes[attribute];
    const ok = criterion.values
      ? toStringArray(criterion.values).map(String).includes(String(actual))
      : String(actual) === String(expected);
    return { ok, detail: `${attribute}=${String(actual)} vs expected ${criterion.values ? JSON.stringify(criterion.values) : JSON.stringify(expected)}` };
  },
  timeWindow(criterion, ctx) {
    return resolveTimeWindow(criterion, ctx);
  },
  scenario(criterion, ctx) {
    const required = String(criterion.scenario || "");
    const actual = String(ctx?.scenario || "production");
    return { ok: actual === required, detail: `scenario=${actual}, requires ${required}` };
  },
};

/**
 * Evaluate all criteria with AND semantics.
 * @param {Array} criteria  submissionCriteria array from the action ontology
 * @param {object} ctx      { actor, groups, attributes, scenario, now }
 * @returns {{allowed: boolean, unmet: Array<{kind, message}>, evaluated: Array<{kind, ok, detail}>}}
 */
export function evaluateSubmissionCriteria(criteria, ctx = {}) {
  const list = Array.isArray(criteria) ? criteria : [];
  const unmet = [];
  const evaluated = [];
  for (const criterion of list) {
    const kind = String(criterion?.kind || "");
    const evaluator = evaluators[kind];
    if (!evaluator) {
      // Unknown criterion kind: fail closed (governance-first).
      const message = `unknown criterion kind: ${kind}`;
      unmet.push({ kind, message });
      evaluated.push({ kind, ok: false, detail: message });
      continue;
    }
    const { ok, detail } = evaluator(criterion, ctx);
    evaluated.push({ kind, ok, detail });
    if (!ok) unmet.push({ kind, message: `${kind}: ${detail}` });
  }
  return { allowed: unmet.length === 0, unmet, evaluated };
}

/** Map an actor object to the default evaluation ctx (groups/attributes/scenario). */
export function actorToCriteriaContext(actor, { scenario = "production", now } = {}) {
  return {
    actor,
    groups: actor?.groups ?? actor?.scopes?.teamIds ?? [],
    attributes: isRecord(actor?.attributes) ? actor.attributes : {},
    scenario,
    now: now || new Date().toISOString(),
  };
}
