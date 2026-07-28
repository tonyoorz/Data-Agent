import { runMainAgentToolTurn } from "./mainAgentToolOrchestrator.mjs";

export async function resolveMainAgentToolContext({
  messages,
  model,
  context,
  requestChatCompletion,
  executeToolCall,
  toolDependencies = {},
  selectedToolset: providedToolset,
  maxSteps = 4,
  now = new Date(),
} = {}) {
  return runMainAgentToolTurn({
    messages,
    model,
    context,
    requestToolCompletion: requestChatCompletion,
    executeToolCall,
    toolDependencies,
    selectedToolset: providedToolset,
    maxSteps,
    now,
  });
}