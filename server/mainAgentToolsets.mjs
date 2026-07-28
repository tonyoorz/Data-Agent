import { MAIN_AGENT_INTENT_PROFILES, isToolAllowed, toolNamesForIntent, toolsForIntent } from "./mainAgentToolRegistry.mjs";

export const MAIN_AGENT_TOOLSET_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(MAIN_AGENT_INTENT_PROFILES).map(([intent, profile]) => [intent, profile.toolNames])),
);

export { isToolAllowed, toolNamesForIntent, toolsForIntent };